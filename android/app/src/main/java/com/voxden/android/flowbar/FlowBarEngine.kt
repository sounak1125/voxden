package com.voxden.android.flowbar

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import androidx.core.content.ContextCompat
import com.voxden.android.core.AppController
import com.voxden.android.core.CrashLog
import com.voxden.android.core.FlowBarSettings
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The flow bar, as far as the accessibility service is concerned: it watches which field has focus,
 * decides when the resting pill is on screen, and hands taps and pulls to [DictationFlow]. The
 * service only forwards events and owns the lifecycle; everything else lives here so it can be
 * built and torn down as one piece.
 */
internal class FlowBarEngine(
    private val service: AccessibilityService,
    private val inputMethod: () -> TextTyper.FlowBarInputMethodHandle?
) : FlowBarWindowEvents {
    private val main = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, error ->
        if (error !is Exception) throw error
        CrashLog.handled(error, "flow bar")
    })
    private val controller = AppController.get(service)
    private val ui = FlowBarUi()
    private val windows = FlowBarWindows(service, ui, this)
    private val probe = FieldProbe(service)
    private val typer = TextTyper(service, probe, inputMethod)
    private val flow = DictationFlow(service, scope, controller, ui, windows, probe, typer, { lastSnapshot.imeBounds?.top }) { refresh() }
    private val keyguard = service.getSystemService(KeyguardManager::class.java)
    private val power = service.getSystemService(PowerManager::class.java)

    @Volatile private var lastSnapshot = FieldSnapshot()
    private var lastBar: FlowBarSettings? = null
    private var screenReceiver: BroadcastReceiver? = null
    private var debugReceiver: BroadcastReceiver? = null
    private var displayListener: DisplayManager.DisplayListener? = null
    private var stopped = false
    private val refreshRunnable = Runnable { refresh() }

    fun start() {
        scope.launch {
            controller.state.collect { state ->
                // One bad update must not end the collection: the flow bar would stop following the app.
                try {
                    flow.onState(state)
                    if (state.flowBar != lastBar) { lastBar = state.flowBar; refresh() }
                } catch (error: Exception) { CrashLog.handled(error, "flow bar state") }
            }
        }
        scope.launch { controller.results.collect { try { flow.onResult(it) } catch (error: Exception) { CrashLog.handled(error, "flow bar result") } } }
        screenReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) { refresh() }
        }.also {
            ContextCompat.registerReceiver(service, it, IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_USER_PRESENT)
            }, ContextCompat.RECEIVER_NOT_EXPORTED)
        }
        displayListener = object : DisplayManager.DisplayListener {
            override fun onDisplayAdded(displayId: Int) = Unit
            override fun onDisplayRemoved(displayId: Int) = Unit
            override fun onDisplayChanged(displayId: Int) { refresh() }
        }.also { service.getSystemService(DisplayManager::class.java)?.registerDisplayListener(it, main) }
        debugReceiver = FlowBarDebug.register(this, service)
        refresh()
        main.postDelayed({ if (!stopped) try { windows.warmUp() } catch (error: Exception) { CrashLog.handled(error, "flow bar warm-up") } }, 400)
    }

    fun stop() {
        stopped = true
        main.removeCallbacks(refreshRunnable)
        flow.abort()
        flow.release()
        scope.cancel()
        screenReceiver?.let { runCatching { service.unregisterReceiver(it) } }
        debugReceiver?.let { runCatching { service.unregisterReceiver(it) } }
        displayListener?.let { service.getSystemService(DisplayManager::class.java)?.unregisterDisplayListener(it) }
        windows.removeAll()
        FlowBarDebug.reset()
    }

    /** Accessibility events only say "something changed"; look again shortly, once for a burst. */
    fun onEvent(event: AccessibilityEvent?) {
        if (stopped || event == null) return
        main.removeCallbacks(refreshRunnable)
        main.postDelayed(refreshRunnable, 40)
    }

    fun onConfigurationChanged() { if (!stopped) refresh() }

    /** The keyboard started or finished typing into an editor (Android 13+): look again, as for an event. */
    fun onEditorChanged() {
        if (stopped) return
        main.removeCallbacks(refreshRunnable)
        main.postDelayed(refreshRunnable, 40)
    }

    /**
     * Looks at the screen and puts the windows where they belong. It runs on every change on screen (a menu opening,
     * a sheet, the keyboard), in the same process as the app, so a failure here must never close the app: it is
     * recorded for the problem report and the next change looks again.
     */
    fun refresh() {
        if (stopped) return
        try { refreshNow() } catch (error: Exception) { CrashLog.handled(error, "flow bar refresh") }
    }

    private fun refreshNow() {
        main.removeCallbacks(refreshRunnable)
        val probed = try { probe.snapshot() } catch (error: Exception) { Log.w(TAG, "Probe failed", error); FieldSnapshot() }
        val editor = try { inputMethod()?.editorInfo } catch (_: Exception) { null }
        val snapshot = withEditor(probed, editor?.inputType, editor?.packageName)
        lastSnapshot = snapshot
        val bar = controller.state.value.flowBar
        val locked = keyguard?.isKeyguardLocked == true
        val interactive = power?.isInteractive != false
        // Android does not always say when the lock screen goes away (it can be dismissed without a
        // broadcast we receive), so while it is up and the screen is on, look again shortly.
        if (locked && interactive) main.postDelayed(refreshRunnable, 800)
        if (flow.isActive) {
            if (locked || !interactive) flow.abort() else windows.relayout(snapshot.imeBounds?.top, bar.side, bar.offset)
            return
        }
        if (shouldShowPill(bar.alwaysShow, locked, interactive, snapshot)) windows.showPill(bar.side, bar.offset, snapshot.imeBounds?.top)
        else windows.hidePill()
    }

    // ---- Window events ---------------------------------------------------------------------

    override fun pillTapped() = flow.start()
    override fun pillPulledOut() = flow.start()
    override fun pillMoved(offset: Float) = controller.setFlowBarOffset(offset)
    override fun hapticsEnabled(): Boolean = controller.state.value.flowBar.haptics

    // ---- Debug and test hooks --------------------------------------------------------------

    fun debugStart() = flow.start()
    fun debugStop() = flow.stop()
    fun debugCancel() = flow.cancel()
    fun debugPolish() = flow.polish()
    fun debugError(message: String) = flow.debugError(message)
    fun debugState(): String {
        fun describe(node: android.view.accessibility.AccessibilityNodeInfo?): String = if (node == null) "none" else
            "${node.className}#${node.viewIdResourceName} editable=${node.isEditable} focused=${node.isFocused} window=${node.windowId}"
        val cached = probe.focusedInput()
        val before = describe(cached)
        val refreshed = cached?.let { it.refresh(); describe(it) } ?: "none"
        cached.release()
        if (android.os.Build.VERSION.SDK_INT >= 33) service.clearCache()
        val afterClear = probe.focusedInput().let { val d = describe(it); it.release(); d }
        return "phase=${flow.phase} pill=${windows.isPillAttached} capsule=${windows.isCapsuleAttached} bar=${controller.state.value.flowBar} snapshot=$lastSnapshot focus[cached=$before refreshed=$refreshed afterClear=$afterClear]"
    }

    /** Debug: logs what a screen reader sees in the flow bar's own windows. */
    fun debugTree() {
        val windows = try { service.windows } catch (_: Exception) { emptyList() }
        for (window in windows) {
            if (window.type != android.view.accessibility.AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) continue
            val root = window.root ?: continue
            fun walk(node: android.view.accessibility.AccessibilityNodeInfo, depth: Int) {
                Log.i(TAG, "tree ${"  ".repeat(depth)}${node.className} desc=${node.contentDescription} text=${node.text} clickable=${node.isClickable} actions=${node.actionList.map { it.label ?: it.id }}")
                for (i in 0 until node.childCount) node.getChild(i)?.let { walk(it, depth + 1) }
            }
            walk(root, 0)
        }
    }

    /** What the probe sees right now. */
    fun probeNow(): FieldSnapshot = probe.snapshot().also { lastSnapshot = it }

    /** Types [text] into the focused field exactly as a finished dictation would. For device tests. */
    fun typeNow(text: String, expectedPackage: String? = null, only: TypePath? = null): TypeOutcome = typer.type(text, expectedPackage, only)

    /** The text of the focused field as the accessibility tree reports it (a hint counts as empty). For device tests. */
    fun focusedTextNow(): String? {
        val node = probe.focusedInput() ?: return null
        try { return if (node.isShowingHintText) "" else node.text?.toString().orEmpty() } finally { node.release() }
    }

    fun editorSurfaceNow(): EditorSurface? = typer.currentSurface()
    fun phaseNow(): FlowPhase = flow.phase
    fun pillAttachedNow(): Boolean = windows.isPillAttached
    fun capsuleAttachedNow(): Boolean = windows.isCapsuleAttached

    companion object { private const val TAG = "VoxdenFlowBar" }
}
