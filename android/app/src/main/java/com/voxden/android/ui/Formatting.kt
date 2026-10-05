package com.voxden.android.ui

import com.voxden.android.core.Account
import com.voxden.android.core.DictationSource
import com.voxden.android.core.HistoryEntry
import java.text.NumberFormat
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor

/** Pure display logic for the app, kept free of Android types so it is unit tested on the JVM. */

/** A run of dictations from one calendar day, newest first. */
data class DayGroup(val key: String, val label: String, val entries: List<HistoryEntry>)

/** What the account sheet shows, decided from the account alone. */
enum class AccountMode { SIGNED_OUT, TRIAL, PRO, TRIAL_USED, CLOUD_NOT_OFFERED }

fun accountMode(account: Account?): AccountMode = when {
    account == null -> AccountMode.SIGNED_OUT
    account.isPro -> AccountMode.PRO
    account.trial.active -> AccountMode.TRIAL
    account.trial.available -> AccountMode.TRIAL_USED
    else -> AccountMode.CLOUD_NOT_OFFERED
}

/** Whether Pro can still be bought from this account: signed in, and not Pro already. */
fun canUpgrade(mode: AccountMode): Boolean =
    mode == AccountMode.TRIAL || mode == AccountMode.TRIAL_USED || mode == AccountMode.CLOUD_NOT_OFFERED

/**
 * The second line of the "free words are used" card: when they come back, and what keeps dictation going.
 * Voxden Cloud only does that while there are trial minutes left; once they are gone, or if the account has
 * no trial, it is Pro.
 */
fun wordsUsedLine(backOn: String?, mode: AccountMode): String {
    val back = if (backOn != null) "Back on $backOn. " else ""
    val onward = when (mode) {
        AccountMode.TRIAL_USED, AccountMode.CLOUD_NOT_OFFERED -> "Pro keeps dictation going."
        else -> "Voxden Cloud keeps going."
    }
    return back + onward
}

/** The text a dictation shows and copies: the polished version when there is one. */
val HistoryEntry.shownText: String get() = polished?.takeIf { it.isNotBlank() } ?: text

/** `Mon 29 Sep`, with the year added once it is not the current one. */
fun dayLabel(date: LocalDate, today: LocalDate, locale: Locale = Locale.getDefault()): String = when (date) {
    today -> "Today"
    today.minusDays(1) -> "Yesterday"
    else -> DateTimeFormatter.ofPattern(if (date.year == today.year) "EEE d MMM" else "EEE d MMM yyyy", locale).format(date)
}

fun groupByDay(
    entries: List<HistoryEntry>,
    now: Long,
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault()
): List<DayGroup> {
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    return entries.sortedByDescending { it.createdAt }
        .groupBy { Instant.ofEpochMilli(it.createdAt).atZone(zone).toLocalDate() }
        .map { (date, items) -> DayGroup(date.toString(), dayLabel(date, today, locale), items) }
}

/** Words in a dictation; each Han, kana or Hangul character counts as one so CJK text is not "1 word". */
fun countWords(text: String): Int {
    var words = 0
    var inWord = false
    for (ch in text) {
        val cjk = Character.UnicodeScript.of(ch.code).let {
            it == Character.UnicodeScript.HAN || it == Character.UnicodeScript.HIRAGANA ||
                it == Character.UnicodeScript.KATAKANA || it == Character.UnicodeScript.HANGUL
        }
        when {
            cjk -> { words++; inWord = false }
            ch.isLetterOrDigit() || ch == '\'' || ch == '’' -> { if (!inWord) words++; inWord = true }
            else -> inWord = false
        }
    }
    return words
}

private fun plural(count: Int, one: String, many: String, locale: Locale): String =
    "${NumberFormat.getIntegerInstance(locale).format(count)} ${if (count == 1) one else many}"

/** `Today · 1,240 words · 9 dictations`, or a quiet fallback when today is empty. Empty history gives "". */
fun todaySummary(
    entries: List<HistoryEntry>,
    now: Long,
    zone: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault()
): String {
    if (entries.isEmpty()) return ""
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    val todays = entries.filter { Instant.ofEpochMilli(it.createdAt).atZone(zone).toLocalDate() == today }
    if (todays.isEmpty()) return "Nothing yet today"
    val words = todays.sumOf { countWords(it.shownText) }
    return "Today · ${plural(words, "word", "words", locale)} · ${plural(todays.size, "dictation", "dictations", locale)}"
}

/** `13 h` from 60 minutes up (whole hours), else `45 min`. Never shows "0 min" while time remains. */
fun formatMinutes(minutes: Double): String {
    val m = if (minutes.isFinite()) minutes.coerceAtLeast(0.0) else 0.0
    return if (m >= 60.0) "${floor(m / 60.0).toInt()} h" else "${ceil(m).toInt()} min"
}

/** Trial minutes are always shown as minutes (`52 min`, `60 min`), since the trial is 60 minutes long. */
fun formatTrialMinutes(minutes: Double): String {
    val m = if (minutes.isFinite()) minutes.coerceAtLeast(0.0) else 0.0
    return "${ceil(m).toInt()} min"
}

/** The plan chip in the top bar: `Pro · 13 h left`, `Trial · 52 min`, or `Free`. */
fun planChipText(account: Account?, freeWordsLeft: Int? = null): String = when (accountMode(account)) {
    AccountMode.PRO -> if (account!!.creditsCap > 0.0) "Pro · ${formatMinutes(account.cloudMinutesLeft)} left" else "Pro"
    AccountMode.TRIAL -> "Trial · ${formatTrialMinutes(account!!.trial.left)}"
    else -> if (freeWordsLeft != null) "Free · ${"%,d".format(freeWordsLeft)} words" else "Free"
}

/** The sheet's headline for a signed-in Pro account: `Pro · 13 h left this month`. */
fun proHeadline(account: Account): String =
    if (account.creditsCap > 0.0) "Pro · ${formatMinutes(account.cloudMinutesLeft)} left this month" else "Pro"

/** Fraction of a meter that is used up, for the thin progress lines. */
fun usedFraction(used: Double, cap: Double): Float =
    if (cap <= 0.0 || !cap.isFinite()) 0f else (used / cap).toFloat().coerceIn(0f, 1f)

/** Search across the dictation, its polished version and the app it went into. Every word must match. */
fun filterEntries(entries: List<HistoryEntry>, query: String): List<HistoryEntry> {
    val words = query.trim().lowercase(Locale.ROOT).split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return entries
    return entries.filter { entry ->
        val haystack = buildString {
            append(entry.text); append(' ')
            entry.polished?.let { append(it); append(' ') }
            entry.appLabel?.let { append(it) }
        }.lowercase(Locale.ROOT)
        words.all { haystack.contains(it) }
    }
}

/** The clock time of a dictation: `9:42 AM`, or `09:42` on a 24-hour phone. */
fun clockTime(millis: Long, is24Hour: Boolean, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
    DateTimeFormatter.ofPattern(if (is24Hour) "HH:mm" else "h:mm a", locale).format(Instant.ofEpochMilli(millis).atZone(zone))
        // Newer Unicode data puts a narrow no-break space before AM/PM; a plain space wraps and aligns like the rest of the meta line.
        .replace(0x202F.toChar(), ' ')

/** `Mon 29 Sep, 9:42 AM` for the detail sheet. */
fun fullTime(millis: Long, is24Hour: Boolean, now: Long = System.currentTimeMillis(),
    zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
    val date = Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()
    val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    return "${dayLabel(date, today, locale)}, ${clockTime(millis, is24Hour, zone, locale)}"
}

/** Where a dictation went: `into WhatsApp`, `in Voxden` or `voice keyboard`. */
fun destinationText(entry: HistoryEntry): String = when (entry.source) {
    DictationSource.APP -> "in Voxden"
    DictationSource.KEYBOARD -> "voice keyboard"
    DictationSource.FLOW_BAR -> entry.appLabel?.takeIf { it.isNotBlank() }?.let { "into $it" } ?: "with the flow bar"
}

/** `0:12`, `1:05`. */
fun formatDuration(seconds: Int): String {
    val s = seconds.coerceAtLeast(0)
    return "${s / 60}:${(s % 60).toString().padStart(2, '0')}"
}

/** A capsule-sized version of an error message; the full text still goes to the toast. */
fun shortError(message: String): String {
    val m = message.lowercase(Locale.ROOT)
    return when {
        "free words" in m -> "Free words used up"
        "no speech" in m || "no audio" in m -> "Didn't catch that"
        "network" in m || "connection" in m || "reach voxden" in m -> "No connection"
        "microphone" in m || "allow" in m -> "Mic unavailable"
        "busy" in m -> "Engine busy"
        "language" in m -> "Language unavailable"
        "timed out" in m || "too long" in m || "did not return" in m -> "Took too long"
        else -> "Couldn't finish"
    }
}

/** A dictionary term can be added when it is not blank and not already there (ignoring case and spacing). */
fun canAddTerm(term: String, existing: List<String>): Boolean {
    val clean = term.trim().replace(Regex("\\s+"), " ")
    return clean.isNotEmpty() && existing.none { it.equals(clean, ignoreCase = true) }
}

/** Friendly names for the files in assets/licenses. */
fun licenceTitle(fileName: String): String {
    val base = fileName.removePrefix("OFL-").substringBeforeLast('.')
    return when (base.lowercase(Locale.ROOT)) {
        "inter" -> "Inter"
        "sora" -> "Sora"
        "instrumentserif" -> "Instrument Serif"
        else -> base.replaceFirstChar { it.uppercase() }
    }
}

/** The Android speech-recognition languages Voxden offers. */
val Languages = listOf(
    "en-US" to "English (US)", "en-GB" to "English (UK)", "en-IN" to "English (India)", "hi-IN" to "Hindi",
    "es-ES" to "Spanish", "fr-FR" to "French", "de-DE" to "German", "pt-BR" to "Portuguese",
    "ja-JP" to "Japanese", "ko-KR" to "Korean", "zh-CN" to "Chinese", "ar-SA" to "Arabic"
)

fun languageName(code: String): String = Languages.firstOrNull { it.first == code }?.second ?: code

/**
 * The licence files are hard-wrapped at about 70 columns, which reads as ragged lines on a phone. Joins each paragraph
 * back into flowing text, keeps blank lines between paragraphs and ALL-CAPS headings on their own line, and drops the dashed rules.
 */
fun reflowLicence(raw: String): String {
    val out = StringBuilder()
    for (paragraph in raw.trim().split(Regex("(\r?\n)[ \t]*(\r?\n)+"))) {
        val lines = paragraph.lines().map { it.trim() }.filter { it.isNotEmpty() }
        if (lines.isEmpty()) continue
        val buffer = StringBuilder()
        fun flush() {
            if (buffer.isNotEmpty()) { out.append(buffer).append('\n'); buffer.setLength(0) }
        }
        for (line in lines) {
            val rule = line.all { it == '-' || it == '=' }
            val heading = line.length < 48 && line.any { it.isLetter() } && line == line.uppercase(Locale.ROOT)
            when {
                rule -> flush()
                heading -> { flush(); out.append(line).append('\n') }
                else -> { if (buffer.isNotEmpty()) buffer.append(' '); buffer.append(line) }
            }
        }
        flush()
        out.append('\n')
    }
    return out.toString().trim()
}
