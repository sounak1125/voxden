package com.voxden.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** When styling a dictation leaves nothing to deliver, so the app says no speech was heard instead of typing a stray stop. */
class LeavesNothingTest {
    private val tones = WritingTone.values().toList()

    @Test fun blankIsNothing() {
        assertTrue(DictationStyle.leavesNothing("", ""))
        assertTrue(DictationStyle.leavesNothing("  ", ""))
        assertTrue(DictationStyle.leavesNothing("um", ""))
    }

    @Test fun aFillerLeftOnlyItsStopIsNothing() {
        for (tone in tones) {
            for (spoken in listOf("um", "Um.", "uh?", "Hm.", "uh, hmm", "Hmm...", "Um,")) {
                val styled = WritingStyle.apply(spoken, tone)
                assertTrue("$spoken in $tone gave '$styled'", DictationStyle.leavesNothing(spoken, styled))
            }
        }
    }

    @Test fun realSpeechIsNotNothing() {
        for (tone in tones) {
            for (spoken in listOf("hello", "Um, hello.", "uh can you send it", "ok", "5", "yes. no.")) {
                val styled = WritingStyle.apply(spoken, tone)
                assertFalse("$spoken in $tone gave '$styled'", DictationStyle.leavesNothing(spoken, styled))
            }
        }
    }

    @Test fun textThatWasNeverWordsIsPassedOnAsItCame() {
        // Only punctuation or an emoji to begin with: the style did not empty it, so it is not "no speech".
        for (tone in tones) {
            for (spoken in listOf("...", "?", "😀")) {
                val styled = WritingStyle.apply(spoken, tone)
                assertFalse("$spoken in $tone gave '$styled'", DictationStyle.leavesNothing(spoken, styled))
            }
        }
    }

    @Test fun withTheStyleOffItIsExactlyIsItBlank() {
        // The controller passes the spoken text through untouched when the style is off.
        assertTrue(DictationStyle.leavesNothing("", ""))
        assertFalse(DictationStyle.leavesNothing("hello", "hello"))
        assertFalse(DictationStyle.leavesNothing("?", "?"))
        assertFalse(DictationStyle.leavesNothing(".", "."))
    }
}

/** What the app does with a dictation: the style off changes nothing; on, the tone follows the app being typed into. */
class DictationStyleTest {
    private val on = WritingStyleSettings(enabled = true)

    private fun style(text: String, settings: WritingStyleSettings, app: String?, language: String = "en-US", dictionary: List<String> = emptyList()) =
        DictationStyle.forDictation(text, settings, app, language, dictionary)

    @Test fun withTheStyleOffTheTextIsReturnedUntouched() {
        val spoken = "um, meet me at nine"
        assertSame(spoken, style(spoken, WritingStyleSettings(), "com.whatsapp"))
        assertSame(spoken, style(spoken, WritingStyleSettings(), "com.google.android.gm"))
        assertSame(spoken, style(spoken, WritingStyleSettings(), null, "hi-IN"))
    }

    @Test fun theToneFollowsTheAppBeingTypedInto() {
        assertEquals("meet me at nine", style("meet me at nine", on, "com.whatsapp"))
        assertEquals("Meet me at nine", style("meet me at nine", on, "com.Slack"))
        assertEquals("Meet me at nine.", style("meet me at nine", on, "com.google.android.gm"))
        assertEquals("Meet me at nine", style("meet me at nine", on, "com.android.chrome"))
    }

    @Test fun anUnknownAppIsOtherAsAreTheKeyboardAndTheDictateBar() {
        assertEquals("Meet me at nine", style("meet me at nine", on, null))
        assertEquals("Meet me at nine", style("meet me at nine", on, ""))
        assertEquals("Meet me at nine", style("meet me at nine", on, "com.example.unknown"))
    }

    @Test fun eachContextUsesItsOwnChosenTone() {
        val custom = on.withTone(WritingContext.PERSONAL, WritingTone.FORMAL).withTone(WritingContext.OTHER, WritingTone.VERY_CASUAL)
        assertEquals("Meet me at nine.", style("meet me at nine", custom, "com.whatsapp"))
        assertEquals("meet me at nine", style("meet me at nine", custom, null))
        assertEquals("Meet me at nine", style("meet me at nine", custom, "com.slack"))
    }

    @Test fun aNonEnglishLanguageOnlyTidiesTheSpaces() {
        val spoken = "  नमस्ते   दोस्त  "
        for (tone in WritingTone.values()) {
            assertEquals("नमस्ते दोस्त", style(spoken, on.withTone(WritingContext.OTHER, tone), null, "hi-IN"))
        }
    }

    @Test fun theDictionaryIsPassedThrough() {
        val text = "Hello there"
        val tone = WritingTone.VERY_CASUAL
        val withTerm = style(text, on.withTone(WritingContext.OTHER, tone), null, dictionary = listOf("Hello"))
        assertEquals(WritingStyle.apply(text, tone, "en-US", listOf("Hello")), withTerm)
        assertEquals(WritingStyle.apply(text, tone, "en-US", emptyList()), style(text, on.withTone(WritingContext.OTHER, tone), null))
        assertTrue("a protected word keeps its capital", withTerm.startsWith("Hello"))
    }

    @Test fun whatTheControllerDeliversMatchesTheRulesForTheChosenTone() {
        for (tone in WritingTone.values()) {
            val text = "um, so I am sending the notes tonight, you know, once we are done. thanks for waiting"
            assertEquals(WritingStyle.apply(text, tone), style(text, on.withTone(WritingContext.EMAIL, tone), "com.google.android.gm"))
        }
    }

    @Test fun theLanguageCheckIsTheDesktopsAndDoesNotNeedTheRules() {
        for (language in listOf("en", "en-US", "en-GB", "en-IN", "EN-us")) assertTrue(language, DictationStyle.appliesTo(language))
        for (language in listOf("", "e", "hi-IN", "ja-JP", "fr-FR", "eng", "en_US", "es-ES", "ar-SA")) assertFalse(language, DictationStyle.appliesTo(language))
        assertEquals(DictationStyle.appliesTo("en-US"), WritingStyle.appliesTo("en-US"))
    }
}
