package com.voxden.android.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.MenuBook
import androidx.compose.material.icons.rounded.GraphicEq
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.voxden.android.R
import com.voxden.android.core.AppState
import com.voxden.android.core.DictationSource
import com.voxden.android.core.RecordingPhase
import com.voxden.android.ui.island.IslandCapsule
import com.voxden.android.ui.island.IslandMode

enum class Tab(val label: String, val icon: ImageVector, val tag: String) {
    DICTATIONS("Dictations", Icons.Rounded.GraphicEq, "nav-dictations"),
    DICTIONARY("Dictionary", Icons.AutoMirrored.Rounded.MenuBook, "nav-dictionary"),
    SETTINGS("Settings", Icons.Rounded.Settings, "nav-settings")
}

val NavBarHeight = 64.dp

/** Logo mark and wordmark on the left; plan chip and account button on the right. A hairline fades in once the page scrolls under it. */
@Composable
fun TopBar(planText: String, signedIn: Boolean, onPlan: () -> Unit, onAccount: () -> Unit, modifier: Modifier = Modifier, showDivider: Boolean = false) {
    val dividerAlpha by animateFloatAsState(if (showDivider) 1f else 0f, VoxMotion.spring(), label = "top-divider")
    Column(modifier.fillMaxWidth().background(Vox.canvas)) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().height(60.dp).padding(horizontal = Vox.gutter),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Image(painterResource(R.drawable.voxden_logo), null, Modifier.size(32.dp))
            Spacer(Modifier.width(8.dp))
            Text("Voxden", style = VoxType.brand)
            Spacer(Modifier.weight(1f))
            PlanChip(planText, onPlan, Modifier.testTag("plan-chip"))
            Spacer(Modifier.width(10.dp))
            RoundIconButton(Icons.Rounded.Person, if (signedIn) "Your account" else "Sign in to Voxden", onAccount,
                Modifier.testTag("account-button"), size = 36.dp)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).graphicsLayer { alpha = dividerAlpha }.background(Vox.hairline))
    }
}

/** Three tabs on the canvas with a hairline above: colour is the only selection cue. */
@Composable
fun BottomNav(selected: Tab, onSelect: (Tab) -> Unit, modifier: Modifier = Modifier) {
    val haptic = rememberHaptics()
    Column(modifier.fillMaxWidth().background(Vox.canvas)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Vox.hairline))
        Row(Modifier.fillMaxWidth().navigationBarsPadding().height(NavBarHeight)) {
            Tab.entries.forEach { tab ->
                val on = tab == selected
                val source = remember { MutableInteractionSource() }
                val pressed by source.collectIsPressedAsState()
                val color by animateColorAsState(if (on) Vox.text else Vox.text3, VoxMotion.spring(), label = "tab-color")
                val scale by animateFloatAsState(if (pressed) 0.94f else 1f, VoxMotion.spring(), label = "tab-scale")
                Column(
                    Modifier.weight(1f).fillMaxHeight().testTag(tab.tag)
                        .selectable(on, interactionSource = source, indication = null, role = Role.Tab) {
                            if (!on) { haptic(Haptic.TICK); onSelect(tab) }
                        }
                        .graphicsLayer { scaleX = scale; scaleY = scale },
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center
                ) {
                    Icon(tab.icon, null, Modifier.size(24.dp), tint = color)
                    Spacer(Modifier.height(4.dp))
                    Text(tab.label, style = VoxType.nav.copy(color = color), maxLines = 1)
                }
            }
        }
    }
}

/**
 * The in-app Dictate capsule: the Island, floating above the navigation bar. It reads the controller's recording
 * state, so it also shows listening and transcribing when the user changes tab mid-dictation.
 */
@Composable
fun DictateBar(
    state: AppState,
    flash: DictateFlash?,
    showLabel: Boolean,
    onTap: () -> Unit,
    onCancel: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier
) {
    val ours = state.recordingSource == DictationSource.APP
    val mode: IslandMode? = when {
        state.phase == RecordingPhase.RECORDING && ours -> IslandMode.RECORDING
        state.phase == RecordingPhase.PROCESSING && ours -> IslandMode.PROCESSING
        flash != null && state.phase == RecordingPhase.IDLE -> flash.mode
        showLabel -> IslandMode.LABEL
        else -> null
    }
    val label = when (mode) {
        IslandMode.LABEL -> "Dictate"
        IslandMode.DONE, IslandMode.ERROR -> flash?.label
        else -> null
    }
    // Keep the last visible content while the exit animation runs.
    val last = remember { arrayOf<Pair<IslandMode, String?>?>(null) }
    if (mode != null) last[0] = mode to label
    val shown = last[0]
    val partial = if (state.phase == RecordingPhase.RECORDING && ours) state.partialTranscript.trim() else ""
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        AnimatedVisibility(
            visible = partial.isNotEmpty(),
            enter = fadeIn(VoxMotion.spring()) + slideInVertically(VoxMotion.spring()) { it / 2 },
            exit = fadeOut(VoxMotion.spring()) + slideOutVertically(VoxMotion.spring()) { it / 2 }
        ) {
            val shape = RoundedCornerShape(20.dp)
            Text(
                partial.takeLast(240), Modifier.widthIn(max = 340.dp).background(Vox.raised, shape).border(1.dp, Vox.hairlineStrong, shape)
                    .padding(horizontal = 16.dp, vertical = 12.dp).testTag("partial-transcript"),
                style = VoxType.bodySmall.copy(color = Vox.text2), maxLines = 3, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center
            )
        }
        AnimatedVisibility(
            visible = mode != null,
            enter = fadeIn(VoxMotion.spring()) + scaleIn(VoxMotion.spring(), initialScale = 0.88f),
            exit = fadeOut(VoxMotion.spring()) + scaleOut(VoxMotion.spring(), targetScale = 0.9f)
        ) {
            val current = shown
            if (current != null) {
                val description = when (current.first) {
                    IslandMode.LABEL -> "Dictate"
                    IslandMode.RECORDING -> "Listening"
                    IslandMode.PROCESSING -> "Transcribing"
                    else -> current.second ?: "Dictate"
                }
                Box(Modifier.testTag("dictate-capsule").semantics { contentDescription = description }) {
                    IslandCapsule(
                        mode = current.first, level = state.audioLevel, label = current.second,
                        onTap = onTap, onCancel = onCancel, onStop = onStop
                    )
                }
            }
        }
    }
}
