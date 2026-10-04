package com.voxden.android.flowbar

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import com.voxden.android.core.TargetApp
import com.voxden.android.services.MicHandoffActivity

/**
 * May this process record audio right now, or would Android silence it as a background app?
 * An enabled accessibility service is bound as a foreground service, so on stock Android the answer is
 * yes while the service runs (see flowbar-notes/SPIKE.md). The app-op says so directly: MODE_ALLOWED
 * when the microphone is open to us, MODE_IGNORED when a capture would come back as silence.
 */
internal object MicAccess {
    fun canRecordNow(context: Context): Boolean {
        val ops = context.getSystemService(AppOpsManager::class.java) ?: return true
        return try {
            @Suppress("DEPRECATION")
            val mode = if (Build.VERSION.SDK_INT >= 29) {
                ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_RECORD_AUDIO, Process.myUid(), context.packageName)
            } else {
                ops.checkOpNoThrow(AppOpsManager.OPSTR_RECORD_AUDIO, Process.myUid(), context.packageName)
            }
            mode == AppOpsManager.MODE_ALLOWED
        } catch (_: Exception) { true }
    }
}

/**
 * The safety net for devices where the accessibility service is not granted the microphone: a visible,
 * instantly finishing activity ([MicHandoffActivity]) starts the microphone foreground service and the
 * dictation while it is on screen, which Android always allows. The flow bar then carries on as usual,
 * watching the controller's state.
 */
internal object FlowBarHandoff {
    @Volatile private var pendingTarget: TargetApp? = null
    @Volatile private var armed = false
    @Volatile var onFinished: ((started: Boolean) -> Unit)? = null

    fun launch(context: Context, target: TargetApp?) {
        pendingTarget = target
        armed = true
        context.startActivity(
            Intent(context, MicHandoffActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
        )
    }

    /** Called by the activity: whether it was asked by the flow bar, and for which app. */
    fun take(): Pair<Boolean, TargetApp?> {
        val result = armed to pendingTarget
        armed = false; pendingTarget = null
        return result
    }

    fun report(started: Boolean) { onFinished?.invoke(started) }
}
