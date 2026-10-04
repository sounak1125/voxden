package com.voxden.android.services

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.UiScrollable
import androidx.test.uiautomator.UiSelector
import androidx.test.uiautomator.Until
import com.voxden.android.MainActivity
import com.voxden.android.core.AppController
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the real Android IME and activity roundtrip, without pretending to test speech. */
@RunWith(AndroidJUnit4::class)
class VoiceKeyboardDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private val ime = "${context.packageName}/com.voxden.android.services.VoxdenInputMethodService"
    private var previousIme = ""
    private var previousShowWithHardwareKeyboard = ""
    private var wasEnabled = false

    private fun visible(text: String): UiObject2 = device.wait(Until.findObject(By.text(text)), 10_000)
        ?: throw AssertionError("Missing keyboard UI: $text")

    @Before fun prepareRealKeyboard() {
        previousIme = device.executeShellCommand("settings get secure default_input_method").trim()
        previousShowWithHardwareKeyboard = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
        wasEnabled = device.executeShellCommand("settings get secure enabled_input_methods")
            .trim().split(':').any { it.substringBefore(';') == ime }
        instrumentation.runOnMainSync {
            AppController.get(context).setOnboarded(true)
            AppController.get(context).cancelRecording()
            AppController.get(context).clearTranscript()
            VoiceInputSession.clear()
        }
        device.executeShellCommand("ime enable $ime")
        device.executeShellCommand("ime set $ime")
        assertEquals(ime, device.executeShellCommand("settings get secure default_input_method").trim())
        context.startActivity(Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        // The keyboard test field lives in Settings, under Voice keyboard.
        (device.wait(Until.findObject(By.res("nav-settings")), 10_000) ?: throw AssertionError("Missing navigation")).click()
        UiScrollable(UiSelector().scrollable(true)).setMaxSearchSwipes(10)
            .scrollIntoView(UiSelector().textContains("Try the voice keyboard"))
        val editor = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 10_000)
            ?: throw AssertionError("Home keyboard test editor was not visible")
        editor.text = ""
        editor.click()
        visible("Dictate")
    }

    @After fun restoreKeyboardAndClearFixture() {
        runCatching {
            if (device.hasObject(By.text("Start recording"))) device.pressBack()
            device.findObject(By.clazz("android.widget.EditText"))?.text = ""
        }
        instrumentation.runOnMainSync { VoiceInputSession.clear() }
        if (previousIme.isNotBlank() && previousIme != "null" && previousIme != ime) {
            device.executeShellCommand("ime set $previousIme")
        }
        if (!wasEnabled && previousIme != ime) device.executeShellCommand("ime disable $ime")
        if (previousShowWithHardwareKeyboard == "null" || previousShowWithHardwareKeyboard.isBlank()) {
            device.executeShellCommand("settings delete secure show_ime_with_hard_keyboard")
        } else {
            device.executeShellCommand("settings put secure show_ime_with_hard_keyboard $previousShowWithHardwareKeyboard")
        }
        device.pressBack()
    }

    @Test fun recordingActivityReturnsPreviewAndInsertsIntoOriginalEditor() {
        visible("Dictate").click()
        visible("Start recording")
        // Fixture enters only the process-local handoff. No microphone, speech callback,
        // history entry, API response, or production transcription is fabricated.
        instrumentation.runOnMainSync {
            val token = VoiceInputSession.token ?: throw AssertionError("IME did not open a recording session")
            assertTrue(VoiceInputSession.complete(token, FIXTURE))
        }
        device.pressBack()
        val insert = visible("Insert text")
        visible(FIXTURE)
        assertTrue("Returned transcript must enable manual Insert", insert.isEnabled)
        // Reopening the IME can shrink the Home viewport before Compose finishes moving the
        // focused field. Scroll only the app's content; this preserves editor focus/selection.
        if (!device.hasObject(By.clazz("android.widget.EditText"))) {
            UiScrollable(UiSelector().scrollable(true)).setMaxSearchSwipes(8)
                .scrollIntoView(UiSelector().textContains("Try the voice keyboard"))
        }
        val editor = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 5_000)
            ?: throw AssertionError("Recording did not return to the original editor")
        assertFalse("No automatic insertion before explicit tap", editor.text.orEmpty().contains(FIXTURE))
        visible("Insert text").click()
        assertNotNull("IME must commit the fixture into the editor", device.wait(
            Until.findObject(By.clazz("android.widget.EditText").textContains(FIXTURE)), 5_000))
        instrumentation.runOnMainSync {
            assertNull("Successful insertion must consume the session", VoiceInputSession.token)
            assertEquals("", VoiceInputSession.text)
        }
    }

    companion object { private const val FIXTURE = "Keyboard integration test" }
}
