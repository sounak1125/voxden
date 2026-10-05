package com.voxden.android

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import com.voxden.android.core.AppController
import com.voxden.android.core.DictationSource
import com.voxden.android.core.HistoryEntry
import com.voxden.android.core.RecordingPhase
import com.voxden.android.core.SpeechProvider
import com.voxden.android.services.FlowBarStatus
import com.voxden.android.ui.DebugHooks
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Walks the redesigned app on a real device: onboarding, the dictation list with search and detail sheet,
 * the dictionary, settings and the trial sheet, the licences page, and the microphone lifecycle.
 * Elements are found by the test tags the app exposes as resource ids.
 */
@RunWith(AndroidJUnit4::class)
class AppSmokeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private val controller get() = AppController.get(context)

    private fun tag(id: String, timeout: Long = 10_000): UiObject2 =
        device.wait(Until.findObject(By.res(id)), timeout) ?: throw AssertionError("Missing UI element: $id")
    private fun text(value: String, timeout: Long = 10_000): UiObject2 =
        device.wait(Until.findObject(By.text(value)), timeout) ?: throw AssertionError("Missing text: $value")
    private fun textContaining(value: String, timeout: Long = 10_000): UiObject2 =
        device.wait(Until.findObject(By.textContains(value)), timeout) ?: throw AssertionError("Missing text containing: $value")
    private fun gone(id: String) = assertTrue("$id should disappear", device.wait(Until.gone(By.res(id)), 5_000))

    private fun launch() {
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
    }

    private fun seed(vararg entries: HistoryEntry) = instrumentation.runOnMainSync { controller.debugSeedHistory(entries.toList()) }

    @Before fun prepare() {
        instrumentation.runOnMainSync {
            controller.setOnboarded(true)
            controller.cancelRecording()
            controller.setCloudConsent(false)
            controller.setProvider(SpeechProvider.ANDROID)
            controller.clearMessage()
        }
    }

    @After fun cleanUp() {
        instrumentation.runOnMainSync {
            controller.cancelRecording()
            controller.setOnboarded(true)
            controller.removeTerm("VoxdenSmokeTerm")
            listOf("smoke-alpha", "smoke-bravo").forEach { controller.deleteHistory(it) }
        }
        device.pressHome()
    }

    @Test fun onboardingWalksThroughSetupAndFinishesThroughTheTrialSheet() {
        instrumentation.runOnMainSync { controller.setOnboarded(false) }
        launch()
        tag("onboarding-headline")
        tag("onboarding-start").click()
        tag("onboarding-continue")
        tag("setup-microphone")
        tag("setup-type-for-you")
        tag("onboarding-skip").click()
        // Skipping setup goes straight to the trial offer, over a quiet backdrop.
        tag("account-sheet")
        text("Try Voxden Cloud free")
        device.pressBack()
        tag("nav-dictations")
        assertTrue("Dismissing the trial sheet finishes onboarding", controller.state.value.onboarded)
    }

    /** Opens the app with a debug command (fake account, open sheet) and runs [check]; the fake account is always put away. */
    private fun withDebugCommand(command: String, check: () -> Unit) {
        context.startActivity(
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                .putExtra("debug_cmd", command)
        )
        try { check() } finally { instrumentation.runOnMainSync { DebugHooks.run("account=real", controller) } }
    }

    @Test fun theUsedUpSheetOffersProAndExplainsBeforeAnythingOpens() = withDebugCommand("account=used;sheet=account") {
        tag("account-sheet")
        text("Your free minutes are used.")
        tag("upgrade-pro").click()
        // The dialog comes first: nothing leaves the app until Continue.
        text("Continue")
        text("Not now").click()
        tag("upgrade-pro")
    }

    @Test fun theTrialSheetLetsYouSkipTheTrialAndBuyPro() = withDebugCommand("account=trialfresh;sheet=account") {
        tag("account-sheet")
        tag("start-cloud")
        tag("upgrade-pro")
    }

    @Test fun historySearchDetailAndDelete() {
        val now = System.currentTimeMillis()
        seed(
            HistoryEntry("smoke-alpha", "Smoke dictation alpha about the dentist", now - 60_000, "Android speech", DictationSource.APP),
            HistoryEntry("smoke-bravo", "Smoke dictation bravo about ramen", now - 120_000, "Android speech", DictationSource.FLOW_BAR, "com.android.chrome", "Chrome")
        )
        launch()
        tag("nav-dictations").click()
        textContaining("Smoke dictation alpha")
        textContaining("Smoke dictation bravo")
        // Search narrows the list.
        tag("search-button").click()
        tag("search-field").text = "ramen"
        textContaining("Smoke dictation bravo")
        assertTrue(device.wait(Until.gone(By.textContains("Smoke dictation alpha")), 5_000))
        textContaining("match")
        text("Cancel").click()
        textContaining("Smoke dictation alpha")
        // The detail sheet opens, shows the details, and deletes behind a confirmation.
        textContaining("Smoke dictation alpha").click()
        tag("detail-sheet")
        text("Details")
        tag("detail-delete").click()
        text("Delete this dictation?")
        text("Cancel").click()
        tag("detail-sheet")
        tag("detail-delete").click()
        // Let the confirmation finish animating in: a tap during its entrance can land on the scrim.
        text("Delete this dictation?")
        device.waitForIdle()
        text("Delete").click()
        gone("detail-sheet")
        val deadline = System.currentTimeMillis() + 3_000
        while (controller.state.value.history.any { it.id == "smoke-alpha" } && System.currentTimeMillis() < deadline) Thread.sleep(50)
        assertNull(controller.state.value.history.firstOrNull { it.id == "smoke-alpha" })
        assertNotNull(controller.state.value.history.firstOrNull { it.id == "smoke-bravo" })
    }

    @Test fun dictionaryAddsAndRemovesAWord() {
        launch()
        tag("nav-dictionary").click()
        tag("dictionary-field").text = "VoxdenSmokeTerm"
        tag("dictionary-add").click()
        text("VoxdenSmokeTerm")
        val remove = device.wait(Until.findObject(By.desc("Remove VoxdenSmokeTerm")), 5_000)
        assertNotNull(remove)
        remove.click()
        assertTrue(device.wait(Until.gone(By.text("VoxdenSmokeTerm")), 5_000))
        assertFalse(controller.state.value.dictionary.contains("VoxdenSmokeTerm"))
    }

    @Test fun cloudEngineWithoutAnAccountOpensTheTrialSheetAndChangesNothing() {
        launch()
        tag("nav-settings").click()
        tag("engine-cloud").click()
        tag("account-sheet")
        text("Try Voxden Cloud free")
        device.pressBack()
        gone("account-sheet")
        assertEquals(SpeechProvider.ANDROID, controller.state.value.provider)
        assertFalse(controller.state.value.cloudConsent)
    }

    @Test fun flowBarRowOpensTheSetupSheet() {
        launch()
        tag("nav-settings").click()
        tag("settings-flow-bar").click()
        text("Set up the flow bar")
        tag("setup-microphone")
        tag("setup-type-for-you")
    }

    @Test fun typeForYouShowsTheAccessibilityDisclosureBeforeSettings() {
        assumeFalse("The flow bar is already on, so there is nothing to turn on", FlowBarStatus.isEnabled(context))
        launch()
        tag("nav-settings").click()
        tag("settings-flow-bar").click()
        tag("setup-type-for-you").click()
        tag("accessibility-disclosure")
        text("Let Voxden type for you")
        text("What it reads")
        text("What it never does")
        text("Agree and open settings")
        text("Not now").click()
        gone("accessibility-disclosure")
    }

    @Test fun licencesPageListsTheFontLicences() {
        launch()
        tag("nav-settings").click()
        // Swipe the settings list up until the licences row is well inside the list, clear of the navigation bar.
        repeat(10) {
            val row = device.findObject(By.res("settings-licences"))
            if (row != null && row.visibleBounds.centerY() < device.displayHeight * 0.7) return@repeat
            device.swipe(device.displayWidth / 2, device.displayHeight * 3 / 4, device.displayWidth / 2, device.displayHeight / 4, 30)
            device.waitForIdle()
        }
        // A tap during the list's fling only stops the fling, so let it settle first.
        Thread.sleep(800)
        tag("settings-licences").click()
        tag("licences-screen")
        text("Inter")
        text("Sora")
        text("Instrument Serif")
        text("Inter").click()
        textContaining("SIL OPEN FONT LICENSE")
        tag("licences-back").click()
        gone("licences-screen")
    }

    @Test fun microphoneStopsWhenAppLeavesForeground() {
        device.executeShellCommand("pm grant ${context.packageName} android.permission.RECORD_AUDIO")
        launch()
        tag("nav-dictations").click()
        device.wait(Until.findObject(By.desc("Dictate")), 10_000)?.click() ?: throw AssertionError("Dictate capsule missing")
        device.wait(Until.hasObject(By.desc("Listening")), 3_000)
        val state = controller.state.value
        assertTrue("Recording should start or report a real speech-service error", state.phase != RecordingPhase.IDLE || state.error != null)
        device.pressHome()
        device.waitForIdle()
        assertNotEquals(RecordingPhase.RECORDING, controller.state.value.phase)
    }
}
