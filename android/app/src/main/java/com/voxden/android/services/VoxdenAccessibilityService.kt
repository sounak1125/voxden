package com.voxden.android.services

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.InputMethod
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.view.accessibility.AccessibilityEvent
import androidx.annotation.RequiresApi
import com.voxden.android.flowbar.FlowBarEngine
import com.voxden.android.flowbar.FlowBarInputMethod
import com.voxden.android.flowbar.InputMethodHandle
import com.voxden.android.flowbar.TextTyper

/**
 * The flow bar: shows the Island pill over other apps while you type, and types dictations at the
 * cursor. The work is in [FlowBarEngine]; this class is the framework's handle on it.
 */
class VoxdenAccessibilityService : AccessibilityService() {
    private var engine: FlowBarEngine? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        current = this
        if (engine == null) engine = FlowBarEngine(this) { inputMethodHandle() }.also { it.start() }
        FlowBarStatus.setConnected(true)
    }

    /** Android 13+: a seat on the keyboard's input connection, to commit text at the cursor. */
    @RequiresApi(33)
    override fun onCreateInputMethod(): InputMethod = FlowBarInputMethod(this) { engine?.onEditorChanged() }

    private fun inputMethodHandle(): TextTyper.FlowBarInputMethodHandle? {
        if (Build.VERSION.SDK_INT < 33) return null
        val method = inputMethod as? FlowBarInputMethod ?: return null
        return InputMethodHandle(method)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { engine?.onEvent(event) }

    override fun onInterrupt() = Unit

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        engine?.onConfigurationChanged()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        shutdown()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun shutdown() {
        engine?.stop()
        engine = null
        if (current === this) current = null
        FlowBarStatus.setConnected(false)
    }

    internal fun flowBarEngine(): FlowBarEngine? = engine

    companion object {
        /** The running service, for device tests and debug tooling in this process. */
        @Volatile internal var current: VoxdenAccessibilityService? = null
    }
}
