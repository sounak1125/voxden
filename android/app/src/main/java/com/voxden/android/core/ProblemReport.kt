package com.voxden.android.core

import java.time.Instant

/**
 * The text a user copies and sends when Voxden closed by itself: the version, the phone model, the last crash (its
 * stack trace), the last error the app recovered from, and why Android says the app last stopped. It never reads a
 * dictation, an account, the clipboard or any audio. A stack trace can carry the message of the error, and a phone's
 * own error message can occasionally echo text it was given, so every line is cut short ([tidy]) and the report is
 * plain text the user sees when they paste it.
 */
object ProblemReport {
    /** One time Android stopped the app, as it reports it (Android 11 and newer keep a short list). */
    data class Exit(val at: Long, val reason: String, val detail: String)

    const val TRACE_LIMIT = 6_000
    const val LINE_LIMIT = 200

    /** A trace with every line cut to [LINE_LIMIT] characters and the whole at most [TRACE_LIMIT]. */
    fun tidy(trace: String): String = trace.lines().joinToString("\n") { it.take(LINE_LIMIT) }.take(TRACE_LIMIT)

    fun build(version: String, device: String, android: String, now: Long, crash: String?, handled: String?, exits: List<Exit>): String =
        buildString {
            appendLine("Voxden problem report")
            appendLine("Version: $version")
            appendLine("Phone: $device, $android")
            appendLine("Made: ${stamp(now)}")
            appendLine()
            appendLine("Last crash:")
            appendLine(crash?.trim()?.let { tidy(it) }?.takeIf { it.isNotEmpty() } ?: "None recorded.")
            appendLine()
            appendLine("Last error the app recovered from:")
            appendLine(handled?.trim()?.let { tidy(it) }?.takeIf { it.isNotEmpty() } ?: "None recorded.")
            appendLine()
            appendLine("Recent times Android stopped the app (newest first):")
            if (exits.isEmpty()) appendLine("Not available on this Android version.")
            else exits.forEach { appendLine("${stamp(it.at)}  ${it.reason}${if (it.detail.isNotBlank()) "  (${it.detail.take(120)})" else ""}") }
        }.trimEnd()

    /** A moment as `2026-10-05T06:12:11Z`, the same on every phone. */
    fun stamp(millis: Long): String = Instant.ofEpochMilli(millis).toString().substringBefore('.').let { if (it.endsWith("Z")) it else it + "Z" }
}
