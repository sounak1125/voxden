@file:OptIn(ExperimentalComposeUiApi::class)

package com.voxden.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState
import com.voxden.android.services.FlowBarStatus
import kotlinx.coroutines.delay

private data class Toast(val message: String, val isError: Boolean, val id: Long)

/**
 * The whole app: onboarding until it is done, then three tabs with the Dictate capsule floating over them.
 * Every sheet is owned here so any screen can open any of them.
 */
@Composable
fun VoxdenApp(controller: AppController, actions: AppActions, setup: SetupStatus, dictateUi: DictateUi) {
    val raw by controller.state.collectAsStateWithLifecycle()
    val state = DebugHooks.display(raw)
    val connected by FlowBarStatus.connected.collectAsStateWithLifecycle()
    // Pro is bought on a web page this beta opens. The Play (release) build has the web checkout compiled off, and
    // an install from the Play Store is treated the same way, because Play requires Google Play Billing instead.
    val canSellPro = com.voxden.android.BuildConfig.WEB_CHECKOUT && !setup.installedFromStore
    LaunchedEffect(connected) { setup.refresh() }
    ObserveSetup(setup)
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { controller.refreshAccountQuietly(); setup.refresh() }
    val flowBarReady = setup.flowBar || connected
    val scope = rememberCoroutineScope()
    val polish = remember(controller) { PolishRunner(controller, scope) }

    var tab by rememberSaveable { mutableStateOf(Tab.DICTATIONS) }
    var onboardingStep by rememberSaveable { mutableIntStateOf(0) }
    var accountOpen by rememberSaveable { mutableStateOf(false) }
    var setupOpen by rememberSaveable { mutableStateOf(false) }
    var disclosureOpen by rememberSaveable { mutableStateOf(false) }
    var languageOpen by rememberSaveable { mutableStateOf(false) }
    var licencesOpen by rememberSaveable { mutableStateOf(false) }
    var detailId by rememberSaveable { mutableStateOf<String?>(null) }
    var searchOpen by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var toast by remember { mutableStateOf<Toast?>(null) }
    var toastCounter by remember { mutableLongStateOf(0L) }
    fun showToast(message: String, isError: Boolean) { toast = Toast(message, isError, ++toastCounter) }

    val trialOnboarding = !state.onboarded && onboardingStep == 3
    val finishOnboarding = { controller.setOnboarded(true); onboardingStep = 0 }

    // Messages from the controller: toasts, unless a sheet shows them inline.
    val sheetShowsMessages = accountOpen || trialOnboarding || detailId != null
    LaunchedEffect(state.error, state.notice, sheetShowsMessages) {
        val message = state.error ?: state.notice
        if (!sheetShowsMessages && !message.isNullOrBlank()) {
            showToast(message, state.error != null)
            controller.clearMessage()
        }
    }
    LaunchedEffect(toast?.id) { if (toast != null) { delay(3800); toast = null } }
    LaunchedEffect(polish.failure?.seq) {
        val failure = polish.failure
        if (failure != null && detailId == null) { showToast(failure.message, true); polish.clearFailure() }
    }
    LaunchedEffect(dictateUi.flash?.id) {
        val flash = dictateUi.flash ?: return@LaunchedEffect
        delay(if (flash.mode == com.voxden.android.ui.island.IslandMode.DONE) 2000 else 2600)
        dictateUi.clear(flash.id)
    }
    // Debug builds: a command from an intent can open a tab or sheet for screenshots.
    val request = DebugHooks.request
    LaunchedEffect(request?.nonce) {
        request ?: return@LaunchedEffect
        request.tab?.let { name -> Tab.entries.firstOrNull { it.name.equals(name, ignoreCase = true) }?.let { tab = it } }
        request.step?.let { onboardingStep = it }
        request.search?.let { searchOpen = true; query = it }
        request.toast?.let { showToast(it, false) }
        request.sheet?.let { name ->
            accountOpen = name == "account"; setupOpen = name == "setup"; disclosureOpen = name == "disclosure"
            languageOpen = name == "language"; licencesOpen = name == "licences"
            detailId = if (name.startsWith("detail")) "debug-${(name.removePrefix("detail").toIntOrNull() ?: 0) + 1}" else null
        }
        DebugHooks.request = null
    }

    CompositionLocalProvider(LocalHapticsEnabled provides state.flowBar.haptics) {
        Box(Modifier.fillMaxSize().background(Vox.canvas).semantics { testTagsAsResourceId = true }) {
            if (!state.onboarded) {
                OnboardingFlow(
                    step = onboardingStep, onStep = { onboardingStep = it }, status = setup, actions = actions,
                    onTypeForYou = { disclosureOpen = true }
                )
            } else {
                Shell(
                    state = state, controller = controller, actions = actions, flowBarReady = flowBarReady, dictateUi = dictateUi,
                    canSellPro = canSellPro, polish = polish, tab = tab, onTab = { tab = it },
                    searchOpen = searchOpen, onSearchOpen = { searchOpen = it }, query = query, onQuery = { query = it },
                    onOpenAccount = { accountOpen = true }, onOpenSetup = { setupOpen = true }, onOpenLanguage = { languageOpen = true },
                    onOpenLicences = { licencesOpen = true }, onOpenDetail = { detailId = it }
                )
            }
            AnimatedVisibility(
                visible = licencesOpen, modifier = Modifier.fillMaxSize(),
                enter = slideInHorizontally(VoxMotion.spring<IntOffset>()) { it } + fadeIn(VoxMotion.spring()),
                exit = slideOutHorizontally(VoxMotion.spring<IntOffset>()) { it } + fadeOut(tween(120))
            ) {
                BackHandler { licencesOpen = false }
                LicencesScreen(onBack = { licencesOpen = false })
            }
            ToastHost(toast, Modifier.align(Alignment.TopCenter))
        }

        if (accountOpen || trialOnboarding) {
            AccountSheet(state, controller, onDismiss = { if (trialOnboarding) finishOnboarding() else accountOpen = false },
                onSkip = if (trialOnboarding) finishOnboarding else null,
                canSell = canSellPro, onUpgrade = { controller.startUpgrade(actions::openUrl) })
        }
        if (setupOpen) SetupSheet(
            status = setup, onMicrophone = actions::requestMicrophone, onTypeForYou = { disclosureOpen = true },
            onNotifications = actions::requestNotifications, onAppInfo = actions::openAppInfo, onDismiss = { setupOpen = false }
        )
        if (disclosureOpen) AccessibilityDisclosureSheet(
            onAgree = { disclosureOpen = false; actions.openAccessibilitySettings() },
            onDismiss = { disclosureOpen = false }
        )
        if (languageOpen) LanguageSheet(state.language, controller) { languageOpen = false }
        detailId?.let { id ->
            DetailSheet(id, state, controller, actions, polish, onOpenAccount = { accountOpen = true }, onDismiss = { detailId = null })
        }
    }
}

@Composable
private fun Shell(
    state: AppState,
    controller: AppController,
    actions: AppActions,
    flowBarReady: Boolean,
    dictateUi: DictateUi,
    canSellPro: Boolean,
    polish: PolishRunner,
    tab: Tab,
    onTab: (Tab) -> Unit,
    searchOpen: Boolean,
    onSearchOpen: (Boolean) -> Unit,
    query: String,
    onQuery: (String) -> Unit,
    onOpenAccount: () -> Unit,
    onOpenSetup: () -> Unit,
    onOpenLanguage: () -> Unit,
    onOpenLicences: () -> Unit,
    onOpenDetail: (String) -> Unit
) {
    val density = LocalDensity.current
    val imeVisible = WindowInsets.ime.getBottom(density) > 0
    val navInset = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val haptic = rememberHaptics()
    val homeList = rememberLazyListState()
    val dictionaryList = rememberLazyListState()
    val settingsList = rememberLazyListState()

    BackHandler(enabled = searchOpen && tab == Tab.DICTATIONS) { onQuery(""); onSearchOpen(false) }
    BackHandler(enabled = tab != Tab.DICTATIONS && !(searchOpen && tab == Tab.DICTATIONS)) { onTab(Tab.DICTATIONS) }

    Box(Modifier.fillMaxSize().imePadding()) {
        Column(Modifier.fillMaxSize()) {
            val scrolled = when (tab) {
                Tab.DICTATIONS -> homeList.canScrollBackward
                Tab.DICTIONARY -> dictionaryList.canScrollBackward
                Tab.SETTINGS -> settingsList.canScrollBackward
            }
            TopBar(planText = planChipText(state.account, if (state.provider == com.voxden.android.core.SpeechProvider.ANDROID) controller.freeWordsLeft() else null), signedIn = state.account != null, onPlan = onOpenAccount, onAccount = onOpenAccount, showDivider = scrolled)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                AnimatedContent(
                    targetState = tab, modifier = Modifier.fillMaxSize(),
                    transitionSpec = {
                        val dir = if (targetState.ordinal > initialState.ordinal) 1 else -1
                        (fadeIn(VoxMotion.spring()) + slideInHorizontally(VoxMotion.spring<IntOffset>()) { dir * it / 14 }) togetherWith
                            (fadeOut(tween(110)) + slideOutHorizontally(VoxMotion.spring<IntOffset>()) { -dir * it / 14 })
                    },
                    label = "tabs"
                ) { current ->
                    when (current) {
                        Tab.DICTATIONS -> HomeScreen(
                            state = state, listState = homeList, controller = controller, actions = actions, flowBarReady = flowBarReady,
                            polish = polish, query = query, onQuery = onQuery, searchOpen = searchOpen, onSearchOpen = onSearchOpen,
                            onOpenSetup = onOpenSetup, onOpenDetail = onOpenDetail, onOpenAccount = onOpenAccount, modifier = Modifier.fillMaxSize()
                        )
                        Tab.DICTIONARY -> DictionaryScreen(state, controller, dictionaryList, Modifier.fillMaxSize())
                        Tab.SETTINGS -> SettingsScreen(
                            state = state, controller = controller, actions = actions, flowBarReady = flowBarReady, listState = settingsList,
                            onOpenSetup = onOpenSetup, onOpenAccount = onOpenAccount, onOpenLanguage = onOpenLanguage,
                            onOpenLicences = onOpenLicences, canSellPro = canSellPro, modifier = Modifier.fillMaxSize()
                        )
                    }
                }
            }
            AnimatedVisibility(
                visible = !imeVisible,
                enter = fadeIn(VoxMotion.spring()) + slideInVertically(VoxMotion.spring<IntOffset>()) { it / 2 },
                exit = fadeOut(tween(80)) + slideOutVertically(tween(80)) { it / 2 }
            ) { BottomNav(tab, onTab) }
        }
        val showLabel = tab == Tab.DICTATIONS && !imeVisible && !searchOpen
        DictateBar(
            state = state, flash = dictateUi.flash, showLabel = showLabel,
            onTap = { haptic(Haptic.CONFIRM); actions.startDictation() },
            onCancel = { haptic(Haptic.TICK); controller.cancelRecording() },
            onStop = { haptic(Haptic.TICK); controller.stopRecording() },
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = (if (imeVisible) 0.dp else NavBarHeight + navInset) + 16.dp)
        )
    }
}

@Composable
private fun ToastHost(toast: Toast?, modifier: Modifier = Modifier) {
    val last = remember { arrayOfNulls<Toast>(1) }
    if (toast != null) last[0] = toast
    AnimatedVisibility(
        visible = toast != null, modifier = modifier.statusBarsPadding().padding(top = 64.dp, start = 16.dp, end = 16.dp),
        enter = fadeIn(VoxMotion.spring()) + slideInVertically(VoxMotion.spring<IntOffset>()) { -it },
        exit = fadeOut(tween(160)) + slideOutVertically(tween(160)) { -it / 2 }
    ) {
        last[0]?.let { VoxToast(it.message, it.isError) }
    }
}
