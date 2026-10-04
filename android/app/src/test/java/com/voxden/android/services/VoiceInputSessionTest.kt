package com.voxden.android.services

import org.junit.After
import org.junit.Assert.*
import org.junit.Test

class VoiceInputSessionTest {
    @After fun cleanUp() { VoiceInputSession.clear() }

    @Test fun staleRecordingCannotWriteIntoNewKeyboardSession() {
        val old = VoiceInputSession.begin()
        val current = VoiceInputSession.begin()
        assertNotEquals(old, current)
        assertFalse(VoiceInputSession.complete(old, "Old field's words"))
        assertEquals("", VoiceInputSession.text)
        assertTrue(VoiceInputSession.complete(current, "New field's words"))
        assertEquals("New field's words", VoiceInputSession.text)
    }

    @Test fun clearingSessionRejectsLateTranscription() {
        val token = VoiceInputSession.begin()
        VoiceInputSession.clear()
        assertFalse(VoiceInputSession.complete(token, "Late private words"))
        assertNull(VoiceInputSession.token)
        assertEquals("", VoiceInputSession.text)
    }

    @Test fun newSessionDoesNotExposePreviousTranscript() {
        val first = VoiceInputSession.begin()
        VoiceInputSession.complete(first, "Private words")
        VoiceInputSession.begin()
        assertEquals("", VoiceInputSession.text)
    }

    @Test fun recordingScreenMarkerDoesNotConsumeReturnedTranscript() {
        val token = VoiceInputSession.begin()
        VoiceInputSession.enterRecordingScreen(token)
        assertTrue(VoiceInputSession.isRecordingScreenOpen)
        VoiceInputSession.complete(token, "Returned words")
        VoiceInputSession.leaveRecordingScreen(token)
        assertFalse(VoiceInputSession.isRecordingScreenOpen)
        assertEquals(token, VoiceInputSession.token)
        assertEquals("Returned words", VoiceInputSession.text)
    }

    @Test fun staleRecordingScreenCannotMarkOrCloseNewSession() {
        val old = VoiceInputSession.begin()
        val current = VoiceInputSession.begin()
        VoiceInputSession.enterRecordingScreen(old)
        assertFalse(VoiceInputSession.isRecordingScreenOpen)
        VoiceInputSession.enterRecordingScreen(current)
        VoiceInputSession.leaveRecordingScreen(old)
        assertTrue(VoiceInputSession.isRecordingScreenOpen)
    }
}
