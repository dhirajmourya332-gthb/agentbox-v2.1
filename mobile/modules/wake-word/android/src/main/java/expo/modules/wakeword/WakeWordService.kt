package expo.modules.wakeword

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.io.File

/**
 * Hands-free listening. A foreground service (type microphone, with its own notification) reads
 * the microphone in 100 ms chunks and runs sherpa-onnx's keyword spotter on the phone. Nothing is
 * recorded or sent: the audio only ever goes through the spotter and is dropped.
 *
 * On a match it beeps, lets go of the microphone (so speech recognition can use it) and tells the
 * app (WakeWordBus). The app asks it to listen again with resume() once the conversation is over.
 */
class WakeWordService : Service() {
  companion object {
    private const val TAG = "WakeWord"
    const val ACTION_START = "expo.modules.wakeword.START"
    const val ACTION_STOP = "expo.modules.wakeword.STOP"
    const val ACTION_PAUSE = "expo.modules.wakeword.PAUSE"
    const val ACTION_RESUME = "expo.modules.wakeword.RESUME"
    private const val CHANNEL = "agentbox-assistant"
    private const val NOTIFICATION_ID = 7341
    private const val RATE = 16000
    private val MODEL_FILES = listOf("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")

    @Volatile var running = false
      private set
  }

  private var worker: Thread? = null
  @Volatile private var listening = false
  @Volatile private var stopping = false
  private var wakeLock: PowerManager.WakeLock? = null
  private var spotter: KeywordSpotter? = null
  private var keywords = ""
  private var threshold = 0.25f
  private var title = "Assistant"
  private var text = "Listening for its name"

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START -> {
        keywords = intent.getStringExtra("keywords") ?: ""
        threshold = intent.getFloatExtra("threshold", 0.25f)
        title = intent.getStringExtra("title") ?: title
        text = intent.getStringExtra("text") ?: text
        if (!goForeground()) return START_NOT_STICKY
        running = true
        stopping = false
        acquireWakeLock()
        startListening(reload = true)
      }
      ACTION_PAUSE -> pauseListening()
      ACTION_RESUME -> if (running) startListening(reload = false)
      ACTION_STOP -> {
        WakeWordBus.state("stopped", "Turned off")
        shutdown()
      }
      // Restarted by the system after being killed: the app's settings and keys are gone with the
      // process, so don't come back on our own (and Android forbids starting the mic from here).
      else -> { shutdown(); return START_NOT_STICKY }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    stopping = true
    listening = false
    worker?.join(1500)
    worker = null
    spotter?.release()
    spotter = null
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun shutdown() {
    running = false
    stopping = true
    listening = false
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun goForeground(): Boolean {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
      val ch = NotificationChannel(CHANNEL, "Voice assistant", NotificationManager.IMPORTANCE_LOW)
      ch.description = "Shown while the assistant listens for its name"
      ch.setShowBadge(false)
      nm.createNotificationChannel(ch)
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, flags) }
    val stop = PendingIntent.getService(this, 1, Intent(this, WakeWordService::class.java).setAction(ACTION_STOP), flags)
    val builder = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this))
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(title)
      .setContentText(text)
      .setOngoing(true)
      .setShowWhen(false)
      .addAction(Notification.Action.Builder(null, "Stop listening", stop).build())
    if (open != null) builder.setContentIntent(open)
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        startForeground(NOTIFICATION_ID, builder.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, builder.build())
      }
      true
    } catch (e: Exception) {
      // Android 14+: a microphone service can only start while the app is on screen.
      Log.w(TAG, "startForeground failed", e)
      WakeWordBus.state("error", "Android didn't let the assistant listen. Open agentbox and turn hands-free on again.")
      stopSelf()
      false
    }
  }

  @SuppressLint("WakelockTimeout")
  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "agentbox:assistant").apply { setReferenceCounted(false); acquire() }
  }

  private fun pauseListening() {
    listening = false
    worker?.join(1500)
    worker = null
    if (running) WakeWordBus.state("paused", null)
  }

  /** Copies the model out of the APK once, and again after each app update. */
  private fun modelDir(): File {
    val dir = File(filesDir, "kws")
    dir.mkdirs()
    val stamp = File(dir, ".installed")
    @Suppress("DEPRECATION")
    val installed = packageManager.getPackageInfo(packageName, 0).lastUpdateTime.toString()
    if (stamp.exists() && stamp.readText() == installed && MODEL_FILES.all { File(dir, it).exists() }) return dir
    for (name in MODEL_FILES) {
      assets.open("kws/$name").use { input -> File(dir, name).outputStream().use { input.copyTo(it) } }
    }
    stamp.writeText(installed)
    return dir
  }

  private fun loadSpotter(): KeywordSpotter {
    val dir = modelDir()
    // Only the owner's name: written to a file so the spotter has no other (default) keywords.
    val kw = File(dir, "keywords.txt")
    kw.writeText(keywords.split('/').map { it.trim() }.filter { it.isNotEmpty() }.joinToString("\n") + "\n")
    val config = KeywordSpotterConfig(
      featConfig = FeatureConfig(sampleRate = RATE, featureDim = 80),
      modelConfig = OnlineModelConfig(
        transducer = OnlineTransducerModelConfig(
          encoder = File(dir, "encoder.int8.onnx").absolutePath,
          decoder = File(dir, "decoder.int8.onnx").absolutePath,
          joiner = File(dir, "joiner.int8.onnx").absolutePath,
        ),
        tokens = File(dir, "tokens.txt").absolutePath,
        modelType = "zipformer2",
        numThreads = 1,
      ),
      keywordsFile = kw.absolutePath,
      keywordsThreshold = threshold,
      keywordsScore = 1.5f,
    )
    return KeywordSpotter(null, config)
  }

  @SuppressLint("MissingPermission")
  private fun startListening(reload: Boolean) {
    if (listening) {
      if (!reload) return
      pauseListening()
    }
    listening = true
    val t = Thread({
      var rec: AudioRecord? = null
      try {
        if (reload || spotter == null) {
          spotter?.release()
          spotter = loadSpotter()
        }
        val kws = spotter!!
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val mic = AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE / 5 * 2))
        rec = mic
        if (mic.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("The microphone isn't available")
        mic.startRecording()
        WakeWordBus.state("listening", null)
        val stream = kws.createStream("")
        val buf = ShortArray(RATE / 10)
        val samples = FloatArray(buf.size)
        try {
          while (listening && !stopping) {
            val n = mic.read(buf, 0, buf.size)
            if (n <= 0) continue
            for (i in 0 until n) samples[i] = buf[i] / 32768.0f
            stream.acceptWaveform(if (n == buf.size) samples else samples.copyOf(n), RATE)
            while (kws.isReady(stream)) kws.decode(stream)
            val hit = kws.getResult(stream).keyword
            if (hit.isNotBlank()) {
              kws.reset(stream)
              listening = false
              rec = null
              mic.stop()
              mic.release()
              beep()
              WakeWordBus.wake(hit)
              WakeWordBus.state("paused", null)
              break
            }
          }
        } finally {
          stream.release()
        }
      } catch (e: Throwable) {
        Log.w(TAG, "listening failed", e)
        listening = false
        WakeWordBus.state("error", e.message ?: "Listening stopped")
      } finally {
        try { rec?.stop() } catch (_: Throwable) {}
        rec?.release()
      }
    }, "agentbox-wake-word")
    worker = t
    t.start()
  }

  private fun beep() {
    try {
      val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 70)
      tone.startTone(ToneGenerator.TONE_PROP_ACK, 180)
      Thread.sleep(220)
      tone.release()
    } catch (_: Throwable) {}
  }
}
