package com.voxden.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FreeQuotaTest {
    private val day = 24L * 3600 * 1000
    private val t0 = 1_790_000_000_000L

    @Test fun countsWordsLikeTheDesktop() {
        assertEquals(0, FreeQuota.countWords("   "))
        assertEquals(5, FreeQuota.countWords(" Running ten  minutes\nlate, ok "))
    }

    @Test fun theWeekStartsAtTheFirstDictation() {
        assertNull(FreeQuota.resetsAt(FreeWords(), t0))
        val words = FreeQuota.add(FreeWords(), 120, t0)
        assertEquals(t0, words.periodStart)
        assertEquals(880, FreeQuota.left(words, t0 + day))
        assertEquals(t0 + 7 * day, FreeQuota.resetsAt(words, t0 + day))
    }

    @Test fun wordsComeBackAfterSevenDays() {
        val words = FreeQuota.add(FreeWords(), 1000, t0)
        assertEquals(0, FreeQuota.left(words, t0 + 6 * day))
        assertEquals(FreeQuota.WEEKLY_WORDS, FreeQuota.left(words, t0 + 7 * day))
        val next = FreeQuota.add(words, 10, t0 + 8 * day)
        assertEquals(t0 + 8 * day, next.periodStart)
        assertEquals(10, next.used)
    }

    @Test fun aDictationThatCrossesTheLineIsCountedInFull() {
        val words = FreeQuota.add(FreeQuota.add(FreeWords(), 990, t0), 40, t0)
        assertEquals(1030, words.used)
        assertEquals(0, FreeQuota.left(words, t0))
    }

    @Test fun aClockSetBackStartsAFreshWeek() {
        val words = FreeQuota.add(FreeWords(), 500, t0)
        assertEquals(FreeQuota.WEEKLY_WORDS, FreeQuota.left(words, t0 - day))
    }

    @Test fun proIsNeverCapped() {
        assertFalse(FreeQuota.applies(Account("a@b.c", "pro")))
        assertTrue(FreeQuota.applies(Account("a@b.c", "free")))
        assertTrue(FreeQuota.applies(null))
    }

    @Test fun theMessageNamesTheCapAndTheDay() {
        val words = FreeQuota.add(FreeWords(), 1000, t0)
        val message = FreeQuota.usedUpMessage(words, t0)
        assertTrue(message.contains("1,000 free words") || message.contains("1.000 free words") || message.contains("1 000 free words"))
        assertTrue(message.contains("come back on"))
    }
}
