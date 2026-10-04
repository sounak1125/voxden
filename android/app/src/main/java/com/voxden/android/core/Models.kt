package com.voxden.android.core

enum class SpeechProvider { ANDROID, CLOUD }
enum class RecordingPhase { IDLE, RECORDING, PROCESSING }

/** Where a dictation was started: the app's own Dictate bar, the flow bar over another app, or the voice keyboard. */
enum class DictationSource { APP, FLOW_BAR, KEYBOARD }

/** The app a flow-bar dictation was typed into, for the "into WhatsApp" line in the list. */
data class TargetApp(val packageName: String, val label: String)

/**
 * The one-time Voxden Cloud trial a free account gets. Minutes and credits are the same unit
 * (1 credit = 1 minute of audio). `available` is false when the server does not offer a trial
 * (an older account service) — then the app must not advertise one.
 */
data class Trial(val credits: Double = 0.0, val used: Double = 0.0, val available: Boolean = false) {
    val left: Double get() = (credits - used).coerceAtLeast(0.0)
    val active: Boolean get() = available && left > 0.0
}

data class Account(
    val email: String,
    val plan: String,
    val creditsUsed: Double = 0.0,
    val creditsCap: Double = 0.0,
    val trial: Trial = Trial()
) {
    val isPro: Boolean get() = plan == "pro"
    /** Whether this account may use Voxden Cloud right now: Pro, or a free account with trial minutes left. */
    val hasCloud: Boolean get() = isPro || trial.active
    /** Cloud minutes left: the Pro month's remaining credits, or the trial's. */
    val cloudMinutesLeft: Double get() = if (isPro) (creditsCap - creditsUsed).coerceAtLeast(0.0) else trial.left
}

data class HistoryEntry(
    val id: String,
    val text: String,
    val createdAt: Long,
    val provider: String,
    val source: DictationSource = DictationSource.APP,
    val appPackage: String? = null,
    val appLabel: String? = null,
    /** The latest polished version, when the user polished this dictation. `text` stays the original. */
    val polished: String? = null,
    val durationSeconds: Int = 0
)

enum class BarSide { LEFT, RIGHT }

data class FlowBarSettings(
    val side: BarSide = BarSide.RIGHT,
    /** Vertical position of the resting pill as a fraction of the screen height (0 = top, 1 = bottom). */
    val offset: Float = 0.42f,
    /** Show the resting pill everywhere, not only while a text field is focused with the keyboard up. */
    val alwaysShow: Boolean = false,
    val haptics: Boolean = true
)

/** One finished dictation (or its failure), emitted once on [AppController.results]. */
data class DictationResult(
    val source: DictationSource,
    val text: String,
    /** The saved history entry, or null when history saving is off or the dictation failed. */
    val entryId: String?,
    val target: TargetApp? = null,
    /** A user-facing message when the dictation failed or was empty; [text] is then blank. */
    val error: String? = null
)

data class AppState(
    val provider: SpeechProvider = SpeechProvider.ANDROID,
    val phase: RecordingPhase = RecordingPhase.IDLE,
    /** Which surface started the dictation in progress; null while idle. */
    val recordingSource: DictationSource? = null,
    val transcript: String = "",
    val partialTranscript: String = "",
    val elapsedSeconds: Int = 0,
    val audioLevel: Float = 0f,
    val error: String? = null,
    val notice: String? = null,
    val busy: Boolean = false,
    val emailCodeSent: Boolean = false,
    val account: Account? = null,
    val history: List<HistoryEntry> = emptyList(),
    val dictionary: List<String> = emptyList(),
    val language: String = "en-US",
    val cloudConsent: Boolean = false,
    val saveHistory: Boolean = true,
    val flowBar: FlowBarSettings = FlowBarSettings(),
    /** First-run setup finished or skipped. */
    val onboarded: Boolean = false,
    /** This week's words on the phone's speech engine (the free cap, [FreeQuota]). */
    val freeWords: FreeWords = FreeWords()
)
