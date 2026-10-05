package com.voxden.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** When styling a dictation leaves nothing to deliver, so the app says no speech was heard instead of typing a stray stop. */
class LeavesNothingTest {
    private val tones = WritingTone.values().toList()

    @Test fun blankIsNothing() {
        assertTrue(WritingStyle.leavesNothing("", ""))
        assertTrue(WritingStyle.leavesNothing("  ", ""))
        assertTrue(WritingStyle.leavesNothing("um", ""))
    }

    @Test fun aFillerLeftOnlyItsStopIsNothing() {
        for (tone in tones) {
            for (spoken in listOf("um", "Um.", "uh?", "Hm.", "uh, hmm", "Hmm...", "Um,")) {
                val styled = WritingStyle.apply(spoken, tone)
                assertTrue("$spoken in $tone gave '$styled'", WritingStyle.leavesNothing(spoken, styled))
            }
        }
    }

    @Test fun realSpeechIsNotNothing() {
        for (tone in tones) {
            for (spoken in listOf("hello", "Um, hello.", "uh can you send it", "ok", "5", "yes. no.")) {
                val styled = WritingStyle.apply(spoken, tone)
                assertFalse("$spoken in $tone gave '$styled'", WritingStyle.leavesNothing(spoken, styled))
            }
        }
    }

    @Test fun textThatWasNeverWordsIsPassedOnAsItCame() {
        // Only punctuation or an emoji to begin with: the style did not empty it, so it is not "no speech".
        for (tone in tones) {
            for (spoken in listOf("...", "?", "😀")) {
                val styled = WritingStyle.apply(spoken, tone)
                assertFalse("$spoken in $tone gave '$styled'", WritingStyle.leavesNothing(spoken, styled))
            }
        }
    }

    @Test fun withTheStyleOffNothingChangesFromBefore() {
        // The controller passes the spoken text through untouched when the style is off.
        assertTrue(WritingStyle.leavesNothing("", ""))
        assertFalse(WritingStyle.leavesNothing("hello", "hello"))
        assertFalse(WritingStyle.leavesNothing("?", "?"))
        assertEquals(false, WritingStyle.leavesNothing(".", "."))
    }
}
