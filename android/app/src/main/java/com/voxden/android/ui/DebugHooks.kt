package com.voxden.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.voxden.android.BuildConfig
import com.voxden.android.core.Account
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState
import com.voxden.android.core.DictationSource
import com.voxden.android.core.HistoryEntry
import com.voxden.android.core.SpeechProvider
import com.voxden.android.core.Trial
import java.time.LocalDate
import java.time.ZoneId

/**
 * Debug builds only (every entry point checks [BuildConfig.DEBUG], so release builds do nothing here).
 * Lets screenshots and UI tests put the app in a state: sample dictations, a pretend account, a tab or a sheet.
 * Driven by an intent extra, for example:
 * `adb shell am start -n com.voxden.android.debug/com.voxden.android.MainActivity --es debug_cmd "seed;tab=settings"`
 */
object DebugHooks {
    data class Request(
        val nonce: Int,
        val tab: String? = null,
        val sheet: String? = null,
        val search: String? = null,
        val step: Int? = null,
        val toast: String? = null
    )

    private var counter = 0
    var accountOverrideOn by mutableStateOf(false)
    var accountOverride by mutableStateOf<Account?>(null)
    var request by mutableStateOf<Request?>(null)
    /** Freezes the welcome illustration at a point of its loop (0..1) so it can be screenshotted. */
    var illustrationT by mutableStateOf<Float?>(null)
    /** Pretends Voxden Cloud is available, so Polish can be exercised without a server. */
    var fakeCloud by mutableStateOf(false)

    fun canPolish(controller: AppController): Boolean = controller.canPolish || (BuildConfig.DEBUG && fakeCloud)

    /** Stand-in for the cloud: a short wait, then a tidied copy. The tighten mode fails, to show the error state. */
    suspend fun fakePolish(text: String, mode: String): String {
        kotlinx.coroutines.delay(1800)
        if (mode == "tighten") throw IllegalStateException("Voxden Cloud took too long to respond. Try again.")
        return text.trim().replaceFirstChar { it.uppercase() }.let { if (it.last().isLetterOrDigit()) "$it." else it }
    }

    /** The state the UI shows: the real one, with the pretend account swapped in when one is set. */
    var partialOverride by mutableStateOf<String?>(null)
    /** Shows the account sheet's code step for this email without sending anything. */
    var codeSentEmail by mutableStateOf<String?>(null)

    fun display(state: AppState): AppState {
        if (!BuildConfig.DEBUG) return state
        var shown = state
        if (accountOverrideOn) shown = shown.copy(account = accountOverride)
        codeSentEmail?.let { shown = shown.copy(emailCodeSent = true) }
        partialOverride?.let { if (shown.phase == com.voxden.android.core.RecordingPhase.RECORDING) shown = shown.copy(partialTranscript = it) }
        return shown
    }

    fun seed(controller: AppController) {
        if (BuildConfig.DEBUG) controller.debugSeedHistory(sampleHistory(System.currentTimeMillis()))
    }

    /** Semicolon-separated commands; see the class comment. */
    fun run(command: String, controller: AppController) {
        if (!BuildConfig.DEBUG) return
        var tab: String? = null
        var sheet: String? = null
        var search: String? = null
        var step: Int? = null
        var toast: String? = null
        command.split(';').map { it.trim() }.filter { it.isNotEmpty() }.forEach { token ->
            val key = token.substringBefore('=')
            val value = token.substringAfter('=', "")
            when (key) {
                "seed" -> seed(controller)
                "unseed" -> controller.clearHistory()
                "onboarded" -> controller.setOnboarded(value != "0")
                "account" -> {
                    accountOverrideOn = value != "real"
                    accountOverride = when (value) {
                        "trial" -> Account("maya@example.com", "free", trial = Trial(credits = 60.0, used = 8.0, available = true))
                        "trialfresh" -> Account("maya@example.com", "free", trial = Trial(credits = 60.0, used = 0.0, available = true))
                        "pro" -> Account("maya@example.com", "pro", creditsUsed = 120.0, creditsCap = 900.0, trial = Trial(available = true))
                        "pro-low" -> Account("maya@example.com", "pro", creditsUsed = 855.0, creditsCap = 900.0)
                        "used" -> Account("maya@example.com", "free", trial = Trial(credits = 60.0, used = 60.0, available = true))
                        "notoffered" -> Account("maya@example.com", "free")
                        else -> null
                    }
                }
                "provider" -> controller.setProvider(if (value == "cloud") SpeechProvider.CLOUD else SpeechProvider.ANDROID)
                "codesent" -> codeSentEmail = value.ifBlank { null }
                "partial" -> partialOverride = value.ifBlank { null }
                "cloud" -> fakeCloud = value != "off"
                "consent" -> controller.setCloudConsent(value != "0")
                "dictclear" -> controller.state.value.dictionary.forEach { controller.removeTerm(it) }
                "dictionary" -> value.split(',').forEach { controller.addTerm(it) }
                "tab" -> tab = value
                "sheet" -> sheet = value
                "search" -> search = value
                "step" -> step = value.toIntOrNull()
                "toast" -> toast = value
                "illus" -> illustrationT = value.toFloatOrNull()
                "finish" -> controller.debugFinishWith(value)
            }
        }
        if (tab != null || sheet != null || search != null || step != null || toast != null) {
            request = Request(++counter, tab, sheet, search, step, toast)
        }
    }

    /** Realistic sample dictations across apps and days, one of them polished. */
    fun sampleHistory(now: Long): List<HistoryEntry> {
        val zone = ZoneId.systemDefault()
        val today = LocalDate.now(zone).atStartOfDay(zone).toInstant().toEpochMilli()
        val hour = 3_600_000L
        val minute = 60_000L
        fun at(daysAgo: Int, hours: Double) = today - daysAgo * 24 * hour + (hours * hour).toLong()
        val newest = now - 2 * minute
        return listOf(
            HistoryEntry("debug-1", "Running about ten minutes late. Save me a seat and order the flat white, I will pay when I get there.",
                newest, "Voxden Cloud", DictationSource.FLOW_BAR, "com.whatsapp", "WhatsApp", null, 7),
            HistoryEntry("debug-2", "hi priya um thanks for sending the deck over i've gone through it and i have like two small comments on the pricing slide could we find fifteen minutes tomorrow to go through them",
                now - 41 * minute, "Voxden Cloud", DictationSource.FLOW_BAR, "com.google.android.gm", "Gmail",
                "Hi Priya,\n\nThanks for sending the deck over. I have gone through it and have two small comments on the pricing slide. Could we find fifteen minutes tomorrow to go through them?", 14),
            HistoryEntry("debug-3", "Remember to book the dentist for next week and renew the car insurance before the end of the month.",
                now - 95 * minute, "Android speech", DictationSource.APP, null, null, null, 6),
            HistoryEntry("debug-4", "best ramen near Indiranagar open late",
                now - 3 * hour, "Android speech", DictationSource.FLOW_BAR, "com.android.chrome", "Chrome", null, 3),
            HistoryEntry("debug-5", "Can you send me the address again? I lost the message.",
                now - 5 * hour, "Android speech", DictationSource.KEYBOARD, null, null, null, 4),
            HistoryEntry("debug-6", "Quick update on the launch. The new onboarding is in review and should clear by Thursday. Support docs are drafted, the pricing page copy is waiting on legal, and the demo video needs one more pass on the sound. If nothing slips we are on track for the first week of next month, and I will confirm the date once review comes back.",
                at(1, 20.4), "Voxden Cloud", DictationSource.FLOW_BAR, "com.google.android.gm", "Gmail", null, 41),
            HistoryEntry("debug-7", "On my way.", at(1, 18.2), "Android speech", DictationSource.FLOW_BAR, "com.whatsapp", "WhatsApp", null, 2),
            HistoryEntry("debug-8", "Idea for the weekend: drive up to the lake, take the camera, and leave early enough to catch the sunrise.",
                at(3, 21.1), "Android speech", DictationSource.APP, null, null, null, 9),
            HistoryEntry("debug-9", "Compare the two quotes side by side before signing anything.",
                at(9, 11.6), "Android speech", DictationSource.FLOW_BAR, "com.android.chrome", "Chrome", null, 5)
        )
    }
}
