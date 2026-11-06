package expo.modules.wakeword

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JavaScript side of hands-free listening (modules/wake-word/index.ts). start() must be called
 * while the app is on screen: Android only lets a microphone service start then.
 */
class WakeWordModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("NO_CONTEXT", "The app isn't ready", null)

  private fun send(action: String, extras: (Intent) -> Unit = {}) {
    val intent = Intent(context, WakeWordService::class.java).setAction(action)
    extras(intent)
    if (action == WakeWordService.ACTION_START && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(intent)
    } else if (action == WakeWordService.ACTION_START || WakeWordService.running) {
      context.startService(intent)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("WakeWord")
    Events("onWake", "onState")

    OnCreate {
      WakeWordBus.listener = object : WakeWordBus.Listener {
        override fun onWake(keyword: String) {
          try { sendEvent("onWake", mapOf("keyword" to keyword)) } catch (e: Exception) { Log.w("WakeWord", "onWake not delivered", e) }
        }
        override fun onState(state: String, message: String?) {
          try { sendEvent("onState", mapOf("state" to state, "message" to message)) } catch (e: Exception) { Log.w("WakeWord", "onState not delivered", e) }
        }
      }
    }
    OnDestroy {
      WakeWordBus.listener = null
    }

    /** The bundled native libraries are 64-bit ARM only (nearly every phone since 2017). */
    Function("isSupported") { Build.SUPPORTED_ABIS.contains("arm64-v8a") }
    Function("isRunning") { WakeWordService.running }
    Function("state") { if (WakeWordService.running) WakeWordBus.lastState else "stopped" }

    AsyncFunction("start") { keywords: String, threshold: Double, title: String, text: String ->
      if (!Build.SUPPORTED_ABIS.contains("arm64-v8a")) throw CodedException("UNSUPPORTED", "Hands-free needs a 64-bit ARM phone", null)
      if (keywords.isBlank()) throw CodedException("NO_KEYWORD", "Pick a name first", null)
      send(WakeWordService.ACTION_START) {
        it.putExtra("keywords", keywords)
        it.putExtra("threshold", threshold.toFloat().coerceIn(0.05f, 0.6f))
        it.putExtra("title", title)
        it.putExtra("text", text)
      }
    }
    Function("pause") { send(WakeWordService.ACTION_PAUSE) }
    Function("resume") { send(WakeWordService.ACTION_RESUME) }
    Function("stop") { send(WakeWordService.ACTION_STOP) }
  }
}
