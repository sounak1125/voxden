package com.voxden.android.ui

import com.voxden.android.core.Account
import com.voxden.android.core.DictationSource
import com.voxden.android.core.HistoryEntry
import com.voxden.android.core.Trial
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale

class FormattingTest {
    private val zone = ZoneId.of("UTC")
    private val locale = Locale.US
    private fun millis(date: String, hour: Int = 12, minute: Int = 0): Long =
        LocalDate.parse(date).atTime(hour, minute).atZone(zone).toInstant().toEpochMilli()
    private fun entry(id: String, at: Long, text: String = "hello there", source: DictationSource = DictationSource.APP,
        label: String? = null, polished: String? = null) =
        HistoryEntry(id, text, at, "Android speech", source, label?.let { "pkg.$it" }, label, polished, 5)

    // Day grouping
    @Test fun groupsEntriesByCalendarDayNewestFirst() {
        val now = millis("2026-10-04", 14)
        val groups = groupByDay(listOf(
            entry("a", millis("2026-10-04", 9)), entry("b", millis("2026-10-04", 13)),
            entry("c", millis("2026-10-03", 22)), entry("d", millis("2026-09-29", 8))
        ), now, zone, locale)
        assertEquals(listOf("Today", "Yesterday", "Tue 29 Sep"), groups.map { it.label })
        assertEquals(listOf("b", "a"), groups[0].entries.map { it.id })
        assertEquals(listOf("c"), groups[1].entries.map { it.id })
    }

    @Test fun midnightDecidesTodayVersusYesterday() {
        val now = millis("2026-10-04", 0, 5)
        val groups = groupByDay(listOf(entry("late", millis("2026-10-03", 23, 59)), entry("early", millis("2026-10-04", 0, 1))), now, zone, locale)
        assertEquals(listOf("Today", "Yesterday"), groups.map { it.label })
    }

    @Test fun otherYearsShowTheYear() {
        assertEquals("Wed 24 Sep 2025", dayLabel(LocalDate.parse("2025-09-24"), LocalDate.parse("2026-10-04"), locale))
        assertEquals("Thu 24 Sep", dayLabel(LocalDate.parse("2026-09-24"), LocalDate.parse("2026-10-04"), locale))
    }

    @Test fun emptyHistoryHasNoGroups() = assertTrue(groupByDay(emptyList(), millis("2026-10-04"), zone, locale).isEmpty())

    // Summary line
    @Test fun summaryCountsWordsAndDictationsToday() {
        val now = millis("2026-10-04", 14)
        val summary = todaySummary(listOf(
            entry("a", millis("2026-10-04", 9), "one two three"), entry("b", millis("2026-10-04", 10), "four five"),
            entry("c", millis("2026-10-03", 10), "ignored words here")
        ), now, zone, locale)
        assertEquals("Today · 5 words · 2 dictations", summary)
    }

    @Test fun summaryUsesSingularsAndThousandsSeparators() {
        val now = millis("2026-10-04", 14)
        assertEquals("Today · 1 word · 1 dictation", todaySummary(listOf(entry("a", millis("2026-10-04", 9), "hi")), now, zone, locale))
        val long = List(1240) { "w" }.joinToString(" ")
        assertEquals("Today · 1,240 words · 1 dictation", todaySummary(listOf(entry("a", millis("2026-10-04", 9), long)), now, zone, locale))
    }

    @Test fun summaryCountsThePolishedTextWhenThereIsOne() {
        val now = millis("2026-10-04", 14)
        val e = entry("a", millis("2026-10-04", 9), "um hello there world", polished = "Hello world.")
        assertEquals("Today · 2 words · 1 dictation", todaySummary(listOf(e), now, zone, locale))
    }

    @Test fun summaryFallsBackWhenNothingToday() {
        val now = millis("2026-10-04", 14)
        assertEquals("Nothing yet today", todaySummary(listOf(entry("a", millis("2026-10-03", 9))), now, zone, locale))
        assertEquals("", todaySummary(emptyList(), now, zone, locale))
    }

    @Test fun cjkCharactersCountAsWords() {
        assertEquals(5, countWords("今日は晴れ"))
        assertEquals(3, countWords("it's a test"))
        assertEquals(0, countWords("  ..  "))
    }

    // Minutes and the plan chip
    @Test fun minutesShowHoursFromSixtyUp() {
        assertEquals("45 min", formatMinutes(45.0))
        assertEquals("46 min", formatMinutes(45.2))
        assertEquals("1 h", formatMinutes(60.0))
        assertEquals("13 h", formatMinutes(13.9 * 60))
        assertEquals("0 min", formatMinutes(0.0))
        assertEquals("0 min", formatMinutes(Double.NaN))
    }

    @Test fun trialMinutesNeverBecomeHours() {
        assertEquals("60 min", formatTrialMinutes(60.0))
        assertEquals("52 min", formatTrialMinutes(51.4))
    }

    @Test fun planChipTextForEveryAccountState() {
        assertEquals("Free", planChipText(null))
        assertEquals("Free", planChipText(Account("a@b.c", "free")))
        assertEquals("Free", planChipText(Account("a@b.c", "free", trial = Trial(60.0, 60.0, true))))
        assertEquals("Free", planChipText(Account("a@b.c", "free", trial = Trial(0.0, 0.0, false))))
        assertEquals("Trial · 52 min", planChipText(Account("a@b.c", "free", trial = Trial(60.0, 8.0, true))))
        assertEquals("Pro · 13 h left", planChipText(Account("a@b.c", "pro", creditsUsed = 120.0, creditsCap = 900.0)))
        assertEquals("Pro · 45 min left", planChipText(Account("a@b.c", "pro", creditsUsed = 855.0, creditsCap = 900.0)))
        assertEquals("Pro", planChipText(Account("a@b.c", "pro")))
    }

    @Test fun proHeadlineSaysThisMonth() {
        assertEquals("Pro · 13 h left this month", proHeadline(Account("a@b.c", "pro", creditsUsed = 120.0, creditsCap = 900.0)))
    }

    @Test fun accountModeFollowsTheTrialRules() {
        assertEquals(AccountMode.SIGNED_OUT, accountMode(null))
        assertEquals(AccountMode.PRO, accountMode(Account("a", "pro")))
        assertEquals(AccountMode.TRIAL, accountMode(Account("a", "free", trial = Trial(60.0, 8.0, true))))
        assertEquals(AccountMode.TRIAL_USED, accountMode(Account("a", "free", trial = Trial(60.0, 60.0, true))))
        assertEquals(AccountMode.CLOUD_NOT_OFFERED, accountMode(Account("a", "free")))
    }

    @Test fun aSixDigitCodeIsFoundOnTheClipboard() {
        assertEquals("482913", pastedCode("482913"))
        assertEquals("482913", pastedCode("  482913\n"))
        assertEquals("482913", pastedCode("Your Voxden sign-in code is 482913. It expires in 10 minutes."))
        assertEquals("482913", pastedCode("482 913"))
        assertEquals("482913", pastedCode("482-913"))
        assertEquals("000123", pastedCode("000123"))
    }

    @Test fun nothingElseOnTheClipboardIsTakenForACode() {
        assertEquals(null, pastedCode(null))
        assertEquals(null, pastedCode(""))
        assertEquals(null, pastedCode("hello"))
        assertEquals("never the first six digits of a phone number", null, pastedCode("9876543210"))
        assertEquals("five digits", null, pastedCode("48291"))
        assertEquals("seven digits", null, pastedCode("4829131"))
        assertEquals(null, pastedCode("48 29 13 5"))
        assertEquals("Arabic-Indic digits are not what the service accepts", null, pastedCode("٤٨٢٩١٣"))
    }

    @Test fun typedDigitsGoStraightIn() {
        assertEquals("", codeFromInput(""))
        assertEquals("4", codeFromInput("4"))
        assertEquals("48291", codeFromInput("48291"))
        assertEquals("482913", codeFromInput("482913"))
        assertEquals("000123", codeFromInput("000123"))
    }

    @Test fun aSeventhDigitIsDroppedNotShifted() {
        assertEquals("482913", codeFromInput("4829137"))
        assertEquals("123456", codeFromInput("123456789012"))
    }

    @Test fun aWholeCopiedMessageGivesJustTheCode() {
        assertEquals("482913", codeFromInput("Your Voxden sign-in code is 482913. It expires in 10 minutes."))
        assertEquals("482913", codeFromInput("Order 123, code 482913"))
        assertEquals("482913", codeFromInput("482 913"))
        assertEquals("482913", codeFromInput("482-913"))
        assertEquals("482913", codeFromInput("G-482913 is your verification code"))
    }

    @Test fun lettersAndSymbolsAreNeverKept() {
        assertEquals("", codeFromInput("abc"))
        assertEquals("12", codeFromInput("1a2"))
        assertEquals("", codeFromInput("٤٨٢٩١٣"))
        assertEquals("4", codeFromInput("٤٨٢٩١٣4"))
        assertEquals("", codeFromInput("😀"))
    }

    @Test fun whateverIsPutInTheBoxesIsAlwaysAtMostSixPlainDigits() {
        val inputs = listOf("", "1", "12345678901234567890", "Your code 482913", "a1b2c3d4e5f6g7", "٤٨٢٩١٣", "482913482913", " 482913 ", "1\n2\n3", "x".repeat(5000))
        for (input in inputs) {
            val out = codeFromInput(input)
            assertTrue("'$out' from '${input.take(20)}'", out.length <= 6 && out.all { it in '0'..'9' })
        }
    }

    @Test fun theFirstStandaloneCodeWinsWhenThereAreSeveral() {
        assertEquals("111111", pastedCode("Code 111111 or the old one 222222"))
    }

    @Test fun proCanBeBoughtFromEverySignedInFreeState() {
        assertFalse("sign in first", canUpgrade(AccountMode.SIGNED_OUT))
        assertFalse("already Pro", canUpgrade(AccountMode.PRO))
        assertTrue("before or during the trial", canUpgrade(AccountMode.TRIAL))
        assertTrue(canUpgrade(AccountMode.TRIAL_USED))
        assertTrue(canUpgrade(AccountMode.CLOUD_NOT_OFFERED))
    }

    @Test fun theWordsUsedCardOnlyPromisesWhatTheAccountHas() {
        assertEquals("Back on Mon 12 Oct. Voxden Cloud keeps going.", wordsUsedLine("Mon 12 Oct", AccountMode.TRIAL))
        assertEquals("Back on Mon 12 Oct. Try Voxden Cloud free to keep going.", wordsUsedLine("Mon 12 Oct", AccountMode.SIGNED_OUT))
        assertEquals("Back on Mon 12 Oct. Pro keeps dictation going.", wordsUsedLine("Mon 12 Oct", AccountMode.TRIAL_USED))
        assertEquals("Pro keeps dictation going.", wordsUsedLine(null, AccountMode.CLOUD_NOT_OFFERED))
    }

    @Test fun usedFractionIsClamped() {
        assertEquals(0f, usedFraction(5.0, 0.0), 0f)
        assertEquals(0.5f, usedFraction(30.0, 60.0), 0.001f)
        assertEquals(1f, usedFraction(90.0, 60.0), 0f)
    }

    // Search
    @Test fun searchMatchesTextPolishedTextAndAppName() {
        val list = listOf(
            entry("a", 1, "book the dentist", source = DictationSource.FLOW_BAR, label = "WhatsApp"),
            entry("b", 2, "um thanks priya", polished = "Thanks, Priya."),
            entry("c", 3, "ramen near me", source = DictationSource.FLOW_BAR, label = "Chrome")
        )
        assertEquals(listOf("a"), filterEntries(list, "dentist").map { it.id })
        assertEquals(listOf("a"), filterEntries(list, "whatsapp").map { it.id })
        assertEquals(listOf("b"), filterEntries(list, "THANKS, priya").map { it.id })
        assertEquals(listOf("c"), filterEntries(list, "chrome ramen").map { it.id })
        assertTrue(filterEntries(list, "chrome dentist").isEmpty())
    }

    @Test fun blankSearchKeepsEverything() {
        val list = listOf(entry("a", 1), entry("b", 2))
        assertEquals(2, filterEntries(list, "   ").size)
        assertEquals(2, filterEntries(list, "").size)
    }

    // Meta line
    @Test fun destinationNamesTheTarget() {
        assertEquals("in Voxden", destinationText(entry("a", 1)))
        assertEquals("voice keyboard", destinationText(entry("a", 1, source = DictationSource.KEYBOARD)))
        assertEquals("into WhatsApp", destinationText(entry("a", 1, source = DictationSource.FLOW_BAR, label = "WhatsApp")))
        assertEquals("with the flow bar", destinationText(entry("a", 1, source = DictationSource.FLOW_BAR)))
    }

    @Test fun clockTimeFollowsTheHourSetting() {
        val at = millis("2026-10-04", 9, 42)
        assertEquals("9:42 AM", clockTime(at, false, zone, locale))
        assertEquals("09:42", clockTime(at, true, zone, locale))
        assertEquals("Today, 9:42 AM", fullTime(at, false, millis("2026-10-04", 15), zone, locale))
    }

    @Test fun durationIsMinutesAndSeconds() {
        assertEquals("0:07", formatDuration(7))
        assertEquals("1:05", formatDuration(65))
        assertEquals("0:00", formatDuration(-3))
    }

    @Test fun shownTextPrefersThePolishedVersion() {
        assertEquals("Clean.", entry("a", 1, "messy", polished = "Clean.").shownText)
        assertEquals("messy", entry("a", 1, "messy", polished = "  ").shownText)
        assertEquals("messy", entry("a", 1, "messy").shownText)
    }

    // Dictionary and small helpers
    @Test fun dictionaryRejectsBlankAndDuplicateTerms() {
        assertTrue(canAddTerm("Voxden", emptyList()))
        assertFalse(canAddTerm("   ", emptyList()))
        assertFalse(canAddTerm("voxden", listOf("Voxden")))
        assertFalse(canAddTerm("Priya   Raman", listOf("priya raman")))
        assertTrue(canAddTerm("Razorpay", listOf("Voxden")))
    }

    @Test fun shortErrorsFitTheCapsule() {
        assertEquals("Didn't catch that", shortError("No speech was recognized. Try again a little closer to the microphone."))
        assertEquals("No connection", shortError("Cannot reach Voxden Cloud. Check your internet connection."))
        assertEquals("Mic unavailable", shortError("Allow microphone access to start dictation."))
        assertEquals("Couldn't finish", shortError("Something odd."))
    }

    @Test fun licenceTitlesAreReadable() {
        assertEquals("Inter", licenceTitle("OFL-inter.txt"))
        assertEquals("Sora", licenceTitle("OFL-sora.txt"))
        assertEquals("Instrument Serif", licenceTitle("OFL-instrumentserif.txt"))
    }

    @Test fun licenceTextIsReflowedIntoParagraphs() {
        val raw = "Copyright 2020 The Project Authors\n(https://example.org)\n\n-----------\nSIL OPEN FONT LICENSE Version 1.1\n-----------\n\nPREAMBLE\nThe goals of the OFL are to stimulate\nworldwide development.\n\n1) Neither the Font\nSoftware may be sold."
        assertEquals(
            "Copyright 2020 The Project Authors (https://example.org)\n\nSIL OPEN FONT LICENSE Version 1.1\n\nPREAMBLE\nThe goals of the OFL are to stimulate worldwide development.\n\n1) Neither the Font Software may be sold.",
            reflowLicence(raw)
        )
    }

    @Test fun languageNamesFallBackToTheCode() {
        assertEquals("Hindi", languageName("hi-IN"))
        assertEquals("xx-XX", languageName("xx-XX"))
    }
}
