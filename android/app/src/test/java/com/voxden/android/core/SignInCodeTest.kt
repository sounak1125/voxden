package com.voxden.android.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The code step surviving the user leaving for their mail app, and Android clearing Voxden while they are away. */
class SignInCodeTest {
    private val minute = 60_000L
    private val sent = 1_000_000_000L

    private fun restore(text: String, now: Long) = SignInCode.restore(JSONObject(text), now)
    private fun shown(text: String, now: Long) = restore(text, now) != null
    private fun pending(email: String = "maya@example.com", at: Long = sent) = """{"pendingCode":{"email":"$email","sentAt":$at}}"""

    @Test fun aCodeStaysOpenForLessThanTheServicesTenMinutes() {
        assertTrue(SignInCode.stillOpen(sent, sent))
        assertTrue(SignInCode.stillOpen(sent, sent + 5 * minute))
        assertTrue(SignInCode.stillOpen(sent, sent + SignInCode.STEP_MILLIS - 1))
        assertFalse(SignInCode.stillOpen(sent, sent + SignInCode.STEP_MILLIS))
        assertFalse(SignInCode.stillOpen(sent, sent + 10 * minute))
        assertTrue("the step closes before the service drops the code", SignInCode.STEP_MILLIS < 10 * minute)
    }

    @Test fun nothingSentOrAClockSetBackIsNotOpen() {
        assertFalse(SignInCode.stillOpen(0L, sent))
        assertFalse(SignInCode.stillOpen(-5L, sent))
        assertFalse("the clock moved back", SignInCode.stillOpen(sent, sent - 1))
    }

    @Test fun theCodeStepComesBackAfterARestartWithTheSameEmail() {
        assertEquals(SignInCode.Pending("maya@example.com", sent), restore(pending(), sent + 3 * minute))
    }

    @Test fun anOldCodeStepDoesNotComeBack() {
        assertNull(restore(pending(), sent + 30 * minute))
    }

    @Test fun nothingSavedMeansTheEmailStep() {
        assertNull(restore("{}", sent))
    }

    @Test fun aSignedInPhoneNeverShowsTheCodeStep() {
        assertNull(restore("""{"account":{"email":"maya@example.com","plan":"free"},"pendingCode":{"email":"maya@example.com","sentAt":$sent}}""", sent + minute))
    }

    @Test fun damagedEntriesAreIgnoredNotTrusted() {
        assertFalse(shown("""{"pendingCode":"yes"}""", sent))
        assertFalse(shown("""{"pendingCode":{"email":"","sentAt":$sent}}""", sent))
        assertFalse(shown("""{"pendingCode":{"email":"   ","sentAt":$sent}}""", sent))
        assertFalse(shown("""{"pendingCode":{"email":"maya@example.com"}}""", sent))
        assertFalse(shown("""{"pendingCode":{"email":"maya@example.com","sentAt":"soon"}}""", sent))
        assertFalse(shown("""{"pendingCode":{"email":"maya@example.com","sentAt":-1}}""", sent))
    }

    @Test fun theSavedEmailIsTrimmed() {
        assertEquals("maya@example.com", restore(pending("  maya@example.com "), sent + minute)?.email)
    }

    @Test fun otherSavedSettingsAreUntouched() {
        val state = AppController.restoreState(JSONObject("""{"language":"hi-IN","saveHistory":false,"pendingCode":{"email":"maya@example.com","sentAt":$sent}}"""), sent + minute)
        assertEquals("hi-IN", state.language)
        assertFalse(state.saveHistory)
        assertTrue(state.emailCodeSent)
        assertEquals("maya@example.com", state.codeSentTo)
        assertEquals(sent, state.codeSentAt)
        val late = AppController.restoreState(JSONObject("""{"pendingCode":{"email":"maya@example.com","sentAt":$sent}}"""), sent + 30 * minute)
        assertFalse(late.emailCodeSent)
        assertEquals("", late.codeSentTo)
        assertEquals(0L, late.codeSentAt)
    }
}
