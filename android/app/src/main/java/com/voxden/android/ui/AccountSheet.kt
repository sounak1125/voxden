package com.voxden.android.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalTextToolbar
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.core.Account
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState
import com.voxden.android.core.OfferBlock
import com.voxden.android.core.ProUpgrade
import com.voxden.android.core.SpeechProvider
import kotlinx.coroutines.delay

private const val DisclosureLine = "Your audio is sent to Voxden to be transcribed."
private const val ProOnlyLine = "Voxden Cloud is part of Pro."

/**
 * The account and free-trial sheet: sign in with an email code, start the trial, see minutes left, sign out.
 * With [canSell] it also offers Pro (the Upgrade button calls [onUpgrade]); a Play Store install passes false
 * until Google Play Billing replaces the web checkout.
 */
@Composable
fun AccountSheet(
    state: AppState, controller: AppController, onDismiss: () -> Unit, onSkip: (() -> Unit)? = null,
    canSell: Boolean = false, onUpgrade: () -> Unit = {}
) {
    val haptic = rememberHaptics()
    var email by rememberSaveable { mutableStateOf(DebugHooks.codeSentEmail ?: state.codeSentTo) }
    var code by rememberSaveable { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    var keepMessage by remember { mutableStateOf(false) }
    val mode = accountMode(state.account)
    LaunchedEffect(Unit) { controller.refreshAccountQuietly() }
    // The price is asked for once an account is signed in, so it is there before the button is tapped.
    LaunchedEffect(canSell, state.account?.email) { if (canSell && state.account != null) controller.loadProOffer() }
    DisposableEffect(Unit) { onDispose { if (!keepMessage) controller.clearMessage() } }
    LaunchedEffect(state.emailCodeSent) { if (!state.emailCodeSent) code = "" }

    VoxSheet(onDismiss) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 24.dp)
                .testTag("account-sheet")
        ) {
            when (mode) {
                AccountMode.SIGNED_OUT -> SignedOut(state, email, { email = it }, code, { code = it }, controller)
                AccountMode.TRIAL -> {
                    CloudOffer(state, state.account!!, controller, onDismiss, haptic)
                    // No need to use up the trial first: Pro can be bought now.
                    if (canSell) {
                        Spacer(Modifier.height(14.dp))
                        UpgradePanel(state, controller, onUpgrade, primary = false)
                    }
                }
                AccountMode.PRO -> {
                    CloudOffer(state, state.account!!, controller, onDismiss, haptic)
                    // Renewal can't be seen or ended from this app yet, so say where it can.
                    Spacer(Modifier.height(14.dp))
                    Text(
                        "Renewal is managed in Plans & billing in the Voxden desktop app.",
                        style = VoxType.bodySmall.copy(fontSize = 14.sp, color = Vox.text2), modifier = Modifier.padding(horizontal = 4.dp)
                    )
                }
                AccountMode.TRIAL_USED -> {
                    Text("Your free minutes are used.", style = VoxType.title)
                    Spacer(Modifier.height(8.dp))
                    EmailLine(state.account!!)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        if (canSell) "Voxden Pro brings Voxden Cloud back. Your phone's speech engine still gives you 1,000 free words a week."
                        else "$ProOnlyLine Your phone's speech engine gives you 1,000 free words a week.",
                        style = VoxType.body.copy(color = Vox.text2)
                    )
                    if (canSell) {
                        Spacer(Modifier.height(20.dp))
                        UpgradePanel(state, controller, onUpgrade, primary = true)
                    }
                }
                AccountMode.CLOUD_NOT_OFFERED -> {
                    Text("Your account", style = VoxType.title)
                    Spacer(Modifier.height(8.dp))
                    EmailLine(state.account!!)
                    Spacer(Modifier.height(8.dp))
                    Text(ProOnlyLine, style = VoxType.body.copy(color = Vox.text2))
                    if (canSell) {
                        Spacer(Modifier.height(20.dp))
                        UpgradePanel(state, controller, onUpgrade, primary = true)
                    }
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
        title = "Delete your account?",
        body = "Your Voxden account and this device's history are deleted, and any Pro subscription is cancelled first. This also affects the desktop app, and can't be undone.",
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
    val context = LocalContext.current
    // Fills the boxes from the clipboard when it holds a six-digit code (the email's own code, copied from the message).
    val pasteCode: () -> Unit = {
        val found = pastedCode(clipboardText(context))
        if (found != null) { controller.clearMessage(); onCode(found) }
        else controller.reportError("There is no six-digit code on the clipboard. Copy the code from your email first.")
    }
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
        CodeField(code, onCode, codeFocus, onPaste = pasteCode, onDone = { if (code.length == 6 && !state.busy) controller.verifyCode(email, code) })
        Spacer(Modifier.height(14.dp))
        PrimaryButton("Verify", { controller.verifyCode(email, code) }, Modifier.testTag("verify-code"), enabled = code.length == 6, loading = state.busy)
        Spacer(Modifier.height(4.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            TextAction("Paste code", pasteCode, Modifier.testTag("paste-code"), enabled = !state.busy)
            TextAction("Send a new code", { controller.sendCode(email) }, enabled = !state.busy)
        }
    }
}

/**
 * The six digit boxes, over a real text field that takes the typing from the keyboard.
 *
 * The text field is invisible and underneath the boxes (the same size, so Android keeps all of them above the
 * keyboard), so a finger can only ever reach the boxes. That
 * matters: a text field handles a long press itself (it starts a text selection and asks Android for its floating
 * Cut / Copy / Paste menu, worked out from a text layout), and this one has no visible text to select. Holding the
 * boxes used to start that as well as pasting, and the app closed. Now the boxes do all of it themselves: a tap puts
 * the cursor in (a blinking bar in the next empty box) and brings the keyboard up even after it was dismissed, and
 * holding them pastes the code from the clipboard through [onPaste]. The field is also given [NoTextToolbar], so
 * nothing, not even an accessibility action, can open Android's menu from it.
 *
 * Whatever the keyboard puts in (a digit, or a whole copied message from its clipboard suggestion) goes
 * through [codeAfterInput], so the boxes only ever hold the code.
 */
@Composable
private fun CodeField(code: String, onChange: (String) -> Unit, focus: FocusRequester, onPaste: () -> Unit, onDone: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    val blink by rememberInfiniteTransition(label = "caret").animateFloat(
        initialValue = 1f, targetValue = 0f, label = "caretAlpha",
        animationSpec = infiniteRepeatable(tween(530, easing = LinearEasing), RepeatMode.Reverse)
    )
    // The caret is always at the end: the field only ever takes digits there, and a pasted code replaces what was
    // typed. (Given as a plain string, Compose keeps the old caret, which stayed at the front after a paste, so
    // Backspace did nothing and a typed digit went in at the start.)
    val value = remember(code) { TextFieldValue(code, TextRange(code.length)) }
    Box(Modifier.fillMaxWidth()) {
        CompositionLocalProvider(LocalTextToolbar provides NoTextToolbar) {
            BasicTextField(
                value = value, onValueChange = { onChange(codeAfterInput(code, it.text)) },
                modifier = Modifier.matchParentSize().alpha(0f).focusRequester(focus).onFocusChanged { focused = it.isFocused },
                singleLine = true, cursorBrush = SolidColor(Color.Transparent),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { onDone() })
            )
        }
        Pressable(
            onClick = { focus.requestFocus(); keyboard?.show() },
            onLongClick = onPaste,
            modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "Six-digit code" }.testTag("code-field"),
            shape = RectangleShape, color = Color.Transparent, pressedColor = Color.Transparent, border = null, role = null
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                repeat(6) { i ->
                    val current = i == code.length.coerceAtMost(5)
                    Box(
                        Modifier.weight(1f).height(58.dp).background(Vox.surface, RoundedCornerShape(16.dp))
                            .border(1.dp, if (current) Vox.hairlineStrong else Vox.hairline, RoundedCornerShape(16.dp)),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(code.getOrNull(i)?.toString() ?: "", style = VoxType.title.copy(fontSize = 24.sp), textAlign = TextAlign.Center)
                        // The cursor: a blinking bar in the box the next digit goes into.
                        if (current && focused && code.length < 6) {
                            Box(Modifier.width(2.dp).height(26.dp).graphicsLayer { alpha = blink }.background(Vox.mint, RoundedCornerShape(1.dp)))
                        }
                    }
                }
            }
        }
    }
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

/**
 * Buy Pro: the Upgrade button, with the price under it, or, once the payment page is open, the wait for the
 * payment. The button works only once the price is on screen; it first shows the price and what happens next,
 * and only Continue asks the account service for the payment page. While a payment may be on its way, and
 * after the wait ends, the panel says not to pay again.
 */
@Composable
private fun UpgradePanel(state: AppState, controller: AppController, onUpgrade: () -> Unit, primary: Boolean) {
    val upgrade = state.upgrade
    var confirm by remember { mutableStateOf(false) }
    val small = VoxType.bodySmall.copy(fontSize = 14.sp, color = Vox.text2)
    Column(Modifier.fillMaxWidth()) {
        when {
            upgrade.blocked != null -> Text(
                if (upgrade.blocked == OfferBlock.COUNTRY) "Voxden Pro isn't sold in your country yet." else "Payments for Pro aren't open yet.",
                style = small, modifier = Modifier.padding(horizontal = 4.dp).testTag("upgrade-blocked")
            )
            upgrade.waiting -> {
                if (primary) PrimaryButton("Confirming payment…", {}, Modifier.testTag("upgrade-waiting"), enabled = false)
                else SecondaryButton("Confirming payment…", {}, Modifier.testTag("upgrade-waiting"), enabled = false)
                Spacer(Modifier.height(10.dp))
                Text(
                    "Finish paying in your browser, then come back to Voxden. Pro switches on here by itself once the payment " +
                        "goes through. If you've already paid, don't pay again.",
                    style = small, modifier = Modifier.padding(horizontal = 4.dp)
                )
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    TextAction("Stop waiting", controller::cancelUpgradeWait, Modifier.testTag("upgrade-cancel"))
                }
            }
            else -> {
                val ready = upgrade.offer != null
                if (primary) PrimaryButton("Upgrade to Pro", { confirm = true }, Modifier.testTag("upgrade-pro"), enabled = ready && !state.busy, loading = state.busy)
                else SecondaryButton("Upgrade to Pro", { confirm = true }, Modifier.testTag("upgrade-pro"), enabled = ready && !state.busy)
                Spacer(Modifier.height(10.dp))
                val offer = upgrade.offer
                when {
                    offer != null -> Text(ProUpgrade.offerLine(offer), style = small, modifier = Modifier.padding(horizontal = 4.dp).testTag("upgrade-price"))
                    upgrade.offerFailed -> {
                        Text("Couldn't load the price.", style = small, modifier = Modifier.padding(horizontal = 4.dp).testTag("upgrade-price-failed"))
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                            TextAction("Try again", controller::loadProOffer, Modifier.testTag("upgrade-retry"))
                        }
                    }
                    else -> Text("Checking the price…", style = small, modifier = Modifier.padding(horizontal = 4.dp).testTag("upgrade-checking"))
                }
            }
        }
        upgrade.note?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, style = small, modifier = Modifier.padding(horizontal = 4.dp).testTag("upgrade-note"))
            if (!upgrade.waiting) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    TextAction("Check again", controller::refreshAccountQuietly, Modifier.testTag("upgrade-check"))
                }
            }
        }
    }
    if (confirm) {
        val price = upgrade.offer?.let { ProUpgrade.offerLine(it) + ".\n\n" }.orEmpty()
        VoxDialog(
            title = "Upgrade to Pro",
            body = price + "You'll finish paying on a secure Razorpay page in your browser, and Voxden switches Pro on here once the " +
                "payment goes through. Pro renews every month until you cancel it in Plans & billing in the Voxden desktop app.",
            confirmLabel = "Continue", dismissLabel = "Not now", destructive = false,
            onDismiss = { confirm = false }, onConfirm = { confirm = false; onUpgrade() }
        )
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
