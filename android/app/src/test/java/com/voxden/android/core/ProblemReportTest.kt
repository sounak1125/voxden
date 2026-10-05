package com.voxden.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The report a user copies when Voxden closed by itself: facts about the app and phone, and nothing about what they said. */
class ProblemReportTest {
    private val now = 1_791_180_731_000L // 2026-10-05T06:12:11Z

    private fun report(crash: String? = null, handled: String? = null, exits: List<ProblemReport.Exit> = emptyList()) =
        ProblemReport.build("1.0 (3)", "samsung SM-S911B", "Android 14 (API 34)", now, crash, handled, exits)

    @Test fun momentsAreWrittenTheSameWayOnEveryPhone() {
        assertEquals("2026-10-05T06:12:11Z", ProblemReport.stamp(now))
        assertEquals("2026-10-05T06:12:11Z", ProblemReport.stamp(now + 999))
        assertEquals("1970-01-01T00:00:00Z", ProblemReport.stamp(0))
    }

    @Test fun theHeaderNamesTheVersionAndThePhone() {
        val text = report()
        assertTrue(text.startsWith("Voxden problem report\n"))
        assertTrue(text.contains("Version: 1.0 (3)"))
        assertTrue(text.contains("Phone: samsung SM-S911B, Android 14 (API 34)"))
        assertTrue(text.contains("Made: 2026-10-05T06:12:11Z"))
    }

    @Test fun withNothingRecordedItSaysSo() {
        val text = report()
        assertTrue(text.contains("Last crash:\nNone recorded."))
        assertTrue(text.contains("Last error the app recovered from:\nNone recorded."))
        assertTrue(text.contains("Not available on this Android version."))
        assertFalse(text.endsWith("\n"))
    }

    @Test fun aCrashAndAnErrorTheAppRecoveredFromAreIncluded() {
        val text = report(crash = "2026-10-05T06:10:00Z, in main\njava.lang.IllegalStateException: boom\n\tat a.B.c(B.kt:1)\n", handled = "flow bar refresh\njava.lang.NullPointerException")
        assertTrue(text.contains("Last crash:\n2026-10-05T06:10:00Z, in main\njava.lang.IllegalStateException: boom"))
        assertTrue(text.contains("Last error the app recovered from:\nflow bar refresh\njava.lang.NullPointerException"))
        assertFalse(text.contains("None recorded."))
    }

    @Test fun aBlankRecordCountsAsNone() {
        assertTrue(report(crash = "  \n ", handled = "").contains("Last crash:\nNone recorded."))
    }

    @Test fun aHugeTraceIsCutSoTheReportStaysShareable() {
        val text = report(crash = "x".repeat(50_000))
        assertTrue(text.length < ProblemReport.TRACE_LIMIT + 600)
    }

    @Test fun androidsExitsAreListedNewestFirstAsGiven() {
        val text = report(exits = listOf(
            ProblemReport.Exit(now, "CRASH", "crash"),
            ProblemReport.Exit(now - 3_600_000L, "LOW MEMORY (Android cleared it)", ""),
            ProblemReport.Exit(now - 7_200_000L, "closed by the user", "user request after error")
        ))
        val lines = text.lines().dropWhile { !it.startsWith("Recent times Android stopped") }.drop(1)
        assertEquals("2026-10-05T06:12:11Z  CRASH  (crash)", lines[0])
        assertEquals("2026-10-05T05:12:11Z  LOW MEMORY (Android cleared it)", lines[1])
        assertEquals("2026-10-05T04:12:11Z  closed by the user  (user request after error)", lines[2])
        assertFalse(text.contains("Not available"))
    }

    @Test fun aLongExitDescriptionIsCut() {
        val text = report(exits = listOf(ProblemReport.Exit(now, "other", "d".repeat(400))))
        assertTrue(text.lines().last().length < 200)
    }
}
