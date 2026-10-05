@file:OptIn(ExperimentalFoundationApi::class)

package com.voxden.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.OpenInNew
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PhoneAndroid
import androidx.compose.material.icons.rounded.Cloud
import androidx.compose.material.icons.rounded.PrivacyTip
import androidx.compose.material.icons.rounded.Security
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material.icons.rounded.Vibration
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.BuildConfig
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState
import com.voxden.android.core.BarSide
import com.voxden.android.core.SpeechProvider

private const val PrivacyUrl = "https://voxden.app/privacy"

@Composable
fun SettingsScreen(
    state: AppState,
    controller: AppController,
    actions: AppActions,
    flowBarReady: Boolean,
    listState: LazyListState,
    onOpenSetup: () -> Unit,
    onOpenAccount: () -> Unit,
    onOpenLanguage: () -> Unit,
    onOpenLicences: () -> Unit,
    canSellPro: Boolean = false,
    modifier: Modifier = Modifier
) {
    var confirmClear by rememberSaveable { mutableStateOf(false) }
    var tryKeyboard by rememberSaveable { mutableStateOf("") }
    val account = state.account
    val haptic = rememberHaptics()
    LazyColumn(modifier, state = listState, contentPadding = PaddingValues(bottom = 40.dp)) {
        item(key = "header") {
            Box(Modifier.fillMaxWidth().padding(start = Vox.gutter, end = Vox.gutter, top = 6.dp, bottom = 20.dp).height(48.dp), contentAlignment = Alignment.CenterStart) {
                Text("Settings", style = VoxType.display)
            }
        }
        item(key = "flow-bar") {
            Section("Flow bar") {
                SettingsRow(
                    title = "Flow bar", icon = Icons.Rounded.GraphicEq, onClick = onOpenSetup, chevron = true,
                    subtitle = if (flowBarReady) "Shows while you type." else "Turn it on to dictate in any app.",
                    modifier = Modifier.testTag("settings-flow-bar"),
                    trailing = { StatusValue(flowBarReady, if (flowBarReady) "On" else "Off") }
                )
                GroupDivider()
                SettingsRow(title = "Side", icon = Icons.Rounded.SwapHoriz, trailing = {
                    Segmented(
                        options = listOf(BarSide.LEFT to "Left", BarSide.RIGHT to "Right"), selected = state.flowBar.side,
                        onSelect = controller::setFlowBarSide, modifier = Modifier.width(150.dp), track = Vox.canvas, height = 36.dp
                    )
                })
                GroupDivider()
                SwitchRow("Always show", Icons.Rounded.Visibility, "Off: only while you type.", state.flowBar.alwaysShow, controller::setFlowBarAlwaysShow)
                GroupDivider()
                SwitchRow("Haptics", Icons.Rounded.Vibration, null, state.flowBar.haptics, controller::setFlowBarHaptics)
            }
        }
        item(key = "speech") {
            val cloudReady = account?.hasCloud == true && state.cloudConsent
            Section("Speech") {
                EngineRow(
                    title = "Phone's speech engine", icon = Icons.Rounded.PhoneAndroid, subtitle = "Free: 1,000 words a week.",
                    selected = state.provider == SpeechProvider.ANDROID, tag = "engine-phone",
                    onClick = { controller.setProvider(SpeechProvider.ANDROID) }
                )
                GroupDivider()
                EngineRow(
                    title = "Voxden Cloud", icon = Icons.Rounded.Cloud, subtitle = cloudSubtitle(account),
                    selected = state.provider == SpeechProvider.CLOUD, tag = "engine-cloud",
                    onClick = { if (cloudReady) controller.setProvider(SpeechProvider.CLOUD) else onOpenAccount() }
                )
                GroupDivider()
                SettingsRow(
                    title = "Language", icon = Icons.Rounded.Language, onClick = onOpenLanguage, chevron = true,
                    modifier = Modifier.testTag("settings-language"),
                    trailing = { Text(languageName(state.language), style = VoxType.bodySmall.copy(fontSize = 15.sp), maxLines = 1) }
                )
            }
        }
        item(key = "account") {
            Section("Account") {
                SettingsRow(
                    title = account?.email?.takeIf { it.isNotBlank() } ?: "Sign in",
                    subtitle = if (account == null) "Try Voxden Cloud free." else accountSubtitle(account),
                    icon = Icons.Rounded.Person, onClick = onOpenAccount, chevron = true, modifier = Modifier.testTag("settings-account")
                )
                // Opens the account sheet, which holds the one purchase flow.
                if (canSellPro && canUpgrade(accountMode(account))) {
                    GroupDivider()
                    SettingsRow(
                        title = "Upgrade to Pro", subtitle = "Keep Voxden Cloud going.", icon = Icons.Rounded.Bolt,
                        onClick = onOpenAccount, chevron = true, modifier = Modifier.testTag("settings-upgrade")
                    )
                }
            }
        }
        item(key = "privacy") {
            Section("Privacy") {
                SwitchRow("Save history", Icons.Rounded.History, "Keep dictations on this device.", state.saveHistory, controller::setSaveHistory)
                GroupDivider()
                SettingsRow(
                    title = "Clear history", icon = Icons.Rounded.DeleteOutline, iconTint = if (state.history.isEmpty()) Vox.text3 else Vox.danger,
                    titleColor = if (state.history.isEmpty()) Vox.text3 else Vox.danger,
                    onClick = if (state.history.isEmpty()) null else ({ confirmClear = true }),
                    modifier = Modifier.testTag("settings-clear-history")
                )
                if (state.cloudConsent) {
                    GroupDivider()
                    SettingsRow(
                        title = "Withdraw cloud consent", icon = Icons.Rounded.CloudOff, subtitle = "Stops sending audio to Voxden Cloud.",
                        onClick = { controller.setCloudConsent(false) }, modifier = Modifier.testTag("settings-withdraw")
                    )
                }
                GroupDivider()
                SettingsRow(title = "App permissions", icon = Icons.Rounded.Security, onClick = actions::openAppInfo, chevron = true)
            }
        }
        item(key = "keyboard") {
            Section("Voice keyboard (backup)") {
                SettingsRow(title = "Enable keyboard", icon = Icons.Rounded.Keyboard, subtitle = "Add Voxden voice in Android settings.",
                    onClick = actions::openKeyboardSettings, chevron = true)
                GroupDivider()
                SettingsRow(title = "Switch keyboard", icon = Icons.Rounded.SwapHoriz, subtitle = "Pick Voxden voice while you type.",
                    onClick = actions::showKeyboardPicker, chevron = true)
                GroupDivider()
                Box(Modifier.fillMaxWidth().padding(14.dp)) {
                    VoxField(
                        value = tryKeyboard, onValueChange = { tryKeyboard = it }, placeholder = "Try the voice keyboard",
                        singleLine = false, minLines = 2, maxLines = 5, shape = androidx.compose.foundation.shape.RoundedCornerShape(16.dp),
                        container = Vox.canvas, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 14.dp),
                        modifier = Modifier.testTag("keyboard-try-field"), keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default)
                    )
                }
            }
        }
        item(key = "about") {
            Section("About") {
                SettingsRow(
                    title = "Version", icon = Icons.Rounded.Info, modifier = Modifier.testTag("settings-version"),
                    onLongClick = if (BuildConfig.DEBUG) ({ haptic(Haptic.CONFIRM); DebugHooks.seed(controller) }) else null,
                    trailing = { Text(BuildConfig.VERSION_NAME, style = VoxType.meta.copy(color = Vox.text2, fontSize = 14.sp), maxLines = 1) }
                )
                GroupDivider()
                SettingsRow(title = "Open-source licences", icon = Icons.Rounded.Description, onClick = onOpenLicences, chevron = true,
                    modifier = Modifier.testTag("settings-licences"))
                GroupDivider()
                SettingsRow(title = "Privacy policy", icon = Icons.Rounded.PrivacyTip, onClick = { actions.openUrl(PrivacyUrl) },
                    trailing = { Icon(Icons.AutoMirrored.Rounded.OpenInNew, null, Modifier.size(20.dp), tint = Vox.text3) })
            }
        }
    }
    if (confirmClear) VoxDialog(
        title = "Clear your history?", body = "Every saved dictation is removed from this device. This can't be undone.",
        confirmLabel = "Clear", onDismiss = { confirmClear = false },
        onConfirm = { confirmClear = false; controller.clearHistory(); haptic(Haptic.CONFIRM) }
    )
}

@Composable
private fun Section(label: String, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(start = Vox.gutter, end = Vox.gutter, bottom = 26.dp)) {
        SectionLabel(label)
        SettingsGroup(content = content)
    }
}

@Composable
private fun SwitchRow(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector, subtitle: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    val haptic = rememberHaptics()
    SettingsRow(
        title = title, icon = icon, subtitle = subtitle, onClick = { haptic(Haptic.TICK); onChange(!checked) },
        trailing = { VoxSwitch(checked, null) }
    )
}

@Composable
private fun EngineRow(title: String, icon: androidx.compose.ui.graphics.vector.ImageVector, subtitle: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    SettingsRow(title = title, icon = icon, subtitle = subtitle, onClick = onClick, modifier = Modifier.testTag(tag),
        trailing = { CheckBadge(on = selected, size = 26.dp) })
}

@Composable
private fun StatusValue(on: Boolean, label: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(8.dp).background(if (on) Vox.mint else Vox.text3, CircleShape))
        Text(label, style = VoxType.bodySmall.copy(fontSize = 15.sp, color = if (on) Vox.text else Vox.text2))
    }
}

internal fun cloudSubtitle(account: com.voxden.android.core.Account?): String = when (accountMode(account)) {
    AccountMode.SIGNED_OUT -> "Try free for 60 minutes."
    AccountMode.TRIAL -> "Free trial · ${formatTrialMinutes(account!!.trial.left)} left"
    AccountMode.PRO -> if (account!!.creditsCap > 0.0) "Pro · ${formatMinutes(account.cloudMinutesLeft)} left" else "Pro"
    AccountMode.TRIAL_USED, AccountMode.CLOUD_NOT_OFFERED -> "Part of Pro."
}

internal fun accountSubtitle(account: com.voxden.android.core.Account): String = when (accountMode(account)) {
    AccountMode.PRO -> proHeadline(account)
    AccountMode.TRIAL -> "Free trial · ${formatTrialMinutes(account.trial.left)} left"
    else -> "Free plan"
}
