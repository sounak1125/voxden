package com.voxden.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.core.Account
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState
import com.voxden.android.core.SpeechProvider
import kotlinx.coroutines.delay

private const val DisclosureLine = "Your audio is sent to Voxden to be transcribed."
private const val ProOnlyLine = "Voxden Cloud is part of Pro. Pro is available on voxden.app."

/** The account and free-trial sheet: sign in with an email code, start the trial, see minutes left, sign out. */
@Composable
fun AccountSheet(state: AppState, controller: AppController, onDismiss: () -> Unit, onSkip: (() -> Unit)? = null) {
    val haptic = rememberHaptics()
    var email by rememberSaveable { mutableStateOf(DebugHooks.codeSentEmail.orEmpty()) }
    var code by rememberSaveable { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    var keepMessage by remember { mutableStateOf(false) }
    val mode = accountMode(state.account)
    LaunchedEffect(Unit) { controller.refreshAccountQuietly() }
    DisposableEffect(Unit) { onDispose { if (!keepMessage) controller.clearMessage() } }
    LaunchedEffect(state.emailCodeSent) { if (!state.emailCodeSent) code = "" }

    VoxSheet(onDismiss) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 24.dp)
                .testTag("account-sheet")
        ) {
            when (mode) {
                AccountMode.SIGNED_OUT -> SignedOut(state, email, { email = it }, code, { code = it }, controller)
                AccountMode.TRIAL -> CloudOffer(state, state.account!!, controller, onDismiss, haptic)
                AccountMode.PRO -> CloudOffer(state, state.account!!, controller, onDismiss, haptic)
                AccountMode.TRIAL_USED -> {
                    Text("Your free minutes are used.", style = VoxType.title)
                    Spacer(Modifier.height(8.dp))
                    EmailLine(state.account!!)
                    Spacer(Modifier.height(8.dp))
                    Text("$ProOnlyLine Your phone's speech engine gives you 1,000 free words a week.", style = VoxType.body.copy(color = Vox.text2))
                }
                AccountMode.CLOUD_NOT_OFFERED -> {
                    Text("Your account", style = VoxType.title)
                    Spacer(Modifier.height(8.dp))
                    EmailLine(state.account!!)
                    Spacer(Modifier.height(8.dp))
                    Text(ProOnlyLine, style = VoxType.body.copy(color = Vox.text2))
                }
            }
            val message = state.error ?: state.notice?.takeIf { mode == AccountMode.SIGNED_OUT }
            if (message != null) {
                Spacer(Modifier.height(16.dp))
                Text(message, style = VoxType.bodySmall.copy(fontSize = 14.sp, color = if (state.error != null) Vox.danger else Vox.text2), modifier = Modifier.testTag("account-message"))
            }
            if (state.account != null) {
                Spacer(Modifier.height(20.dp))
                Box(Modifier.fillMaxWidth().height(1.dp).background(Vox.hairline))
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextAction("Sign out", { keepMessage = true; controller.signOut(); haptic(Haptic.TICK); onDismiss() }, Modifier.testTag("sign-out"))
                    TextAction("Delete account", { confirmDelete = true }, color = Vox.danger)
                }
            }
            // First run: say plainly that the trial can wait and the phone's own engine works now.
            if (onSkip != null) {
                Spacer(Modifier.height(4.dp))
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    TextAction("Not now, use my phone's speech engine", onSkip, Modifier.testTag("trial-skip"))
                }
            }
        }
    }
    if (confirmDelete) VoxDialog(
        title = "Delete your account?", body = "Your Voxden account and this device's history are deleted. This also affects the desktop app, and can't be undone.",
        confirmLabel = "Delete account", onDismiss = { confirmDelete = false },
        onConfirm = { confirmDelete = false; controller.deleteAccount() }
    )
}

@Composable
private fun EmailLine(account: Account) {
    if (account.email.isNotBlank()) Text(account.email, style = VoxType.bodySmall.copy(fontSize = 15.sp), maxLines = 1)
}

@Composable
private fun CheckLine(text: String) {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Box(Modifier.padding(top = 1.dp).size(22.dp).background(Vox.surface, CircleShape).border(1.dp, Vox.hairline, CircleShape), contentAlignment = Alignment.Center) {
            Icon(Icons.Rounded.Check, null, Modifier.size(14.dp), tint = Vox.text2)
        }
        Text(text, style = VoxType.body.copy(fontSize = 15.sp, lineHeight = 24.sp))
    }
}

@Composable
private fun TrialPitch() {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        CheckLine("Your dictionary words spelled right")
        CheckLine("Polish any dictation")
        CheckLine("After that, 1,000 free words a week on your phone's speech engine")
    }
}

@Composable
private fun SignedOut(state: AppState, email: String, onEmail: (String) -> Unit, code: String, onCode: (String) -> Unit, controller: AppController) {
    val codeFocus = remember { FocusRequester() }
    LaunchedEffect(state.emailCodeSent) { if (state.emailCodeSent) { delay(150); runCatching { codeFocus.requestFocus() } } }
    val validEmail = email.trim().let { it.contains('@') && it.substringAfter('@').contains('.') }
    Text("Try Voxden Cloud free", style = VoxType.title)
    Spacer(Modifier.height(8.dp))
    Text("60 minutes of our best speech model. No card.", style = VoxType.body.copy(color = Vox.text2))
    Spacer(Modifier.height(22.dp))
    TrialPitch()
    Spacer(Modifier.height(26.dp))
    if (!state.emailCodeSent) {
        VoxField(
            value = email, onValueChange = onEmail, placeholder = "you@example.com", container = Vox.surface,
            modifier = Modifier.testTag("email-field"),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (validEmail && !state.busy) controller.sendCode(email) })
        )
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Send code", { controller.sendCode(email) }, Modifier.testTag("send-code"), enabled = validEmail, loading = state.busy)
    } else {
        Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Code sent to", style = VoxType.meta)
                Text(email.trim(), style = VoxType.bodySmall.copy(color = Vox.text, fontSize = 15.sp), maxLines = 1)
            }
            TextAction("Change", controller::cancelCode)
        }
        Spacer(Modifier.height(14.dp))
        CodeField(code, onCode, codeFocus, onDone = { if (code.length == 6 && !state.busy) controller.verifyCode(email, code) })
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Verify", { controller.verifyCode(email, code) }, Modifier.testTag("verify-code"), enabled = code.length == 6, loading = state.busy)
        Spacer(Modifier.height(4.dp))
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            TextAction("Send a new code", { controller.sendCode(email) }, enabled = !state.busy)
        }
    }
}

/** The six digit boxes. One hidden text field takes the input; the boxes only draw it. */
@Composable
private fun CodeField(code: String, onChange: (String) -> Unit, focus: FocusRequester, onDone: () -> Unit) {
    BasicTextField(
        value = code, onValueChange = { onChange(it.filter(Char::isDigit).take(6)) },
        modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("code-field").semantics { contentDescription = "Six-digit code" },
        singleLine = true, cursorBrush = SolidColor(Color.Transparent),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        decorationBox = {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                repeat(6) { i ->
                    val current = i == code.length.coerceAtMost(5)
                    Box(
                        Modifier.weight(1f).height(58.dp).background(Vox.surface, RoundedCornerShape(16.dp))
                            .border(1.dp, if (current) Vox.hairlineStrong else Vox.hairline, RoundedCornerShape(16.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(code.getOrNull(i)?.toString() ?: "", style = VoxType.title.copy(fontSize = 24.sp), textAlign = TextAlign.Center)
                    }
                }
            }
        }
    )
}

/** Trial or Pro: minutes left, the one-line disclosure, and the button (or switch) that turns Voxden Cloud on. */
@Composable
private fun CloudOffer(state: AppState, account: Account, controller: AppController, onDismiss: () -> Unit, haptic: (Haptic) -> Unit) {
    val pro = account.isPro
    val using = state.provider == SpeechProvider.CLOUD && state.cloudConsent
    val firstTime = !pro && account.trial.used <= 0.0
    Text(
        when { pro -> proHeadline(account); using -> "Voxden Cloud is on"; else -> "Try Voxden Cloud free" },
        style = VoxType.title
    )
    Spacer(Modifier.height(8.dp))
    if (pro) EmailLine(account)
    else Text(if (using) "Your free trial." else "60 minutes of our best speech model. No card.", style = VoxType.body.copy(color = Vox.text2))
    Spacer(Modifier.height(22.dp))
    if (pro && account.creditsCap > 0.0) {
        val left = formatMinutes(account.cloudMinutesLeft).split(' ')
        Meter(left[0], "${left[1]} left", "of ${formatMinutes(account.creditsCap)} this month",
            1f - usedFraction(account.creditsUsed, account.creditsCap))
        Spacer(Modifier.height(10.dp))
        Text("${(account.cloudMinutesLeft).toInt()} of ${account.creditsCap.toInt()} credits left. One credit is a minute of audio.",
            style = VoxType.bodySmall.copy(fontSize = 13.sp, lineHeight = 19.sp, color = Vox.text3), modifier = Modifier.padding(horizontal = 4.dp))
    } else if (!pro) {
        val left = formatTrialMinutes(account.trial.left).split(' ')
        Meter(left[0], "${left[1]} left", "of ${formatTrialMinutes(account.trial.credits)}", 1f - usedFraction(account.trial.used, account.trial.credits))
        if (!using) { Spacer(Modifier.height(22.dp)); TrialPitch() }
    }
    Spacer(Modifier.height(26.dp))
    if (using) {
        Row(
            Modifier.fillMaxWidth().background(Vox.surface, RoundedCornerShape(18.dp)).border(1.dp, Vox.hairline, RoundedCornerShape(18.dp))
                .padding(start = 18.dp, end = 14.dp).height(60.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Use Voxden Cloud", Modifier.weight(1f), style = VoxType.bodyMedium)
            VoxSwitch(true, { if (!it) controller.setProvider(SpeechProvider.ANDROID) }, Modifier.testTag("cloud-switch"))
        }
    } else {
        Text(DisclosureLine, style = VoxType.bodySmall.copy(fontSize = 14.sp, color = Vox.text2), modifier = Modifier.padding(horizontal = 4.dp))
        Spacer(Modifier.height(14.dp))
        PrimaryButton(if (firstTime) "Start my free trial" else "Use Voxden Cloud",
            { controller.startCloud(); haptic(Haptic.CONFIRM); if (controller.state.value.provider == SpeechProvider.CLOUD) onDismiss() },
            Modifier.testTag("start-cloud"), haptic = null)
    }
}

@Composable
private fun Meter(value: String, unit: String, of: String, remaining: Float) {
    Column(Modifier.fillMaxWidth().background(Vox.surface, Vox.card).border(1.dp, Vox.hairline, Vox.card).padding(18.dp)) {
        Row(verticalAlignment = Alignment.Bottom) {
            Text(value, style = VoxType.display.copy(fontSize = 34.sp, lineHeight = 38.sp, fontFeatureSettings = "tnum"))
            Spacer(Modifier.width(8.dp))
            Text(unit, Modifier.padding(bottom = 4.dp), style = VoxType.body.copy(color = Vox.text2))
            Spacer(Modifier.weight(1f))
            Text(of, Modifier.padding(bottom = 5.dp), style = VoxType.meta)
        }
        Spacer(Modifier.height(14.dp))
        ThinProgress(remaining)
    }
}
