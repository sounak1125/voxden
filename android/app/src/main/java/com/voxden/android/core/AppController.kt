package com.voxden.android.core

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID

/**
 * Application-owned state shared by Compose, the flow bar (accessibility service), the recording
 * Activity and the voice keyboard. One dictation runs at a time, whichever surface started it.
 */
class AppController private constructor(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val store = SecureStore(context)
    private val restored = store.read()
    private var token: String? = restored.optString("token").takeUnless { it.isBlank() || it == "null" }
    private val mutableState = MutableStateFlow(restoreState(restored))
    val state: StateFlow<AppState> = mutableState.asStateFlow()
    private val mutableResults = MutableSharedFlow<DictationResult>(extraBufferCapacity = 8)
    /** Every finished dictation, once, with the surface that started it. Failures carry [DictationResult.error]. */
    val results: SharedFlow<DictationResult> = mutableResults.asSharedFlow()
    private val api = ApiClient()
    private var recognizer: SpeechRecognizer? = null
    private var pcm: PcmRecorder? = null
    private var ticker: Job? = null
    private var recordingWork: Job? = null
    private var accountWork: Job? = null
    private var upgradePoll: Job? = null
    private var accountGeneration = 0
    /** Account refreshes started, and the newest one whose answer has been applied (see [pullAccount]). */
    private var accountPulls = 0
    private var accountPulled = 0
    private var recordingGeneration = 0
    private var recordingTarget: TargetApp? = null
    private var recordingStartedAt = 0L

    init {
        if (store.readFailed) change { copy(error = "Saved device data could not be unlocked. Please sign in again.") }
        // A payment that was being waited for when the app was closed (a UPI app can take the phone away for a
        // while): carry on waiting, or say the wait ran out. Never offer a second payment as if nothing happened.
        val since = state.value.upgrade.waitingSince
        val session = token
        if (since > 0L) when {
            session == null -> change { copy(upgrade = Upgrade()) }
            ProUpgrade.stillWaiting(since, System.currentTimeMillis()) -> waitForPro(session)
            else -> change { copy(upgrade = Upgrade(note = ProUpgrade.WAIT_TIMED_OUT)) }
        }
    }

    private fun change(block: AppState.() -> AppState) { mutableState.value = mutableState.value.block() }
    private fun persist() {
        try { store.write(state.value, token) }
        catch (_: Exception) { change { copy(error = "Changes could not be saved securely on this device. Check available storage.") } }
    }
    /** Whether Polish can run now: cloud consent given and an account with cloud minutes (Pro or trial). */
    val canPolish: Boolean get() = state.value.cloudConsent && state.value.account?.hasCloud == true

    fun clearMessage() = change { copy(error = null, notice = null) }
    fun reportError(message: String) = change { copy(error = message, notice = null) }
    fun setProvider(provider: SpeechProvider) {
        if (state.value.phase != RecordingPhase.IDLE) return
        change { copy(provider = provider, error = null) }; persist()
    }
    fun setLanguage(language: String) {
        if (state.value.phase != RecordingPhase.IDLE) return
        change { copy(language = language.trim().ifBlank { "en-US" }) }; persist()
    }
    fun setCloudConsent(enabled: Boolean) {
        if (!enabled && state.value.provider == SpeechProvider.CLOUD) cancelRecording()
        change { copy(cloudConsent = enabled, provider = if (enabled) provider else SpeechProvider.ANDROID) }; persist()
    }
    /** The user agreed to the cloud disclosure on the trial or upgrade sheet: switch dictation to Voxden Cloud. */
    fun startCloud() {
        if (state.value.account?.hasCloud != true) { reportError("Sign in with an account that has Voxden Cloud minutes."); return }
        change { copy(cloudConsent = true, provider = SpeechProvider.CLOUD, error = null) }; persist()
    }
    fun setSaveHistory(enabled: Boolean) { change { copy(saveHistory = enabled) }; persist() }
    fun setOnboarded(done: Boolean = true) { change { copy(onboarded = done) }; persist() }
    fun setFlowBarSide(side: BarSide) { change { copy(flowBar = flowBar.copy(side = side)) }; persist() }
    fun setFlowBarOffset(offset: Float) { change { copy(flowBar = flowBar.copy(offset = offset.coerceIn(0.08f, 0.85f))) }; persist() }
    fun setFlowBarAlwaysShow(always: Boolean) { change { copy(flowBar = flowBar.copy(alwaysShow = always)) }; persist() }
    fun setFlowBarHaptics(enabled: Boolean) { change { copy(flowBar = flowBar.copy(haptics = enabled)) }; persist() }
    fun setWritingStyleEnabled(enabled: Boolean) { change { copy(writingStyle = writingStyle.copy(enabled = enabled)) }; persist() }
    fun setWritingTone(context: WritingContext, tone: WritingTone) { change { copy(writingStyle = writingStyle.withTone(context, tone)) }; persist() }

    fun clearTranscript() = change { copy(transcript = "", partialTranscript = "") }
    fun deleteHistory(id: String) { change { copy(history = history.filterNot { it.id == id }) }; persist() }
    fun clearHistory() { change { copy(history = emptyList()) }; persist() }
    /** Saves an edit the user made to a dictation's text. */
    fun updateHistoryText(id: String, text: String) {
        val clean = text.take(100_000)
        change { copy(history = history.map { if (it.id == id) it.copy(text = clean) else it }) }; persist()
    }
    /** Records the polished version of a dictation; null removes it. */
    fun setPolished(id: String, polished: String?) {
        change { copy(history = history.map { if (it.id == id) it.copy(polished = polished?.take(100_000)) else it }) }; persist()
    }
    fun addTerm(term: String) {
        val clean = term.trim().replace(Regex("\\s+"), " ").take(64)
        if (clean.isEmpty()) return
        if (state.value.dictionary.size >= 100) { reportError("The dictionary can hold 100 terms."); return }
        change { copy(dictionary = (dictionary + clean).distinctBy { it.lowercase(Locale.ROOT) }) }; persist()
    }
    fun removeTerm(term: String) { change { copy(dictionary = dictionary - term) }; persist() }

    private fun accountOperation(block: suspend () -> Unit) {
        if (state.value.busy) return
        val generation = ++accountGeneration
        change { copy(busy = true, error = null, notice = null) }
        accountWork = scope.launch {
            try { block() }
            catch (error: Exception) {
                if (error is CancellationException) throw error
                if (error is ApiException && error.status == 401) clearSession()
                reportError(friendlyError(error))
            } finally { if (generation == accountGeneration) change { copy(busy = false) } }
        }
    }
    fun sendCode(email: String) {
        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(email.trim()).matches()) { reportError("Enter a valid email address."); return }
        accountOperation {
            api.request("POST", "/auth/code", body = JSONObject().put("email", email.trim()))
            change { copy(emailCodeSent = true, notice = "A six-digit sign-in code has been sent to your email.") }
        }
    }
    fun verifyCode(email: String, code: String) {
        if (!Regex("[0-9]{6}").matches(code.trim())) { reportError("Enter the six-digit code from your email."); return }
        accountOperation {
            val result = api.request("POST", "/auth/verify", body = JSONObject().put("email", email.trim())
                .put("code", code.trim()).put("device", "Voxden Android"))
            token = result.getString("token")
            change { copy(account = parseAccount(result.getJSONObject("account")), emailCodeSent = false, notice = "You are signed in.") }
            persist()
        }
    }
    /** Leaves the code step so the user can correct their email address. */
    fun cancelCode() = change { copy(emailCodeSent = false, error = null, notice = null) }
    /** Background refresh for app start: no busy flag, no error shown unless the session was revoked. */
    fun refreshAccountQuietly() {
        val session = token ?: return
        scope.launch { pullAccount(session) }
    }

    /**
     * Fetches the account once and applies it. Returns it, or null when the call failed (a revoked session
     * signs out). An account that has turned Pro ends any wait for a payment, whoever noticed first.
     */
    private suspend fun pullAccount(session: String): Account? {
        val mine = ++accountPulls
        try {
            val account = parseAccount(api.request("GET", "/me", session).getJSONObject("account"))
            // An answer that was overtaken by a newer one is dropped, so a slow old "free" cannot undo a newer "Pro".
            if (token != session || mine < accountPulled) return null
            accountPulled = mine
            val paid = account.isPro && state.value.upgrade.waiting
            val changed = account != state.value.account
            change { copy(account = account, upgrade = if (account.isPro) Upgrade() else upgrade) }
            if (paid) change { copy(notice = "You're on Pro. Voxden Cloud is ready.") }
            if (changed || paid) persist()
            return account
        } catch (error: Exception) {
            if (error is CancellationException) throw error
            if (error is ApiException && error.status == 401 && token == session) clearSession()
            return null
        }
    }

    // ---- Buying Pro ------------------------------------------------------------------------

    /**
     * Asks the account service what Pro costs for this account. Nothing can be bought until the price has been
     * fetched and shown, so a failure is recorded ([Upgrade.offerFailed]) for the sheet to offer a retry.
     */
    fun loadProOffer() {
        if (!com.voxden.android.BuildConfig.WEB_CHECKOUT) return
        val session = token ?: return
        if (state.value.account?.isPro == true) return
        change { copy(upgrade = upgrade.copy(offerFailed = false)) }
        scope.launch {
            try {
                val (offer, blocked) = parseOffer(api.request("GET", "/billing/options", session))
                if (token == session) change { copy(upgrade = upgrade.copy(offer = offer, blocked = blocked, offerFailed = false)) }
            } catch (error: Exception) {
                if (error is CancellationException) throw error
                if (error is ApiException && error.status == 401 && token == session) clearSession()
                else if (token == session) change { copy(upgrade = upgrade.copy(offerFailed = true)) }
            }
        }
    }

    /**
     * Starts buying Pro: asks the account service for a hosted payment page and hands its address to [openPage],
     * which says whether the page opened (only an `https` address is ever offered to it). Only then does the app
     * wait for the account to turn Pro, checking every [ProUpgrade.POLL_MILLIS] for up to
     * [ProUpgrade.WAIT_LIMIT_MILLIS]. The wait is saved, so a restart carries on with it.
     *
     * The account service records nothing when a payment page is created, only when a payment is confirmed. So the
     * only protection against paying twice is here: no second page is offered while a payment may be on its way
     * (during the wait, and after it ends the sheet says not to pay again). Two phones, or a tap after a payment
     * that was confirmed late, are not covered until the service reuses a pending page.
     */
    fun startUpgrade(openPage: (String) -> Boolean) {
        if (!com.voxden.android.BuildConfig.WEB_CHECKOUT) return
        val account = state.value.account ?: return
        // The price is shown before anything is bought, so there is nothing to start without it.
        val offer = state.value.upgrade.offer ?: return
        if (account.isPro || state.value.upgrade.waiting) return
        accountOperation {
            val session = token ?: throw IllegalStateException("Please sign in first.")
            change { copy(upgrade = upgrade.copy(note = null)) }
            val body = JSONObject().put("provider", "razorpay").put("plan", "monthly")
            offer.region?.let { body.put("region", it) }
            val result = try {
                api.request("POST", "/billing/checkout", session, body)
            } catch (error: ApiException) {
                if (error.status == 409) {
                    // The service already holds a subscription for this account that the app has not seen as Pro yet.
                    val fresh = pullAccount(session)
                    if (fresh?.isPro == true || token != session) return@accountOperation
                    change { copy(upgrade = upgrade.copy(note = ProUpgrade.ALREADY_SUBSCRIBED)) }
                    return@accountOperation
                }
                if (error.code == "region") {
                    // The price on screen was for another region: forget it and ask again.
                    change { copy(upgrade = upgrade.copy(offer = null)) }
                    loadProOffer()
                }
                throw ApiException(error.status, ProUpgrade.checkoutError(error.code, error.message.orEmpty()), error.code)
            }
            val url = result.optString("url")
            if (!ProUpgrade.isSecureUrl(url)) throw IllegalStateException("The payment page address wasn't secure, so it wasn't opened.")
            if (!openPage(url)) throw IllegalStateException("Couldn't open the payment page. Check that a web browser is installed.")
            change { copy(upgrade = upgrade.copy(waitingSince = System.currentTimeMillis(), note = null)) }
            persist()
            waitForPro(session)
        }
    }

    /** Checks the account on a timer until it is Pro or the wait runs out. Its own job, so it never holds [AppState.busy]. */
    private fun waitForPro(session: String) {
        upgradePoll?.cancel()
        upgradePoll = scope.launch {
            while (token == session && ProUpgrade.stillWaiting(state.value.upgrade.waitingSince, System.currentTimeMillis())) {
                delay(ProUpgrade.POLL_MILLIS)
                if (token != session) return@launch
                pullAccount(session)
            }
            if (token == session && state.value.upgrade.waiting) {
                change { copy(upgrade = upgrade.copy(waitingSince = 0L, note = ProUpgrade.WAIT_TIMED_OUT)) }
                persist()
            }
        }
    }

    /** The user stopped waiting. The sheet has already said not to pay again if the payment went through. */
    fun cancelUpgradeWait() {
        upgradePoll?.cancel(); upgradePoll = null
        change { copy(upgrade = upgrade.copy(waitingSince = 0L, note = ProUpgrade.WAIT_STOPPED)) }
        persist()
    }
    fun signOut() {
        ++accountGeneration
        accountWork?.cancel(); accountWork = null
        change { copy(busy = false) }
        cancelRecording()
        val session = token
        clearSession()
        change { copy(provider = SpeechProvider.ANDROID, notice = "Signed out on this device.") }; persist()
        if (session != null) scope.launch { runCatching { api.request("POST", "/auth/signout", session) } }
    }
    /** UI must present its own explicit destructive confirmation before calling. */
    fun deleteAccount() = accountOperation {
        val session = token ?: error("Sign in to delete your account.")
        api.request("DELETE", "/me", session)
        cancelRecording(); clearSession()
        change { copy(provider = SpeechProvider.ANDROID, history = emptyList(), dictionary = emptyList(), transcript = "", notice = "Your account and device history were deleted.") }; persist()
    }
    // Consent was given by the account that is leaving, so the next account on this phone is asked again.
    // A payment being waited for belonged to that account too.
    private fun clearSession() {
        token = null
        upgradePoll?.cancel(); upgradePoll = null
        change { copy(account = null, emailCodeSent = false, cloudConsent = false, upgrade = Upgrade()) }; persist()
    }

    /**
     * Starts a dictation from [source]. Returns false (with [AppState.error] set) when it could not start.
     * A flow-bar dictation passes the app it will type into as [target].
     */
    fun startRecording(source: DictationSource = DictationSource.APP, target: TargetApp? = null): Boolean {
        if (state.value.phase != RecordingPhase.IDLE) return false
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            reportError("Allow microphone access to start dictation."); return false
        }
        if (state.value.provider == SpeechProvider.CLOUD) {
            val account = state.value.account
            val usable = state.value.cloudConsent && token != null && account?.hasCloud == true
            if (!usable) {
                // A flow bar that refuses to listen is worse than a different engine: fall back to the phone's own.
                change { copy(provider = SpeechProvider.ANDROID, notice = when {
                    token == null -> "Signed out of Voxden Cloud. Using your phone's speech engine."
                    account?.isPro == false && account.trial.available -> "Your free cloud minutes are used up. Using your phone's speech engine."
                    else -> "Voxden Cloud isn't available on this account. Using your phone's speech engine."
                }) }
                persist()
            }
        }
        if (state.value.provider == SpeechProvider.ANDROID && FreeQuota.applies(state.value.account) &&
            FreeQuota.left(state.value.freeWords, System.currentTimeMillis()) <= 0) {
            reportError(FreeQuota.usedUpMessage(state.value.freeWords, System.currentTimeMillis(), needsPro = state.value.account?.hasCloud == false)); return false
        }
        if (state.value.provider == SpeechProvider.ANDROID && !SpeechRecognizer.isRecognitionAvailable(context)) {
            reportError("No speech recognition service is installed on this phone. Enable one in Android settings, or sign in to use Voxden Cloud."); return false
        }
        val generation = ++recordingGeneration
        recordingTarget = target
        recordingStartedAt = System.currentTimeMillis()
        change { copy(phase = RecordingPhase.RECORDING, recordingSource = source, elapsedSeconds = 0, audioLevel = 0f, partialTranscript = "", error = null) }
        try {
            if (state.value.provider == SpeechProvider.CLOUD) {
                pcm = PcmRecorder(scope) { level -> scope.launch {
                    if (generation == recordingGeneration && state.value.phase == RecordingPhase.RECORDING) change { copy(audioLevel = level) }
                } }.also { it.start() }
            } else startAndroidRecognition(generation)
            ticker = scope.launch {
                while (state.value.phase == RecordingPhase.RECORDING && generation == recordingGeneration) {
                    delay(1000)
                    change { copy(elapsedSeconds = elapsedSeconds + 1) }
                    val limit = if (state.value.provider == SpeechProvider.CLOUD) PcmRecorder.MAX_SECONDS else 90
                    if (state.value.elapsedSeconds >= limit) stopRecording()
                }
            }
        } catch (error: Exception) {
            cancelRecording(); reportError(friendlyError(error)); return false
        }
        return true
    }

    private fun startAndroidRecognition(generation: Int) {
        val speech = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = speech
        speech.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) = Unit
            override fun onBeginningOfSpeech() = Unit
            override fun onRmsChanged(rmsdB: Float) {
                if (generation == recordingGeneration && state.value.phase == RecordingPhase.RECORDING) {
                    change { copy(audioLevel = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)) }
                }
            }
            override fun onBufferReceived(buffer: ByteArray?) = Unit
            override fun onEndOfSpeech() {
                if (generation != recordingGeneration) return
                ticker?.cancel()
                change { copy(phase = RecordingPhase.PROCESSING, audioLevel = 0f) }
                startRecognitionTimeout(generation)
            }
            override fun onError(error: Int) {
                if (generation != recordingGeneration) return
                fail(speechError(error))
            }
            override fun onResults(results: Bundle?) {
                if (generation != recordingGeneration) return
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                completeTranscript(text, "Android speech")
            }
            override fun onPartialResults(partialResults: Bundle?) {
                if (generation == recordingGeneration) change { copy(partialTranscript = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()) }
            }
            override fun onEvent(eventType: Int, params: Bundle?) = Unit
        })
        speech.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, state.value.language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // A hint only; many speech services keep their own end-of-speech timing.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
        })
    }

    private fun startRecognitionTimeout(generation: Int) {
        recordingWork?.cancel()
        recordingWork = scope.launch {
            delay(20_000)
            if (generation == recordingGeneration) fail("Android speech did not return a result. Please try again.")
        }
    }
    fun stopRecording() {
        if (state.value.phase != RecordingPhase.RECORDING) return
        ticker?.cancel()
        change { copy(phase = RecordingPhase.PROCESSING, audioLevel = 0f) }
        val generation = recordingGeneration
        if (state.value.provider == SpeechProvider.ANDROID) {
            try { recognizer?.stopListening(); startRecognitionTimeout(generation) }
            catch (error: Exception) { fail(friendlyError(error)) }
            return
        }
        val recorder = pcm.also { pcm = null }
        val session = token
        val language = state.value.language.substringBefore('-')
        val terms = state.value.dictionary.toList()
        recordingWork = scope.launch {
            try {
                val wav = recorder?.finish() ?: error("No audio was recorded.")
                if (wav.size <= 44) error("No audio was recorded. Try speaking again.")
                if (session == null) error("Sign in to use Voxden Cloud.")
                val result = withTimeout(130_000) { api.request("POST", "/transcribe", session,
                    JSONObject().put("audio", Base64.encodeToString(wav, Base64.NO_WRAP)).put("format", "wav")
                        .put("language", language).put("terms", JSONArray(terms))) }
                if (generation == recordingGeneration) {
                    applyCloudMeter(result, session)
                    completeTranscript(result.optString("text"), "Voxden Cloud")
                }
            } catch (error: Exception) {
                if (error is CancellationException) {
                    if (generation == recordingGeneration) fail("The transcription timed out. Please try again.")
                    return@launch
                }
                if (generation == recordingGeneration) {
                    if (error is ApiException && error.status == 401) clearSession()
                    fail(friendlyError(error))
                }
            }
        }
    }

    /** Ends the dictation in progress without a result. A cancel the user asked for emits nothing. */
    fun cancelRecording() {
        ++recordingGeneration
        ticker?.cancel(); ticker = null
        recordingWork?.cancel(); recordingWork = null
        recognizer?.let { runCatching { it.cancel(); it.destroy() } }; recognizer = null
        val recorder = pcm.also { pcm = null }
        if (recorder != null) scope.launch { runCatching { recorder.finish() } }
        recordingTarget = null
        change { copy(phase = RecordingPhase.IDLE, recordingSource = null, partialTranscript = "", audioLevel = 0f) }
    }

    private fun fail(message: String) {
        val source = state.value.recordingSource ?: DictationSource.APP
        val target = recordingTarget
        cancelRecording()
        reportError(message)
        mutableResults.tryEmit(DictationResult(source, "", null, target, message))
    }

    private fun completeTranscript(text: String, providerName: String) {
        val source = state.value.recordingSource ?: DictationSource.APP
        val target = recordingTarget
        val seconds = ((System.currentTimeMillis() - recordingStartedAt) / 1000).toInt().coerceAtLeast(0)
        cancelRecording()
        // The writing style is applied here, once, so the typed text, the history entry, the clipboard copy, the
        // keyboard's preview and Polish's input are all the same string. The tone is the one chosen for the kind of
        // app the text is going into (WhatsApp, Slack, Gmail...); the voice keyboard and the Dictate bar have no
        // app to look at and use Other. With the style off nothing here loads the rules, and it fails open: a bug in
        // it must never lose a dictation. A dictation that styles down to nothing (only "um") is treated as no speech.
        val spoken = text.trim()
        val clean = DictationStyle.forDictation(spoken, state.value.writingStyle, target?.packageName, state.value.language, state.value.dictionary)
        if (DictationStyle.leavesNothing(spoken, clean)) {
            val message = "No speech was recognized. Try speaking closer to the microphone."
            reportError(message)
            mutableResults.tryEmit(DictationResult(source, "", null, target, message))
            return
        }
        val entry = HistoryEntry(UUID.randomUUID().toString(), clean, System.currentTimeMillis(), providerName,
            source, target?.packageName, target?.label, null, seconds)
        val saved = state.value.saveHistory
        change { copy(transcript = clean, history = if (saved) (listOf(entry) + history).take(HISTORY_LIMIT) else history) }
        if (providerName == "Android speech" && FreeQuota.applies(state.value.account)) countFreeWords(clean)
        persist()
        mutableResults.tryEmit(DictationResult(source, clean, if (saved) entry.id else null, target))
    }

    /** Free words left this week on the phone's engine; null when the account is not capped (Pro). */
    fun freeWordsLeft(now: Long = System.currentTimeMillis()): Int? =
        if (FreeQuota.applies(state.value.account)) FreeQuota.left(state.value.freeWords, now) else null

    private fun countFreeWords(text: String) {
        val now = System.currentTimeMillis()
        val before = FreeQuota.left(state.value.freeWords, now)
        val words = FreeQuota.add(state.value.freeWords, FreeQuota.countWords(text), now)
        val after = FreeQuota.left(words, now)
        change { copy(freeWords = words, notice = when {
            after <= 0 && before > 0 -> FreeQuota.usedUpMessage(words, now, needsPro = state.value.account?.hasCloud == false)
            after <= FreeQuota.WARN_AT && before > FreeQuota.WARN_AT -> "$after free words left this week."
            else -> notice
        }) }
        persist()
    }

    /**
     * Polishes [text] with Voxden Cloud and returns the polished text. [mode] is "polish", "grammar" or "tighten".
     * Throws an exception whose message is ready to show the user.
     */
    suspend fun polish(text: String, mode: String = "polish"): String {
        val clean = text.trim()
        if (clean.isEmpty()) throw IllegalStateException("There is nothing to polish.")
        if (!state.value.cloudConsent) throw IllegalStateException("Turn on Voxden Cloud to polish text.")
        if (state.value.account?.hasCloud != true) throw IllegalStateException("Polish uses Voxden Cloud minutes. Start your free trial or upgrade to Pro.")
        val session = token ?: throw IllegalStateException("Sign in to polish text.")
        try {
            val result = api.request("POST", "/polish", session, JSONObject().put("text", clean)
                .put("mode", if (mode in POLISH_MODES) mode else "polish").put("terms", JSONArray(state.value.dictionary)))
            applyCloudMeter(result, session)
            return result.optString("text").ifBlank { throw IllegalStateException("Polish came back empty. Try again.") }
        } catch (error: Exception) {
            if (error is CancellationException || error is IllegalStateException) throw error
            if (error is ApiException && error.status == 401) clearSession()
            throw IllegalStateException(friendlyError(error))
        }
    }

    /** Debug builds only: puts sample dictations in the list for screenshots and UI tests. */
    fun debugSeedHistory(entries: List<HistoryEntry>) {
        if (!com.voxden.android.BuildConfig.DEBUG) return
        change { copy(history = (entries + history).distinctBy { it.id }.take(HISTORY_LIMIT)) }; persist()
    }
    /** Debug builds only: finishes the dictation in progress as if [text] had been recognized. */
    fun debugFinishWith(text: String) {
        if (!com.voxden.android.BuildConfig.DEBUG || state.value.phase == RecordingPhase.IDLE) return
        completeTranscript(text, "Debug")
    }

    private fun applyCloudMeter(result: JSONObject, session: String) {
        if (token != session) return
        val meter = result.optJSONObject("cloud")
        val trial = result.optJSONObject("trial")
        if (meter == null && trial == null) return
        change { copy(account = account?.let { current -> current.copy(
            creditsUsed = meter?.optDouble("creditsUsed", current.creditsUsed) ?: current.creditsUsed,
            creditsCap = meter?.optDouble("creditsCap", current.creditsCap) ?: current.creditsCap,
            trial = trial?.let(::parseTrial) ?: current.trial
        ) }) }
        persist()
    }

    companion object {
        const val HISTORY_LIMIT = 500
        val POLISH_MODES = listOf("polish", "grammar", "tighten")
        @Volatile private var instance: AppController? = null
        fun get(context: Context): AppController = instance ?: synchronized(this) {
            instance ?: AppController(context.applicationContext).also { instance = it }
        }
        internal fun parseTrial(json: JSONObject) = Trial(
            credits = json.optDouble("credits", 0.0).takeIf { it.isFinite() } ?: 0.0,
            used = json.optDouble("used", 0.0).takeIf { it.isFinite() } ?: 0.0,
            available = json.optBoolean("available", false)
        )
        /**
         * Reads `GET /billing/options`: the first monthly Razorpay plan on offer, or the reason there is none.
         * An account the service could not place in a region is shown every region's plans; which one to charge
         * is then a guess, so nothing is offered rather than the wrong price.
         */
        internal fun parseOffer(json: JSONObject): Pair<ProOffer?, OfferBlock?> {
            if (json.optString("unavailable") == "country") return null to OfferBlock.COUNTRY
            val options = json.optJSONArray("options") ?: return null to OfferBlock.NOT_OPEN
            if (json.optString("region").isBlank() && options.length() > 1) return null to OfferBlock.NOT_OPEN
            for (i in 0 until options.length()) {
                val option = options.optJSONObject(i) ?: continue
                if (option.optString("provider") != "razorpay") continue
                val plans = option.optJSONArray("plans") ?: continue
                for (j in 0 until plans.length()) {
                    val plan = plans.optJSONObject(j) ?: continue
                    val label = plan.optString("label")
                    if (plan.optString("id") != "monthly" || label.isBlank()) continue
                    val hours = option.optDouble("cloudHoursCap", 0.0).takeIf { it.isFinite() } ?: 0.0
                    return ProOffer(label, option.optString("region").ifBlank { null }, hours.toInt()) to null
                }
            }
            return null to OfferBlock.NOT_OPEN
        }
        internal fun parseAccount(json: JSONObject): Account {
            val cloud = json.optJSONObject("cloud") ?: json
            return Account(json.optString("email"), json.optString("plan", "free"),
                cloud.optDouble("creditsUsed", 0.0), cloud.optDouble("creditsCap", 0.0),
                json.optJSONObject("trial")?.let(::parseTrial) ?: Trial())
        }
        /** One tone per context; a missing or unrecognised one keeps that context's default, so one bad entry spoils nothing else. */
        private fun restoreWritingStyle(json: JSONObject?): WritingStyleSettings {
            val defaults = WritingStyleSettings()
            fun tone(key: String, fallback: WritingTone): WritingTone =
                runCatching { WritingTone.valueOf(json?.optString(key).orEmpty()) }.getOrDefault(fallback)
            return WritingStyleSettings(
                enabled = json?.optBoolean("enabled", false) ?: false,
                personal = tone("personal", defaults.personal), work = tone("work", defaults.work),
                email = tone("email", defaults.email), other = tone("other", defaults.other)
            )
        }

        internal fun restoreState(json: JSONObject): AppState {
            val history = json.optJSONArray("history") ?: JSONArray()
            val dictionary = json.optJSONArray("dictionary") ?: JSONArray()
            val bar = json.optJSONObject("flowBar")
            val style = json.optJSONObject("writingStyle")
            return AppState(
                provider = runCatching { SpeechProvider.valueOf(json.optString("provider")) }.getOrDefault(SpeechProvider.ANDROID),
                language = json.optString("language", "en-US"), cloudConsent = json.optBoolean("consent"),
                saveHistory = json.optBoolean("saveHistory", true), account = json.optJSONObject("account")?.let { parseAccount(it) },
                dictionary = (0 until dictionary.length()).map { dictionary.optString(it) },
                history = (0 until history.length()).mapNotNull { i -> history.optJSONObject(i)?.let {
                    HistoryEntry(it.optString("id"), it.optString("text"), it.optLong("createdAt"), it.optString("provider"),
                        runCatching { DictationSource.valueOf(it.optString("source")) }.getOrDefault(DictationSource.APP),
                        it.optString("appPackage").ifBlank { null }, it.optString("appLabel").ifBlank { null },
                        it.optString("polished").ifBlank { null }, it.optInt("durationSeconds", 0))
                } },
                flowBar = FlowBarSettings(
                    side = runCatching { BarSide.valueOf(bar?.optString("side").orEmpty()) }.getOrDefault(BarSide.RIGHT),
                    offset = (bar?.optDouble("offset", 0.42) ?: 0.42).toFloat().coerceIn(0.08f, 0.85f),
                    alwaysShow = bar?.optBoolean("alwaysShow", false) ?: false,
                    haptics = bar?.optBoolean("haptics", true) ?: true
                ),
                // Off unless the saved data says otherwise, so an install from before the style existed behaves as it did.
                writingStyle = restoreWritingStyle(style),
                onboarded = json.optBoolean("onboarded", false),
                freeWords = json.optJSONObject("freeWords")?.let { FreeWords(it.optLong("periodStart", 0L), it.optInt("used", 0)) } ?: FreeWords(),
                upgrade = Upgrade(waitingSince = json.optLong("upgradeWaitingSince", 0L).coerceAtLeast(0L))
            )
        }
        private fun friendlyError(error: Exception): String = when (error) {
            is java.net.UnknownHostException -> "Cannot reach Voxden Cloud. Check your internet connection."
            is java.net.SocketTimeoutException -> "Voxden Cloud took too long to respond. Try again."
            is SecurityException -> "Android denied microphone access. Check Voxden's permissions."
            else -> error.message ?: "Something went wrong. Please try again."
        }
        private fun speechError(code: Int) = when (code) {
            SpeechRecognizer.ERROR_AUDIO -> "The microphone was interrupted. Please try again."
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Allow microphone access in Android settings."
            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Your phone's speech engine needs a connection. Check your network and try again."
            SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech was recognized. Try again a little closer to the microphone."
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Your phone's speech engine is busy. Wait a moment and try again."
            SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "This language isn't available in your phone's speech engine. Choose another language or install its speech pack."
            else -> "Your phone's speech engine could not finish (error $code). Try again."
        }
    }
}
