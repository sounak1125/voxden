package com.voxden.android.flowbar

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import com.voxden.android.MainActivity
import com.voxden.android.R
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState
import com.voxden.android.core.DictationResult
import com.voxden.android.core.DictationSource
import com.voxden.android.core.RecordingPhase
import com.voxden.android.core.TargetApp
import com.voxden.android.ui.island.IslandMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

internal enum class FlowPhase { REST, ARMING, RECORDING, TRANSCRIBING, DONE, POLISHING, ERROR }

/**
 * One dictation from the flow bar, start to finish: arming the microphone, the capsule's states,
 * typing the result, Polish, and the way back to rest. It reads the controller's state and results and
 * writes [FlowBarUi]; windows and typing are done by the classes it is given.
 */
internal class DictationFlow(
    private val service: AccessibilityService,
    private val scope: CoroutineScope,
    private val controller: AppController,
    private val ui: FlowBarUi,
    private val windows: FlowBarWindows,
    private val probe: FieldProbe,
    private val typer: TextTyper,
    private val imeTop: () -> Int?,
    private val onRest: () -> Unit
) {
    private class Session(val target: TargetApp?) {
        val startedAt: Long = SystemClock.elapsedRealtime()
        /** The hand-off activity is the one retry for a device that refuses the service the microphone. */
        var handoffTried = false
        var original: String = ""
        var entryId: String? = null
        var outcome: TypeOutcome? = null
    }

    var phase: FlowPhase = FlowPhase.REST
        private set(value) {
            if (field != value) debugLog { "flow $field -> $value" }
            field = value
        }
    val isActive: Boolean get() = phase != FlowPhase.REST

    private var session: Session? = null
    private var timer: Job? = null
    private var abandon: Job? = null
    private var polishJob: Job? = null

    init {
        ui.onCancel = { cancel() }
        ui.onStop = { stop() }
        ui.onAction = { polish() }
        ui.onTap = { if (phase == FlowPhase.DONE || phase == FlowPhase.ERROR) toRest() }
        FlowBarHandoff.onFinished = { started -> if (!started) handoffFailed() }
    }

    private fun string(id: Int) = service.getString(id)
    private val canPolish: Boolean get() = FlowBarDebug.polishOverride != null || controller.canPolish

    // ---- Starting --------------------------------------------------------------------------

    /** The pill was tapped or pulled out. */
    fun start() {
        if (phase != FlowPhase.REST) return
        if (controller.state.value.phase != RecordingPhase.IDLE) { windows.haptic(Haptic.REJECT); return }
        val target = probe.targetApp()
        session = Session(target)
        if (!hasMicrophonePermission()) {
            openApp()
            showError(ErrorKind.MICROPHONE, null)
            return
        }
        if (FlowBarDebug.forceHandoff || !MicAccess.canRecordNow(service)) { startViaHandoff(target); return }
        if (!controller.startRecording(DictationSource.FLOW_BAR, target)) { startFailed(); return }
        enterRecording()
    }

    private fun hasMicrophonePermission() = service.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /**
     * A microphone refusal from a service that had the permission when it started is Android silencing
     * a background app, which some makers do to accessibility services: try the hand-off activity once.
     */
    private fun shouldRetryViaHandoff(kind: ErrorKind, current: Session): Boolean =
        kind == ErrorKind.MICROPHONE && hasMicrophonePermission() && !current.handoffTried &&
            SystemClock.elapsedRealtime() - current.startedAt < RETRY_WINDOW_MILLIS

    private fun startViaHandoff(target: TargetApp?) {
        session?.handoffTried = true
        phase = FlowPhase.ARMING
        showCapsule(IslandMode.RECORDING, null, null)
        try { FlowBarHandoff.launch(service, target) } catch (_: Exception) { handoffFailed(); return }
        timer?.cancel()
        timer = scope.launch {
            delay(5000)
            if (phase == FlowPhase.ARMING) showError(ErrorKind.MICROPHONE, null)
        }
    }

    private fun handoffFailed() {
        if (phase != FlowPhase.ARMING && phase != FlowPhase.REST) return
        val message = controller.state.value.error
        if (needsMicrophonePermission(message) && !hasMicrophonePermission()) openApp()
        showError(classifyError(message).let { if (it == ErrorKind.OTHER) ErrorKind.MICROPHONE else it }, message)
    }

    private fun startFailed() {
        val message = controller.state.value.error
        val kind = classifyError(message)
        val current = session
        if (current != null && shouldRetryViaHandoff(kind, current)) { startViaHandoff(current.target); return }
        if (needsMicrophonePermission(message) && !hasMicrophonePermission()) openApp()
        showError(kind, message)
    }

    private fun openApp() {
        try {
            service.startActivity(Intent(service, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        } catch (error: Exception) { Log.w(TAG, "Could not open Voxden", error) }
    }

    private fun enterRecording() {
        timer?.cancel()
        phase = FlowPhase.RECORDING
        showCapsule(IslandMode.RECORDING, null, null)
        windows.haptic(Haptic.CONFIRM)
    }

    // ---- Controller events -----------------------------------------------------------------

    fun onState(state: AppState) {
        if (state.recordingSource == DictationSource.FLOW_BAR || phase == FlowPhase.RECORDING || phase == FlowPhase.TRANSCRIBING) ui.level = state.audioLevel
        when {
            state.recordingSource == DictationSource.FLOW_BAR && state.phase == RecordingPhase.RECORDING -> {
                // Started by the hand-off activity (or by something else on our behalf): adopt it.
                if (phase == FlowPhase.REST || phase == FlowPhase.ARMING) {
                    if (session == null) session = Session(probe.targetApp())
                    enterRecording()
                }
            }
            state.recordingSource == DictationSource.FLOW_BAR && state.phase == RecordingPhase.PROCESSING -> {
                if (phase == FlowPhase.RECORDING) { phase = FlowPhase.TRANSCRIBING; showCapsule(IslandMode.PROCESSING, null, null) }
            }
            state.phase == RecordingPhase.IDLE && (phase == FlowPhase.RECORDING || phase == FlowPhase.TRANSCRIBING) -> {
                // Either a result is about to arrive (it follows within the same call) or the dictation was cancelled elsewhere.
                abandon?.cancel()
                abandon = scope.launch {
                    delay(700)
                    if ((phase == FlowPhase.RECORDING || phase == FlowPhase.TRANSCRIBING) && controller.state.value.phase == RecordingPhase.IDLE) toRest()
                }
            }
        }
    }

    fun onResult(result: DictationResult) {
        debugLog { "result source=${result.source} error=${result.error} textLength=${result.text.length} phase=$phase" }
        if (result.source != DictationSource.FLOW_BAR) return
        abandon?.cancel(); timer?.cancel()
        if (session == null) session = Session(result.target)
        val current = session!!
        if (result.error != null || result.text.isBlank()) {
            val kind = classifyError(result.error)
            if (shouldRetryViaHandoff(kind, current)) { startViaHandoff(current.target); return }
            if (needsMicrophonePermission(result.error) && !hasMicrophonePermission()) openApp()
            showError(kind, result.error)
            return
        }
        val outcome = typer.type(result.text, current.target?.packageName, FlowBarDebug.forcePath)
        current.original = result.text; current.entryId = result.entryId; current.outcome = outcome
        phase = FlowPhase.DONE
        showCapsule(IslandMode.DONE, string(if (outcome.typed) R.string.flow_bar_label_inserted else R.string.flow_bar_label_copied),
            if (canPolish) string(R.string.flow_bar_action_polish) else null)
        windows.haptic(Haptic.CONFIRM)
        restAfter(FlowBarMetrics.DONE_MILLIS)
    }

    // ---- Buttons ---------------------------------------------------------------------------

    fun stop() {
        if (phase != FlowPhase.RECORDING) return
        phase = FlowPhase.TRANSCRIBING
        showCapsule(IslandMode.PROCESSING, null, null)
        windows.haptic(Haptic.CONFIRM)
        controller.stopRecording()
    }

    fun cancel() {
        if (phase == FlowPhase.REST) return
        if (controller.state.value.phase != RecordingPhase.IDLE && controller.state.value.recordingSource == DictationSource.FLOW_BAR) controller.cancelRecording()
        toRest()
    }

    /** Stops whatever is happening and puts every window away (screen locked, service stopping). */
    fun abort() {
        if (controller.state.value.recordingSource == DictationSource.FLOW_BAR && controller.state.value.phase != RecordingPhase.IDLE) controller.cancelRecording()
        polishJob?.cancel()
        toRest()
    }

    fun polish() {
        val current = session ?: return
        if (phase != FlowPhase.DONE || current.original.isBlank()) return
        timer?.cancel()
        phase = FlowPhase.POLISHING
        showCapsule(IslandMode.PROCESSING, string(R.string.flow_bar_label_polishing), null)
        polishJob?.cancel()
        polishJob = scope.launch {
            try {
                val outcome = polishInPlace(current.original, current.outcome?.inserted, { current.outcome?.surface?.invoke() }) { text ->
                    FlowBarDebug.polishOverride?.invoke(text) ?: controller.polish(text)
                }
                when (outcome) {
                    is PolishOutcome.Replaced -> {
                        current.outcome = TypeOutcome(current.outcome?.path ?: TypePath.CLIPBOARD, outcome.inserted, current.outcome?.surface ?: { null })
                        finishPolish(outcome.polished, current, R.string.flow_bar_label_polished)
                    }
                    is PolishOutcome.Moved -> {
                        typer.copy(outcome.polished)
                        finishPolish(outcome.polished, current, R.string.flow_bar_label_polished_copied)
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (phase == FlowPhase.POLISHING) showError(classifyError(error.message), error.message)
            }
        }
    }

    private fun finishPolish(polished: String, current: Session, label: Int) {
        current.entryId?.let { controller.setPolished(it, polished) }
        phase = FlowPhase.DONE
        showCapsule(IslandMode.DONE, string(label), null)
        windows.haptic(Haptic.CONFIRM)
        restAfter(FlowBarMetrics.DONE_MILLIS)
    }

    // ---- Capsule helpers -------------------------------------------------------------------

    private fun showCapsule(mode: IslandMode, label: String?, action: String?) {
        ui.mode = mode; ui.label = label; ui.actionLabel = action
        windows.hidePill()
        if (windows.isCapsuleAttached) windows.setCapsuleMode(mode) else windows.showCapsule(mode, imeTop())
    }

    private fun showError(kind: ErrorKind, message: String?) {
        timer?.cancel(); abandon?.cancel()
        phase = FlowPhase.ERROR
        val label = when (kind) {
            ErrorKind.NO_SPEECH -> string(R.string.flow_bar_error_no_speech)
            ErrorKind.MICROPHONE -> string(R.string.flow_bar_error_microphone)
            ErrorKind.NETWORK -> string(R.string.flow_bar_error_network)
            ErrorKind.BUSY -> string(R.string.flow_bar_error_busy)
            ErrorKind.LANGUAGE -> string(R.string.flow_bar_error_language)
            ErrorKind.TIMEOUT -> string(R.string.flow_bar_error_timeout)
            ErrorKind.SIGN_IN -> string(R.string.flow_bar_error_sign_in)
            ErrorKind.CLOUD_NEEDED -> string(R.string.flow_bar_error_cloud)
            ErrorKind.WORDS_USED -> string(R.string.flow_bar_error_words)
            ErrorKind.OTHER -> firstSentence(message).ifBlank { string(R.string.flow_bar_error_generic) }
        }
        showCapsule(IslandMode.ERROR, label, null)
        windows.haptic(Haptic.REJECT)
        restAfter(FlowBarMetrics.ERROR_MILLIS)
    }

    private fun restAfter(millis: Long) {
        timer?.cancel()
        timer = scope.launch { delay(millis); toRest() }
    }

    private fun toRest() {
        timer?.cancel(); abandon?.cancel()
        if (phase == FlowPhase.POLISHING) polishJob?.cancel()
        phase = FlowPhase.REST
        session = null
        windows.hideCapsule()
        ui.level = 0f
        onRest()
    }

    /** Debug: shows the capsule's error state for [message] as if a dictation had failed with it. */
    fun debugError(message: String) {
        if (phase == FlowPhase.REST) session = Session(probe.targetApp())
        showError(classifyError(message), message)
    }

    fun release() {
        timer?.cancel(); abandon?.cancel(); polishJob?.cancel()
        FlowBarHandoff.onFinished = null
    }

    companion object {
        private const val TAG = "VoxdenFlowBar"
        private const val RETRY_WINDOW_MILLIS = 5_000L
    }
}
