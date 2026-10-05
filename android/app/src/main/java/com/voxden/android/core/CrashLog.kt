package com.voxden.android.core

import android.app.ActivityManager
import android.app.Application
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.annotation.RequiresApi
import com.voxden.android.BuildConfig
import java.io.File

/**
 * Remembers why Voxden closed, on the phone, so "it just closed" can be answered instead of guessed at.
 *
 * Two small files in the app's private storage: the last crash (written by a handler that still lets Android
 * finish the crash as usual) and the last error the app recovered from. Nothing is sent anywhere. Settings >
 * About > Copy problem report puts them, with the phone model and the reasons Android gives for stopping the app,
 * on the clipboard for the user to send.
 */
object CrashLog {
    private const val CRASH_FILE = "last-crash.txt"
    private const val HANDLED_FILE = "last-recovered.txt"
    private const val TAG = "VoxdenCrashLog"

    @Volatile private var app: Context? = null
    @Volatile private var lastHandled: String? = null

    fun install(application: Application) {
        app = application.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            // Never let the recorder itself get in the way of the crash being reported to Android.
            try { write(CRASH_FILE, entry(thread.name, error)) } catch (_: Throwable) { }
            previous?.uncaughtException(thread, error)
        }
    }

    /** An error the app caught and carried on from. Kept (the newest only) so a quiet failure can still be found. */
    fun handled(error: Throwable, where: String) {
        val key = "$where ${error.javaClass.name} ${error.stackTrace.firstOrNull()}"
        if (key == lastHandled) return   // the same failure again (a refresh runs on every screen change): once is enough
        lastHandled = key
        Log.w(TAG, "Recovered in $where", error)
        try { write(HANDLED_FILE, entry(where, error)) } catch (_: Exception) { }
    }

    /** The report for the user to copy. Reads two small files and asks Android for its exit list. */
    fun report(context: Context): String {
        val dir = context.applicationContext.filesDir
        return ProblemReport.build(
            version = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
            device = "${Build.MANUFACTURER} ${Build.MODEL}", android = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            now = System.currentTimeMillis(), crash = read(File(dir, CRASH_FILE)), handled = read(File(dir, HANDLED_FILE)),
            exits = if (Build.VERSION.SDK_INT >= 30) exits(context) else emptyList()
        )
    }

    private fun entry(where: String, error: Throwable): String =
        "${ProblemReport.stamp(System.currentTimeMillis())}, in $where\n${ProblemReport.tidy(Log.getStackTraceString(error))}"

    private fun write(name: String, text: String) {
        val context = app ?: return
        File(context.filesDir, name).writeText(text)
    }

    private fun read(file: File): String? = try { if (file.isFile) file.readText() else null } catch (_: Exception) { null }

    @RequiresApi(30)
    private fun exits(context: Context): List<ProblemReport.Exit> = try {
        context.getSystemService(ActivityManager::class.java)?.getHistoricalProcessExitReasons(null, 0, 6).orEmpty().map {
            ProblemReport.Exit(it.timestamp, reasonName(it.reason), it.description.orEmpty())
        }
    } catch (_: Exception) {
        emptyList()
    }

    @RequiresApi(30)
    private fun reasonName(reason: Int): String = when (reason) {
        ApplicationExitInfo.REASON_CRASH -> "CRASH"
        ApplicationExitInfo.REASON_CRASH_NATIVE -> "NATIVE CRASH"
        ApplicationExitInfo.REASON_ANR -> "NOT RESPONDING (ANR)"
        ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW MEMORY (Android cleared it)"
        ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE RESOURCE USE"
        ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "FAILED TO START"
        ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "A SERVICE IT NEEDS DIED"
        ApplicationExitInfo.REASON_SIGNALED -> "KILLED BY A SIGNAL (often a phone maker's battery saver)"
        ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "A PERMISSION CHANGED"
        ApplicationExitInfo.REASON_USER_REQUESTED -> "closed by the user"
        ApplicationExitInfo.REASON_USER_STOPPED -> "the phone user's profile was stopped"
        ApplicationExitInfo.REASON_EXIT_SELF -> "exited by itself"
        ApplicationExitInfo.REASON_OTHER -> "other"
        else -> "reason $reason"
    }
}
