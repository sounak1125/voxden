package com.voxden.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One step of the setup checklist: an icon, what it is for, and a ring that turns into a check when it is on. */
@Composable
private fun SetupRow(
    icon: ImageVector,
    title: String,
    detail: String,
    done: Boolean,
    actionLabel: String,
    onClick: () -> Unit,
    tag: String
) {
    SettingsRow(
        title = title, subtitle = detail, icon = icon, onClick = if (done) null else onClick,
        modifier = Modifier.testTag(tag),
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AnimatedVisibility(!done, enter = fadeIn(VoxMotion.spring()), exit = fadeOut(VoxMotion.spring())) {
                    Text(actionLabel, style = VoxType.buttonSmall.copy(color = Vox.text))
                }
                CheckBadge(on = done)
            }
        }
    )
}

/** Microphone, Type for you, and optional Notifications, updating live as the user comes back from Android's screens. */
@Composable
fun SetupChecklist(
    status: SetupStatus,
    onMicrophone: () -> Unit,
    onTypeForYou: () -> Unit,
    onNotifications: () -> Unit,
    onAppInfo: () -> Unit,
    modifier: Modifier = Modifier
) {
    SettingsGroup(modifier) {
        SetupRow(Icons.Rounded.Mic, "Microphone", "So Voxden can hear you.", status.microphone, "Allow", onMicrophone, "setup-microphone")
        GroupDivider()
        SetupRow(Icons.Rounded.Keyboard, "Type for you", "Shows the bar while you type, and types your words.",
            status.flowBar, "Turn on", onTypeForYou, "setup-type-for-you")
        AnimatedVisibility(
            visible = !status.flowBar && !status.installedFromStore,
            enter = expandVertically(VoxMotion.spring()) + fadeIn(VoxMotion.spring()),
            exit = shrinkVertically(VoxMotion.spring()) + fadeOut(VoxMotion.spring())
        ) {
            Column(Modifier.fillMaxWidth().testTag("restricted-help").padding(start = 52.dp, end = 16.dp, bottom = 16.dp)) {
                Text(
                    buildAnnotatedString {
                        withStyle(SpanStyle(color = Vox.text, fontWeight = FontWeight.Medium)) { append("Can't switch it on? ") }
                        append("Android blocks this for apps installed from a file. Open App info, tap the ⋮ menu, choose Allow restricted settings, then come back.")
                    },
                    style = VoxType.bodySmall.copy(fontSize = 13.sp, lineHeight = 19.sp)
                )
                Spacer(Modifier.height(12.dp))
                SecondaryButton("Open App info", onAppInfo, compact = true, fullWidth = false, modifier = Modifier.height(40.dp))
            }
        }
        if (status.needsNotificationPermission) {
            GroupDivider()
            SetupRow(Icons.Rounded.Notifications, "Notifications", "Optional. Keeps dictation going if you leave the app.",
                status.notifications, "Allow", onNotifications, "setup-notifications")
        }
    }
}

/** The setup checklist as a sheet, for the home card and Settings. */
@Composable
fun SetupSheet(
    status: SetupStatus,
    onMicrophone: () -> Unit,
    onTypeForYou: () -> Unit,
    onNotifications: () -> Unit,
    onAppInfo: () -> Unit,
    onDismiss: () -> Unit
) {
    VoxSheet(onDismiss) {
        Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 24.dp)) {
            Text("Set up the flow bar", style = VoxType.title)
            Spacer(Modifier.height(8.dp))
            Text("Turn these on to dictate in any app.", style = VoxType.bodySmall.copy(fontSize = 15.sp, lineHeight = 22.sp))
            Spacer(Modifier.height(20.dp))
            SetupChecklist(status, onMicrophone, onTypeForYou, onNotifications, onAppInfo)
            Spacer(Modifier.height(20.dp))
            SecondaryButton("Done", onDismiss)
        }
    }
}

@Composable
private fun DisclosureRow(icon: ImageVector, heading: String, body: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Box(Modifier.size(40.dp).background(Vox.surface, CircleShape).border(1.dp, Vox.hairline, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(20.dp), tint = Vox.text2)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(heading, style = VoxType.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
            Text(body, style = VoxType.bodySmall.copy(fontSize = 15.sp, lineHeight = 22.sp))
        }
    }
}

/**
 * Google Play's prominent disclosure: shown before sending the user to Android's accessibility settings.
 * Says what is accessed, why, and what never happens, and asks for an explicit agree.
 */
@Composable
fun AccessibilityDisclosureSheet(onAgree: () -> Unit, onDismiss: () -> Unit) {
    VoxSheet(onDismiss) {
        Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 24.dp).testTag("accessibility-disclosure")) {
            Text("Let Voxden type for you", style = VoxType.title)
            Spacer(Modifier.height(8.dp))
            Text("Voxden uses Android's accessibility service for the flow bar. Here is exactly what that means.",
                style = VoxType.bodySmall.copy(fontSize = 15.sp, lineHeight = 22.sp))
            Spacer(Modifier.height(24.dp))
            Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                DisclosureRow(Icons.Rounded.Visibility, "What it reads",
                    "Which text field is focused, and the text around your cursor while you dictate.")
                DisclosureRow(Icons.Rounded.Keyboard, "Why",
                    "To show the bar while you type, and to type your words for you.")
                DisclosureRow(Icons.Rounded.Lock, "What it never does",
                    "It never reads password fields, and it doesn't collect or share anything else.")
            }
            Spacer(Modifier.height(28.dp))
            PrimaryButton("Agree and open settings", onAgree)
            Spacer(Modifier.height(4.dp))
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { TextAction("Not now", onDismiss) }
        }
    }
}
