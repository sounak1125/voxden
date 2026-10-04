package com.voxden.android.services

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import com.voxden.android.core.AppController
import com.voxden.android.core.DictationSource
import com.voxden.android.flowbar.FlowBarHandoff

/**
 * Invisible, instantly finishing activity for the flow bar, used only when Android does not give the
 * accessibility service the microphone (some phone makers). While this activity is visible Android
 * lets the app start the microphone foreground service, so it does what MainActivity does when you tap
 * Dictate: start the service, then start the dictation on the same main-loop pass (MicrophoneService
 * relies on that), and finish at once so the app the user is typing in comes straight back.
 *
 * It only acts when the flow bar asked for it a moment ago ([FlowBarHandoff.take]); anything else that
 * starts it simply finishes.
 */
class MicHandoffActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Visible, but never the window that has focus or takes touches: the app the user is typing in keeps
        // its window focus, so its text field and its keyboard are still there when this activity is gone.
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE)
        val (asked, target) = FlowBarHandoff.take()
        var started = false
        if (asked) {
            val controller = AppController.get(this)
            try {
                MicrophoneService.start(this)
                started = controller.startRecording(DictationSource.FLOW_BAR, target)
                if (!started) MicrophoneService.stop(this)
            } catch (_: Exception) {
                controller.cancelRecording()
                MicrophoneService.stop(this)
                controller.reportError("Could not start the microphone. Try again.")
            }
            FlowBarHandoff.report(started)
        }
        finish()
        if (Build.VERSION.SDK_INT >= 34) overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        else @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }
}
