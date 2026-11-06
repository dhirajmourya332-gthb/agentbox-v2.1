package expo.modules.wakeword

/**
 * Service → module. The module registers while the app's JavaScript is alive; events from the
 * service go to it. The last state is kept so a module that attaches later can ask for it.
 */
object WakeWordBus {
  interface Listener {
    fun onWake(keyword: String)
    fun onState(state: String, message: String?)
  }

  @Volatile var listener: Listener? = null
  @Volatile var lastState: String = "stopped"
    private set

  fun wake(keyword: String) {
    listener?.onWake(keyword)
  }

  fun state(state: String, message: String?) {
    lastState = state
    listener?.onState(state, message)
  }
}
