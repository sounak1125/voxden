package com.voxden.android.ui

import android.text.format.DateFormat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Compress
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.DeleteOutline
import androidx.compose.material.icons.rounded.IosShare
import androidx.compose.material.icons.rounded.Spellcheck
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState
import com.voxden.android.core.DictationSource
import com.voxden.android.core.HistoryEntry
import kotlinx.coroutines.delay

private enum class DetailView { ORIGINAL, POLISHED }

private val PolishModes = listOf(
    Triple("polish", "Polish", Icons.Rounded.AutoAwesome),
    Triple("grammar", "Grammar", Icons.Rounded.Spellcheck),
    Triple("tighten", "Tighten", Icons.Rounded.Compress)
)

@OptIn(ExperimentalLayoutApi::class)
/** The full-height sheet for one dictation: editable text, Original/Polished, Polish modes, Copy, Share, Delete. */
@Composable
fun DetailSheet(
    entryId: String,
    state: AppState,
    controller: AppController,
    actions: AppActions,
    polish: PolishRunner,
    onOpenAccount: () -> Unit,
    onDismiss: () -> Unit
) {
    val entry = state.history.firstOrNull { it.id == entryId }
    // The dictation can disappear under the sheet (history cleared, account deleted).
    LaunchedEffect(entry == null) { if (entry == null) onDismiss() }
    if (entry == null) return
    val context = LocalContext.current
    val is24 = remember(context) { DateFormat.is24HourFormat(context) }
    val haptic = rememberHaptics()

    var view by rememberSaveable(entry.id) { mutableStateOf(if (entry.polished != null) DetailView.POLISHED else DetailView.ORIGINAL) }
    val polishedText = entry.polished
    // A fresh polish result takes over the view.
    LaunchedEffect(polishedText) { if (polishedText != null) view = DetailView.POLISHED else view = DetailView.ORIGINAL }
    val showingPolished = view == DetailView.POLISHED && polishedText != null
    val saved = if (showingPolished) polishedText!! else entry.text

    var draft by remember(entry.id, showingPolished) { mutableStateOf(TextFieldValue(saved)) }
    var synced by remember(entry.id, showingPolished) { mutableStateOf(saved) }
    LaunchedEffect(saved) {
        if (draft.text == synced && saved != synced) draft = TextFieldValue(saved)
        synced = saved
    }
    val commit = rememberUpdatedState {
        val text = draft.text
        if (text.isNotBlank() && text != synced) {
            if (showingPolished) controller.setPolished(entry.id, text) else controller.updateHistoryText(entry.id, text)
            synced = text
        }
    }
    LaunchedEffect(draft.text) { if (draft.text != synced) { delay(600); commit.value() } }
    DisposableEffect(entry.id, showingPolished) { onDispose { commit.value() } }

    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) { if (copied) { delay(1600); copied = false } }
    var confirmDelete by remember { mutableStateOf(false) }
    val polishing = polish.running[entry.id]
    val failure = polish.failure?.takeIf { it.id == entry.id }
    LaunchedEffect(Unit) { polish.clearFailure() }
    val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    // Full height, but the sheet's top edge stops a little below the status bar.
    val density = LocalDensity.current
    val windowHeight = with(density) { androidx.compose.ui.platform.LocalWindowInfo.current.containerSize.height.toDp() }
    val statusTop = with(density) { WindowInsets.statusBars.getTop(density).toDp() }
    val navBottom = with(density) { WindowInsets.navigationBars.getBottom(density).toDp() }
    // The sheet also adds its 28dp grab handle above and the navigation bar inset below this content.
    val imeBottom = with(density) { WindowInsets.ime.getBottom(density).toDp() }
    val sheetHeight = windowHeight - statusTop - 12.dp - 28.dp - maxOf(navBottom, imeBottom)

    VoxSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().height(sheetHeight).testTag("detail-sheet")) {
            Row(
                Modifier.fillMaxWidth().padding(start = 24.dp, end = 16.dp, top = 6.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                TargetIcon(entry, size = 22.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(destinationTitle(entry), style = VoxType.bodyMedium.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold), maxLines = 1)
                    Text(fullTime(entry.createdAt, is24), style = VoxType.meta, maxLines = 1)
                }
                RoundIconButton(Icons.Rounded.Close, "Close", onDismiss, size = 36.dp, container = Color.Transparent, border = null)
            }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).animateContentSize(VoxMotion.spring()).padding(horizontal = Vox.gutter + 4.dp)) {
                if (polishedText != null) {
                    Segmented(
                        options = listOf(DetailView.ORIGINAL to "Original", DetailView.POLISHED to "Polished"),
                        selected = if (showingPolished) DetailView.POLISHED else DetailView.ORIGINAL,
                        onSelect = { view = it }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp).testTag("detail-segmented")
                    )
                } else Spacer(Modifier.height(8.dp))
                BasicTextField(
                    value = draft, onValueChange = { draft = it },
                    modifier = Modifier.fillMaxWidth().defaultMinSize(minHeight = 120.dp).testTag("detail-text"),
                    textStyle = VoxType.dictation, cursorBrush = SolidColor(Vox.mint)
                )
                Spacer(Modifier.height(24.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PolishModes.forEach { (mode, label, icon) ->
                        PolishChip(
                            label = label, icon = icon, loading = polishing == mode, enabled = polishing == null,
                            onClick = {
                                if (!DebugHooks.canPolish(controller)) onOpenAccount()
                                else { commit.value(); polish.run(entry.id, if (showingPolished) entry.text else draft.text, mode) }
                            },
                            modifier = Modifier.testTag("polish-$mode")
                        )
                    }
                }
                AnimatedVisibility(
                    visible = failure != null || !DebugHooks.canPolish(controller),
                    enter = expandVertically(VoxMotion.spring()) + fadeIn(VoxMotion.spring()),
                    exit = shrinkVertically(VoxMotion.spring()) + fadeOut(VoxMotion.spring())
                ) {
                    Text(
                        failure?.message ?: "Polish uses Voxden Cloud.",
                        Modifier.padding(top = 12.dp, start = 2.dp),
                        style = VoxType.bodySmall.copy(fontSize = 13.sp, lineHeight = 19.sp, color = if (failure != null) Vox.danger else Vox.text3)
                    )
                }
                Spacer(Modifier.height(28.dp))
                SectionLabel("Details")
                SettingsGroup {
                    DetailRow("Time", fullTime(entry.createdAt, is24))
                    GroupDivider(16.dp)
                    DetailRow("Into", destinationTitle(entry))
                    GroupDivider(16.dp)
                    DetailRow("Engine", engineName(entry.provider))
                    GroupDivider(16.dp)
                    DetailRow("Length", if (entry.durationSeconds > 0) formatDuration(entry.durationSeconds) else "Not recorded")
                    GroupDivider(16.dp)
                    DetailRow("Words", countWords(draft.text).toString())
                }
                Spacer(Modifier.height(24.dp))
            }
            AnimatedVisibility(
                visible = !imeVisible,
                enter = expandVertically(VoxMotion.spring()) + fadeIn(VoxMotion.spring()),
                exit = shrinkVertically(VoxMotion.spring()) + fadeOut(VoxMotion.spring())
            ) {
                Column(Modifier.fillMaxWidth().background(Vox.raised)) {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(Vox.hairline))
                    Row(
                        Modifier.fillMaxWidth().padding(start = Vox.gutter + 4.dp, end = Vox.gutter + 4.dp, top = 14.dp, bottom = 14.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically
                    ) {
                        PrimaryButton(if (copied) "Copied" else "Copy", { actions.copy(draft.text); copied = true; haptic(Haptic.CONFIRM) },
                            Modifier.weight(1f).testTag("detail-copy"), icon = if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy, haptic = null)
                        SecondaryButton("Share", { actions.share(draft.text) }, Modifier.weight(1f), icon = Icons.Rounded.IosShare)
                        RoundIconButton(Icons.Rounded.DeleteOutline, "Delete dictation", { confirmDelete = true }, Modifier.testTag("detail-delete"),
                            size = 54.dp, container = Color.Transparent, border = Vox.hairlineStrong, tint = Vox.danger)
                    }
                }
            }
        }
    }
    if (confirmDelete) VoxDialog(
        title = "Delete this dictation?", body = "It is removed from this device. This can't be undone.", confirmLabel = "Delete",
        onDismiss = { confirmDelete = false },
        onConfirm = { confirmDelete = false; controller.deleteHistory(entry.id); haptic(Haptic.CONFIRM); onDismiss() }
    )
}

@Composable
private fun PolishChip(label: String, icon: ImageVector, loading: Boolean, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Pressable(
        onClick = if (loading) null else onClick, modifier = modifier.height(42.dp), shape = CircleShape, color = Color.Transparent,
        pressedColor = Vox.surface, border = Vox.hairlineStrong, enabled = enabled, pressedScale = 0.97f, haptic = Haptic.TICK,
        contentAlignment = Alignment.Center
    ) {
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (loading) VoxSpinner(size = 16.dp, color = Vox.text)
            else Icon(icon, null, Modifier.size(18.dp), tint = if (enabled) Vox.text2 else Vox.text3)
            Text(label, style = VoxType.buttonSmall.copy(color = if (enabled) Vox.text else Vox.text3), maxLines = 1)
        }
    }
}

@Composable
private fun DetailRow(name: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(name, Modifier.weight(1f), style = VoxType.bodySmall.copy(fontSize = 15.sp))
        Text(value, style = VoxType.body.copy(fontSize = 15.sp, fontFeatureSettings = "tnum"), textAlign = TextAlign.End, maxLines = 1)
    }
}

internal fun destinationTitle(entry: HistoryEntry): String = when (entry.source) {
    DictationSource.APP -> "Voxden"
    DictationSource.KEYBOARD -> "Voice keyboard"
    DictationSource.FLOW_BAR -> entry.appLabel?.takeIf { it.isNotBlank() } ?: "Flow bar"
}

internal fun engineName(provider: String): String = when (provider) {
    "Android speech" -> "Phone's speech engine"
    else -> provider.ifBlank { "Unknown" }
}
