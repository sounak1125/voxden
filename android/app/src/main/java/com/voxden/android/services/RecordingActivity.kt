package com.voxden.android.services

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import com.voxden.android.core.AppController
import com.voxden.android.core.DictationSource
import com.voxden.android.core.RecordingPhase
import com.voxden.android.core.SensitiveClip
import com.voxden.android.core.SpeechProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch

/** The voice keyboard's recording screen: a visible activity is the permission and recording boundary for the backup keyboard. */
class RecordingActivity : ComponentActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val controller by lazy { AppController.get(this) }
    private lateinit var status: TextView
    private lateinit var transcript: TextView
    private lateinit var record: Button
    private lateinit var use: Button
    private var sessionToken: String? = null
    private var hasRecorded = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        onBackPressedDispatcher.addCallback(this) { cancelAndClose() }
        sessionToken = intent.getStringExtra(EXTRA_SESSION)
        VoiceInputSession.enterRecordingScreen(sessionToken)
        hasRecorded = savedInstanceState?.getBoolean("recorded") ?: false
        val body = NativeStyle.column(this, card = true)
        body.addView(NativeStyle.header(this, size = 20f))
        body.addView(NativeStyle.label(this, "Speak. It's written.", 15f))
        body.addView(NativeStyle.label(this, if (controller.state.value.provider == SpeechProvider.CLOUD)
            "Voxden Cloud · audio is sent for transcription"
        else "Android speech · your speech provider may use its network", 13f))
        status = NativeStyle.label(this, "Ready when you are", 15f)
        body.addView(status)
        transcript = NativeStyle.label(this, "Your words will appear here.", 18f, true).apply {
            minHeight = NativeStyle.dp(this@RecordingActivity, 100)
        }
        body.addView(transcript)
        record = NativeStyle.button(this, "Start recording", true) {
            when (controller.state.value.phase) {
                RecordingPhase.RECORDING -> controller.stopRecording()
                RecordingPhase.PROCESSING -> Unit
                RecordingPhase.IDLE -> requestRecording()
            }
        }
        body.addView(record)
        use = NativeStyle.button(this, if (sessionToken == null) "Copy text" else "Use in keyboard") {
            val text = controller.state.value.transcript
            if (text.isNotBlank() && hasRecorded) {
                val token = sessionToken
                if (token != null) {
                    if (VoiceInputSession.complete(token, text)) finish()
                    else Toast.makeText(this, "Keyboard session ended. Copy your text instead.", Toast.LENGTH_LONG).show()
                } else {
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(SensitiveClip.of(text))
                    Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
                }
            }
        }
        body.addView(use)
        if (sessionToken != null) {
            body.addView(NativeStyle.button(this, "Copy text instead") {
                if (hasRecorded && controller.state.value.phase == RecordingPhase.IDLE && controller.state.value.transcript.isNotBlank()) {
                    getSystemService(ClipboardManager::class.java).setPrimaryClip(SensitiveClip.of(controller.state.value.transcript))
                    Toast.makeText(this, "Copied", Toast.LENGTH_SHORT).show()
                }
            })
        }
        body.addView(NativeStyle.button(this, "Close") { cancelAndClose() })
        setContentView(ScrollView(this).apply { addView(body) })
        window.setLayout(minOf(resources.displayMetrics.widthPixels - NativeStyle.dp(this, 32), NativeStyle.dp(this, 420)), WindowManager.LayoutParams.WRAP_CONTENT)
        window.setGravity(Gravity.CENTER)
        setFinishOnTouchOutside(false)
        scope.launch {
            controller.state.collect { state ->
                val recording = state.phase == RecordingPhase.RECORDING
                val processing = state.phase == RecordingPhase.PROCESSING
                record.text = when { recording -> "Stop recording · ${state.elapsedSeconds}s"; processing -> "Transcribing…"; else -> "Start recording" }
                record.isEnabled = !processing
                use.isEnabled = hasRecorded && state.transcript.isNotBlank() && !recording && !processing
                status.text = state.error ?: state.notice ?: when { recording -> "Listening • microphone on"; processing -> "Turning speech into text"; else -> "Tap to record. Close cancels active recording." }
                transcript.text = state.partialTranscript.ifBlank { if (hasRecorded) state.transcript.ifBlank { "Your words will appear here." } else "Your words will appear here." }
                if (recording) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }
    private fun requestRecording() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 31)
            return
        }
        hasRecorded = true
        controller.clearTranscript()
        try {
            MicrophoneService.start(this)
            // Not APP: the main screen copies every APP dictation to the clipboard, and this one is for the keyboard.
            controller.startRecording(DictationSource.KEYBOARD)
            if (controller.state.value.phase == RecordingPhase.IDLE) MicrophoneService.stop(this)
        } catch (error: Exception) {
            controller.cancelRecording()
            MicrophoneService.stop(this)
            controller.reportError("Could not start the microphone. Reopen Voxden and try again.")
        }
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == RESUME) return
        setIntent(intent)
        val newToken = intent.getStringExtra(EXTRA_SESSION)
        if (newToken != sessionToken) {
            if (controller.state.value.phase != RecordingPhase.IDLE) controller.cancelRecording()
            MicrophoneService.stop(this)
            VoiceInputSession.leaveRecordingScreen(sessionToken)
            sessionToken = newToken
            VoiceInputSession.enterRecordingScreen(newToken)
            hasRecorded = false
            transcript.text = "Your words will appear here."
            use.text = if (newToken == null) "Copy text" else "Use in keyboard"
            use.isEnabled = false
        }
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 31) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) requestRecording()
            else status.text = "Microphone permission is needed to dictate. Enable it in Android app settings."
        }
    }
    private fun cancelAndClose() {
        if (controller.state.value.phase != RecordingPhase.IDLE) controller.cancelRecording()
        MicrophoneService.stop(this)
        finish()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("recorded", hasRecorded)
        super.onSaveInstanceState(outState)
    }
    override fun onStop() {
        if (!isChangingConfigurations && controller.state.value.phase == RecordingPhase.RECORDING) {
            controller.cancelRecording()
            MicrophoneService.stop(this)
        }
        super.onStop()
    }
    override fun onDestroy() {
        if (!isChangingConfigurations) VoiceInputSession.leaveRecordingScreen(sessionToken)
        scope.cancel()
        super.onDestroy()
    }
    companion object {
        internal const val RESUME = "com.voxden.android.RESUME_RECORDING"
        private const val EXTRA_SESSION = "voice_input_session"
        fun launch(context: Context, sessionToken: String? = null) {
            VoiceInputSession.enterRecordingScreen(sessionToken)
            try {
                context.startActivity(Intent(context, RecordingActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    if (sessionToken != null) putExtra(EXTRA_SESSION, sessionToken)
                })
            } catch (error: Exception) {
                VoiceInputSession.leaveRecordingScreen(sessionToken)
                throw error
            }
        }
    }
}
