package com.voxden.android.core

import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SecureStoreDeviceTest {
    private fun testContext(): Context = object : ContextWrapper(InstrumentationRegistry.getInstrumentation().targetContext) {
        override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
            super.getSharedPreferences("test_$name", mode)
    }

    @Test fun privateDataSurvivesRoundTripWithoutPlaintextStorage() {
        val context = testContext()
        val preferences = context.getSharedPreferences("voxden_private", Context.MODE_PRIVATE)
        preferences.edit().clear().commit()
        try {
            val state = AppState(
                provider = SpeechProvider.CLOUD, cloudConsent = true, language = "hi-IN",
                dictionary = listOf("VoxdenSecretWord"),
                history = listOf(HistoryEntry("one", "Private transcript sample", 123L, "CLOUD")),
                account = Account("test@example.invalid", "pro", 2.0, 900.0)
            )
            SecureStore(context).write(state, "test-sensitive-session")
            val raw = preferences.getString("payload", "")!!
            assertFalse(raw.contains("test-sensitive-session"))
            assertFalse(raw.contains("Private transcript"))
            assertFalse(raw.contains("VoxdenSecretWord"))
            val restored = SecureStore(context).read()
            assertEquals("test-sensitive-session", restored.getString("token"))
            assertEquals("hi-IN", restored.getString("language"))
            assertEquals("Private transcript sample", restored.getJSONArray("history").getJSONObject(0).getString("text"))
            assertTrue(restored.getBoolean("consent"))
        } finally { preferences.edit().clear().commit() }
    }

    @Test fun tamperedCiphertextFailsClosed() {
        val context = testContext()
        val preferences = context.getSharedPreferences("voxden_private", Context.MODE_PRIVATE)
        preferences.edit().putString("payload", "tampered").commit()
        try {
            val store = SecureStore(context)
            assertEquals(0, store.read().length())
            assertTrue(store.readFailed)
        } finally { preferences.edit().clear().commit() }
    }
}
