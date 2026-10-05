package com.voxden.android.core

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The free plan's weekly words on the phone's own speech engine. The engine costs Voxden nothing,
 * so the cap is what leaves a reason to buy Voxden Cloud. Pro is never capped.
 *
 * The week starts with the first dictation, not on a calendar day, the same rule as the desktop's
 * src/quota.js. The counter lives on the phone; Android uses its own number, not the desktop's.
 * A dictation that crosses the line still finishes and is counted; the next one is refused.
 */
data class FreeWords(val periodStart: Long = 0L, val used: Int = 0)

object FreeQuota {
    const val WEEKLY_WORDS = 1000
    const val PERIOD_MS = 7L * 24 * 3600 * 1000
    /** Below this many words left, the app says so once. */
    const val WARN_AT = 200

    /** Words, counted the way the desktop counts them: runs of non-space characters. */
    fun countWords(text: String): Int = text.trim().split(Regex("\\s+")).count { it.isNotEmpty() }

    /** Whether the cap applies to this account: everyone but Pro. */
    fun applies(account: Account?): Boolean = account?.isPro != true

    /** The current week, or a fresh one when none has started or the last has run out. */
    fun current(words: FreeWords, now: Long): FreeWords =
        if (words.periodStart <= 0L || now - words.periodStart >= PERIOD_MS || now < words.periodStart) FreeWords() else words

    fun left(words: FreeWords, now: Long): Int = (WEEKLY_WORDS - current(words, now).used).coerceAtLeast(0)

    /** When the words come back: null when no week is running. */
    fun resetsAt(words: FreeWords, now: Long): Long? = current(words, now).periodStart.takeIf { it > 0L }?.plus(PERIOD_MS)

    fun add(words: FreeWords, count: Int, now: Long): FreeWords {
        val week = current(words, now)
        return FreeWords(if (week.periodStart > 0L) week.periodStart else now, week.used + count.coerceAtLeast(0))
    }

    /** "Mon 12 Oct", for the message that says when the words come back. */
    fun dayLabel(millis: Long): String = SimpleDateFormat("EEE d MMM", Locale.getDefault()).format(Date(millis))

    /**
     * The message for a week's words used up. Voxden Cloud keeps going only for an account that still has cloud
     * minutes; one whose trial is over (or that has none) needs Pro, which is [needsPro].
     */
    fun usedUpMessage(words: FreeWords, now: Long, needsPro: Boolean = false): String {
        val back = resetsAt(words, now)?.let { " They come back on ${dayLabel(it)}." }.orEmpty()
        val onward = if (needsPro) "Pro keeps dictation going." else "Voxden Cloud keeps going."
        return "You've used this week's ${"%,d".format(WEEKLY_WORDS)} free words.$back $onward"
    }
}
