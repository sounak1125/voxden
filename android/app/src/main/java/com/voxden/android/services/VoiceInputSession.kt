package com.voxden.android.services

import java.util.UUID

/** Process-local handoff, never broadcast or persisted. Insertion always needs another tap. */
internal object VoiceInputSession {
    var token: String? = null
        private set
    var text: String = ""
        private set
    private var recordingScreenToken: String? = null
    val isRecordingScreenOpen: Boolean get() = token != null && token == recordingScreenToken
    fun begin(): String = UUID.randomUUID().toString().also { token = it; text = ""; recordingScreenToken = null }
    fun enterRecordingScreen(expected: String?) {
        if (expected != null && expected == token) recordingScreenToken = expected
    }
    fun leaveRecordingScreen(expected: String?) {
        if (expected != null && expected == recordingScreenToken) recordingScreenToken = null
    }
    fun complete(expected: String, transcript: String): Boolean {
        if (expected != token) return false
        text = transcript
        return true
    }
    fun clear() { token = null; text = ""; recordingScreenToken = null }
}
