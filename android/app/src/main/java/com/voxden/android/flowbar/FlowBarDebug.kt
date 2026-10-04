package com.voxden.android.flowbar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import androidx.core.content.ContextCompat
import com.voxden.android.BuildConfig
import com.voxden.android.core.AppController

/**
 * Debug-build switches for testing the flow bar without speech or a cloud account. Everything here is
 * inert in release builds: [register] does nothing unless `BuildConfig.DEBUG`, and the overrides are
 * only ever set by the receiver it registers.
 *
 * Drive it from adb, for example:
 *   adb shell am broadcast -a com.voxden.android.flowbar.debug.START -p com.voxden.android.debug
 *   adb shell am broadcast -a com.voxden.android.flowbar.debug.FINISH --es text "hello world" -p com.voxden.android.debug
 *   adb shell am broadcast -a com.voxden.android.flowbar.debug.FAKE_POLISH --ez on true --el delay 3000 -p com.voxden.android.debug
 *   adb shell am broadcast -a com.voxden.android.flowbar.debug.FORCE_HANDOFF --ez on true -p com.voxden.android.debug
 *   adb shell am broadcast -a com.voxden.android.flowbar.debug.FORCE_PATH --es path SET_TEXT -p com.voxden.android.debug
 * Other actions: STOP, CANCEL, POLISH, ERROR (--es message "..."), ALWAYS_SHOW (--ez on), SIDE (--es side LEFT|RIGHT), OFFSET (--ef value 0.4), STATE.
 */
internal object FlowBarDebug {
    private const val PREFIX = "com.voxden.android.flowbar.debug."

    /** When set, Polish uses this instead of the cloud, and counts as available. */
    @Volatile var polishOverride: (suspend (String) -> String)? = null
    /** Always take the hand-off activity route to the microphone. */
    @Volatile var forceHandoff = false
    /** Only try this way of typing (null: the normal order). */
    @Volatile var forcePath: TypePath? = null

    fun register(engine: FlowBarEngine, host: Context): BroadcastReceiver? {
        if (!BuildConfig.DEBUG) return null
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val controller = AppController.get(context)
                when (intent.action?.removePrefix(PREFIX)) {
                    "START" -> engine.debugStart()
                    "STOP" -> engine.debugStop()
                    "CANCEL" -> engine.debugCancel()
                    "POLISH" -> engine.debugPolish()
                    "ERROR" -> engine.debugError(intent.getStringExtra("message").orEmpty())
                    "FINISH" -> controller.debugFinishWith(intent.getStringExtra("text").orEmpty())
                    "FAKE_POLISH" -> {
                        val pause = intent.getLongExtra("delay", 0L)
                        polishOverride = if (intent.getBooleanExtra("on", true)) { text -> kotlinx.coroutines.delay(pause); fakePolish(text) } else null
                    }
                    "FORCE_HANDOFF" -> forceHandoff = intent.getBooleanExtra("on", true)
                    "FORCE_PATH" -> forcePath = runCatching { TypePath.valueOf(intent.getStringExtra("path").orEmpty()) }.getOrNull()
                    "ALWAYS_SHOW" -> controller.setFlowBarAlwaysShow(intent.getBooleanExtra("on", true))
                    "SIDE" -> controller.setFlowBarSide(runCatching { com.voxden.android.core.BarSide.valueOf(intent.getStringExtra("side").orEmpty()) }.getOrDefault(com.voxden.android.core.BarSide.RIGHT))
                    "OFFSET" -> controller.setFlowBarOffset(intent.getFloatExtra("value", 0.42f))
                    "STATE" -> Log.i("VoxdenFlowBar", engine.debugState())
                    "TREE" -> engine.debugTree()
                }
            }
        }
        val filter = IntentFilter().apply {
            listOf("START", "STOP", "CANCEL", "POLISH", "ERROR", "FINISH", "FAKE_POLISH", "FORCE_HANDOFF", "FORCE_PATH", "ALWAYS_SHOW", "SIDE", "OFFSET", "STATE", "TREE")
                .forEach { addAction(PREFIX + it) }
        }
        // Only senders holding DUMP may drive it: adb's shell does, ordinary apps on the phone cannot, so no
        // other app can start the microphone or type text through a debug build.
        ContextCompat.registerReceiver(host, receiver, filter, android.Manifest.permission.DUMP, null, ContextCompat.RECEIVER_EXPORTED)
        return receiver
    }

    /** A stand-in for the cloud: capitalise and end with a full stop, enough to see the replace happen. */
    private fun fakePolish(text: String): String {
        val trimmed = text.trim().replaceFirstChar { it.uppercase() }
        return if (trimmed.endsWith('.') || trimmed.endsWith('!') || trimmed.endsWith('?')) trimmed else "$trimmed."
    }

    fun reset() { polishOverride = null; forceHandoff = false; forcePath = null }
}

/** Logs only in debug builds, and never builds the message in release. Messages carry no dictated text. */
internal inline fun debugLog(message: () -> String) {
    if (BuildConfig.DEBUG) Log.d("VoxdenFlowBar", message())
}
