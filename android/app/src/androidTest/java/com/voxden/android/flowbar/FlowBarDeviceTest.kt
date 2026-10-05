package com.voxden.android.flowbar

import android.app.UiAutomation
import android.content.ComponentName
import android.content.Intent
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.voxden.android.core.AppController
import com.voxden.android.core.RecordingPhase
import com.voxden.android.services.FlowBarStatus
import com.voxden.android.services.VoxdenAccessibilityService
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The flow bar on a real device: the real accessibility service, a real keyboard, a real EditText in
 * another package ([FlowBarTestActivity]). The service is switched on from the test (a shell
 * `settings put`, through a UiAutomation that does not suppress accessibility services) and
 * everything the text goes through is the shipped code: the field probe, the input connection, the
 * node fallbacks, the replace logic and the dictation flow.
 */
@RunWith(AndroidJUnit4::class)
class FlowBarDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val testPackage = instrumentation.context.packageName
    private val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
    private val controller get() = AppController.get(context)

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).bufferedReader().use { it.readText() }

    private fun eventually(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (runCatching(condition).getOrDefault(false)) return
            Thread.sleep(100)
        }
        val accessibility = runCatching {
            shell("dumpsys accessibility").lines().filter { it.contains("Enabled services") || it.contains("Bound services") || it.contains("suppress", true) }.joinToString(" | ")
        }.getOrDefault("(no dump)")
        throw AssertionError("Timed out waiting for: $what [$accessibility]")
    }

    private fun engine(): FlowBarEngine = VoxdenAccessibilityService.current?.flowBarEngine() ?: throw AssertionError("The flow bar service is not running")

    /** Runs [block] on the main thread, like the service does, and returns its result. */
    private fun <T> onMain(block: () -> T): T {
        var result: Result<T>? = null
        instrumentation.runOnMainSync { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    @Before fun setUp() {
        shell("pm grant ${context.packageName} android.permission.RECORD_AUDIO")
        val service = ComponentName(context, VoxdenAccessibilityService::class.java).flattenToString()
        shell("settings put secure enabled_accessibility_services $service")
        shell("settings put secure accessibility_enabled 1")
        val connected = { FlowBarStatus.connected.value && VoxdenAccessibilityService.current?.flowBarEngine() != null }
        // After an install or a UiAutomation session the setting can say "on" while nothing is bound: switch it off and on to make Android bind again.
        if (runCatching { eventually("the accessibility service to connect", 4_000, connected) }.isFailure) {
            shell("settings delete secure enabled_accessibility_services")
            Thread.sleep(1_000)
            shell("settings put secure enabled_accessibility_services $service")
            shell("settings put secure accessibility_enabled 1")
            eventually("the accessibility service to connect", 20_000, connected)
        }
        FlowBarDebug.reset()
        onMain { engine().debugCancel() }      // a previous test may have left the capsule showing "Inserted"
        eventually("a flow at rest") { onMain { engine().phaseNow() } == FlowPhase.REST }
        onMain {
            controller.cancelRecording()
            controller.setFlowBarAlwaysShow(false)
            // These tests assert the exact typed text, and the writing style is saved state: leave it off.
            controller.setWritingStyleEnabled(false)
            controller.clearMessage()
        }
    }

    @After fun tearDown() {
        FlowBarDebug.reset()
        onMain { engine().debugCancel(); controller.cancelRecording() }
    }

    private fun launch(vararg extras: Pair<String, Any>) {
        // Let the previous screen's field and keyboard go first, so nothing below reads a field that is on its way out.
        shell("input keyevent KEYCODE_HOME")
        eventually("the launcher to be in front", 8_000) { shell("dumpsys activity activities").lines().any { it.contains("topResumedActivity") && it.contains("launcher", true) } }
        eventually("the previous field to lose focus", 8_000) { !onMain { engine().probeNow() }.let { it.editableFocused && it.packageName == testPackage } }
        Thread.sleep(500)      // let the "close to home" transition finish before another activity opens
        val intent = Intent().setClassName(testPackage, "com.voxden.android.flowbar.FlowBarTestActivity")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        extras.forEach { (key, value) -> if (value is Int) intent.putExtra(key, value) else intent.putExtra(key, value.toString()) }
        context.startActivity(intent)
    }

    private fun waitForField(password: Boolean = false, timeoutMs: Long = 15_000) {
        var steady = 0
        var last: FieldSnapshot? = null
        try {
            eventually("an editable field with the keyboard up", timeoutMs) {
                val s = onMain { engine().probeNow() }
                last = s
                steady = if (s.editableFocused && s.imeVisible && s.password == password && s.packageName == testPackage) steady + 1 else 0
                steady >= 4      // four polls in a row: focus and keyboard have settled
            }
        } catch (error: AssertionError) {
            runCatching { shell("screencap -p /sdcard/flowbar-flake.png") }
            val ime = runCatching { shell("dumpsys input_method").lines().filter { it.contains("mInputShown") || it.contains("isInputViewShown") || it.contains("mImeWindowVis") }.joinToString(" | ") { it.trim() } }.getOrDefault("")
            val a11yWindows = runCatching { onMain { VoxdenAccessibilityService.current?.windows?.joinToString(" | ") { "type=${it.type} focused=${it.isFocused} bounds=${android.graphics.Rect().also { r -> it.getBoundsInScreen(r) }} layer=${it.layer} root=${it.root != null}" } } }.getOrDefault("")
            val where = runCatching {
                (shell("dumpsys activity activities").lines().filter { it.contains("topResumedActivity") } +
                    shell("dumpsys window").lines().filter { it.contains("mCurrentFocus") || it.contains("mFocusedApp") }).joinToString(" | ") { it.trim() }
            }.getOrDefault("")
            throw AssertionError("${error.message} Last look: $last Where: $where IME: $ime A11y windows: $a11yWindows", error)
        }
        // The input connection arrives a moment after the focus does.
        if (!password && Build.VERSION.SDK_INT >= 33) eventually("a live input connection") { onMain { engine().editorSurfaceNow()?.surrounding(1, 1) } != null }
    }

    /**
     * Launches the test screen and waits for its field and keyboard. On the emulator the keyboard now and
     * then fails to draw even though Android believes it is up (the screenshot is plain black), so a screen
     * whose keyboard has not appeared in 9 s is launched again, up to three times.
     */
    private fun openField(vararg extras: Pair<String, Any>, password: Boolean = false) {
        for (attempt in 1..3) {
            launch(*extras)
            try { waitForField(password, timeoutMs = 9_000); return } catch (error: AssertionError) { if (attempt == 3) throw error }
        }
    }

    private fun fieldText(): String = onMain { engine().focusedTextNow().orEmpty() }

    /** Waits for the focused field to hold exactly [expected]; on failure says what it held instead. */
    private fun assertFieldBecomes(expected: String, what: String = "the field text") {
        val end = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < end) {
            if (runCatching { fieldText() }.getOrNull() == expected) return
            Thread.sleep(100)
        }
        throw AssertionError("$what: expected '$expected' but the field held '${runCatching { fieldText() }.getOrNull()}'")
    }

    // ---- Typing ----------------------------------------------------------------------------

    @Test fun typesIntoARealEditTextThroughTheInputConnection() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        openField("focus" to "plain")
        val first = onMain { engine().typeNow("hello world", testPackage) }
        assertEquals(TypePath.INPUT_CONNECTION, first.path)
        assertFieldBecomes("hello world", "the text to appear")
        val second = onMain { engine().typeNow("and more", testPackage) }
        assertEquals(TypePath.INPUT_CONNECTION, second.path)
        assertFieldBecomes("hello world and more", "a space between the two dictations")
        onMain { engine().typeNow(".", testPackage) }
        assertFieldBecomes("hello world and more.", "no space before a full stop")
    }

    @Test fun insertingInTheMiddleSpacesBothSides() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        openField("focus" to "plain", "plainText" to "typed after the hand off", "plainSel" to 12)
        eventually("the cursor to sit in the middle") { onMain { engine().editorSurfaceNow()?.surrounding(40, 40)?.cursor } == 12 }
        onMain { engine().typeNow("ship it", testPackage) }
        assertFieldBecomes("typed after ship it the hand off", "a space after the dictation too")
    }

    @Test fun fallsBackToSetTextOnTheFocusedNode() {
        openField("focus" to "plain")
        val first = onMain { engine().typeNow("hi there", testPackage, TypePath.SET_TEXT) }
        assertEquals(TypePath.SET_TEXT, first.path)
        assertFieldBecomes("hi there", "the text to appear")
        onMain { engine().typeNow("friend", testPackage, TypePath.SET_TEXT) }
        assertFieldBecomes("hi there friend", "merged after the cursor with a space")
    }

    @Test fun fallsBackToPasteAfterPuttingTheTextOnTheClipboard() {
        openField("focus" to "plain")
        val outcome = onMain { engine().typeNow("pasted text", testPackage, TypePath.PASTE) }
        assertEquals(TypePath.PASTE, outcome.path)
        assertFieldBecomes("pasted text", "the pasted text to appear")
    }

    @Test fun neverTypesIntoAPasswordField() {
        openField("focus" to "password", password = true)
        val outcome = onMain { engine().typeNow("hunter2", testPackage) }
        assertEquals("a password field only ever gets the clipboard", TypePath.CLIPBOARD, outcome.path)
        assertFalse(outcome.typed)
        Thread.sleep(500)
        assertEquals("", fieldText())
        listOf(TypePath.INPUT_CONNECTION, TypePath.SET_TEXT, TypePath.PASTE).forEach { path ->
            assertEquals(TypePath.CLIPBOARD, onMain { engine().typeNow("hunter2", testPackage, path) }.path)
        }
        Thread.sleep(500)
        assertEquals("", fieldText())
    }

    @Test fun refusesAFieldInAnotherApp() {
        openField("focus" to "plain")
        val outcome = onMain { engine().typeNow("wrong place", "com.example.somewhere.else") }
        assertEquals(TypePath.CLIPBOARD, outcome.path)
        Thread.sleep(500)
        assertEquals("", fieldText())
    }

    // ---- Polish ----------------------------------------------------------------------------

    @Test fun polishReplacesTheDictationInPlaceInARealField() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        openField("focus" to "plain", "plainText" to "Dear Sam,")
        val outcome = onMain { engine().typeNow("see you at six", testPackage) }
        assertFieldBecomes("Dear Sam, see you at six", "the dictation to appear")
        val result = onMain { runBlocking { polishInPlace("see you at six", outcome.inserted, outcome.surface) { "See you at six." } } }
        assertTrue(result is PolishOutcome.Replaced)
        assertFieldBecomes("Dear Sam, See you at six.", "the polished text in place")
    }

    @Test fun polishLeavesTheFieldAloneWhenTheUserEditedTheDictation() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        openField("focus" to "plain")
        val outcome = onMain { engine().typeNow("see you at six", testPackage) }
        assertFieldBecomes("see you at six", "the dictation to appear")
        onMain { engine().editorSurfaceNow()!!.deleteBeforeCursor(1) }      // the user deletes the "x"
        assertFieldBecomes("see you at si", "the edit to land")
        val result = onMain { runBlocking { polishInPlace("see you at six", outcome.inserted, outcome.surface) { "See you at six." } } }
        assertTrue("the polished text goes to the clipboard instead", result is PolishOutcome.Moved)
        Thread.sleep(500)
        assertEquals("see you at si", fieldText())
    }

    // ---- The pill and the whole dictation flow --------------------------------------------

    private fun flowBarWindowCount(): Int = shell("dumpsys window windows").lines().count { it.contains("Window{") && it.contains("Voxden flow bar") }

    @Test fun thePillFollowsFocusAndHidesInPasswordFields() {
        openField("focus" to "plain")
        eventually("the resting pill") { onMain { engine().pillAttachedNow() } && flowBarWindowCount() >= 1 }
        openField("focus" to "password", password = true)
        eventually("the pill to go away") { !onMain { engine().pillAttachedNow() } && flowBarWindowCount() == 0 }
        launch("focus" to "none")
        eventually("no pill without a keyboard") { !onMain { engine().pillAttachedNow() } }
        onMain { controller.setFlowBarAlwaysShow(true) }
        eventually("the pill with Always show") { onMain { engine().pillAttachedNow() } }
        onMain { controller.setFlowBarAlwaysShow(false) }
        eventually("the pill gone again") { !onMain { engine().pillAttachedNow() } }
    }

    @Test fun aWholeDictationFromPillToPolish() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        FlowBarDebug.polishOverride = { it.replaceFirstChar { c -> c.uppercase() } + "." }
        openField("focus" to "plain")
        onMain { engine().debugStart() }
        eventually("recording") { onMain { engine().phaseNow() } == FlowPhase.RECORDING && controller.state.value.phase == RecordingPhase.RECORDING }
        assertTrue(onMain { engine().capsuleAttachedNow() })
        eventually("the pill hides while the capsule is up") { !onMain { engine().pillAttachedNow() } }
        onMain { controller.debugFinishWith("meet me at nine") }
        eventually("DONE") { onMain { engine().phaseNow() } == FlowPhase.DONE }
        assertFieldBecomes("meet me at nine", "the text typed at the cursor")
        assertEquals("the dictation is saved to history", "meet me at nine", controller.state.value.history.first().text)
        onMain { engine().debugPolish() }
        assertFieldBecomes("Meet me at nine.", "the polished text in place")
        eventually("the dictation's polished version is saved") { controller.state.value.history.first().polished == "Meet me at nine." }
        eventually("back to rest", 10_000) { onMain { engine().phaseNow() } == FlowPhase.REST }
        eventually("the pill is back") { onMain { engine().pillAttachedNow() } }
        eventually("the capsule window is removed") { !onMain { engine().capsuleAttachedNow() } }
    }

    @Test fun cancelDiscardsTheDictationAndTypesNothing() {
        openField("focus" to "plain")
        onMain { engine().debugStart() }
        eventually("recording") { onMain { engine().phaseNow() } == FlowPhase.RECORDING }
        val historyBefore = controller.state.value.history.size
        onMain { engine().debugCancel() }
        eventually("rest") { onMain { engine().phaseNow() } == FlowPhase.REST }
        assertEquals(RecordingPhase.IDLE, controller.state.value.phase)
        assertEquals(historyBefore, controller.state.value.history.size)
        Thread.sleep(500)
        assertEquals("", fieldText())
        eventually("the pill is back") { onMain { engine().pillAttachedNow() } }
    }

    @Test fun theHandoffActivityStartsTheDictationAndTheFieldKeepsItsFocus() {
        assumeTrue(Build.VERSION.SDK_INT >= 33)
        FlowBarDebug.forceHandoff = true
        openField("focus" to "plain", "plainText" to "Hi")
        onMain { engine().debugStart() }
        eventually("recording, started by the hand-off activity") {
            onMain { engine().phaseNow() } == FlowPhase.RECORDING && controller.state.value.phase == RecordingPhase.RECORDING
        }
        // The target app must have its field, its keyboard and its input connection back after the hand-off.
        waitForField()
        onMain { controller.debugFinishWith("typed after the hand off") }
        eventually("DONE") { onMain { engine().phaseNow() } == FlowPhase.DONE }
        assertFieldBecomes("Hi typed after the hand off", "the text typed after the hand-off")
    }

    @Test fun theMicrophoneIsOpenToTheServiceWhileAnotherAppIsInFront() {
        openField("focus" to "plain")
        assertTrue("the accessibility service may record", MicAccess.canRecordNow(context))
        onMain { engine().debugStart() }
        var source: com.voxden.android.core.DictationSource? = null
        eventually("the dictation to start from the service") {
            val state = controller.state.value
            if (state.phase == RecordingPhase.RECORDING) source = state.recordingSource
            source != null
        }
        assertEquals(com.voxden.android.core.DictationSource.FLOW_BAR, source)
        onMain { engine().debugCancel() }
    }
}
