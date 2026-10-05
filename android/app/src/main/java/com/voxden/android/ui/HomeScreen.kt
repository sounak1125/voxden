@file:OptIn(ExperimentalFoundationApi::class)

package com.voxden.android.ui

import android.text.format.DateFormat
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.IosShare
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState
import com.voxden.android.core.HistoryEntry
import kotlinx.coroutines.delay

/** Space the floating Dictate capsule needs under the list: 16dp gap, 44dp bar, and breathing room. */
val CapsuleClearance = 112.dp

@Composable
fun HomeScreen(
    state: AppState,
    listState: LazyListState,
    controller: AppController,
    actions: AppActions,
    flowBarReady: Boolean,
    polish: PolishRunner,
    query: String,
    onQuery: (String) -> Unit,
    searchOpen: Boolean,
    onSearchOpen: (Boolean) -> Unit,
    onOpenSetup: () -> Unit,
    onOpenDetail: (String) -> Unit,
    onOpenAccount: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val is24 = remember(context) { DateFormat.is24HourFormat(context) }
    val now = rememberNow()
    val history = state.history
    val filtered = remember(history, query) { filterEntries(history, query) }
    val groups = remember(filtered, now) { groupByDay(filtered, now) }
    val summary = remember(history, now) { todaySummary(history, now) }
    val latestId = remember(history) { history.maxByOrNull { it.createdAt }?.id }
    val newestId = if (query.isBlank()) latestId else null
    var expandedId by rememberSaveable { mutableStateOf<String?>(null) }
    var copiedId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(copiedId) { if (copiedId != null) { delay(1600); copiedId = null } }
    // A new dictation lands at the top: bring the list to it unless the user has scrolled far away.
    LaunchedEffect(latestId) { if (listState.firstVisibleItemIndex <= 3) listState.animateScrollToItem(0) }

    LazyColumn(modifier, state = listState, contentPadding = PaddingValues(bottom = CapsuleClearance)) {
        item(key = "header") {
            HomeHeader(
                summary = if (searchOpen && query.isNotBlank()) matchCount(filtered.size) else summary,
                searchOpen = searchOpen, query = query, onQuery = onQuery, onSearchOpen = onSearchOpen
            )
        }
        val wordsLeft = if (state.provider == com.voxden.android.core.SpeechProvider.ANDROID) controller.freeWordsLeft(now) else null
        if (wordsLeft != null && wordsLeft <= 0 && !searchOpen) item(key = "words-card") {
            WordsUsedCard(com.voxden.android.core.FreeQuota.resetsAt(state.freeWords, now), onOpenAccount,
                Modifier.animateItem().padding(start = Vox.gutter, end = Vox.gutter, bottom = 12.dp))
        }
        if (!flowBarReady && !searchOpen) item(key = "flow-bar-card") {
            FlowBarCard(onOpenSetup, Modifier.animateItem().padding(start = Vox.gutter, end = Vox.gutter, bottom = 12.dp))
        }
        if (groups.isEmpty()) item(key = "empty") {
            Box(Modifier.animateItem().fillParentMaxHeight(if (flowBarReady) 0.62f else 0.5f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                when {
                    query.isNotBlank() -> Text("Nothing matches “${query.trim()}”.", style = VoxType.body.copy(color = Vox.text2), textAlign = TextAlign.Center,
                        modifier = Modifier.padding(horizontal = 36.dp))
                    !state.saveHistory -> EmptyBlock(
                        buildAnnotatedString { append("History is off.") },
                        "New dictations aren't kept. Turn history on in Settings to see them here."
                    )
                    else -> EmptyBlock(
                        buildAnnotatedString {
                            append("Your words will live ")
                            withStyle(SpanStyle(fontFamily = SerifAccentFamily, fontStyle = FontStyle.Italic, fontSize = 34.sp)) { append("here.") }
                        },
                        "Pull the bar from the edge in any app, or tap Dictate below."
                    )
                }
            }
        }
        groups.forEach { group ->
            stickyHeader(key = "day-${group.key}") { DayLabel(group.label) }
            items(group.entries, key = { it.id }) { entry ->
                val showActions = entry.id == newestId || entry.id == expandedId
                DictationRow(
                    entry = entry, is24Hour = is24, showActions = showActions, expanded = entry.id == expandedId,
                    copied = copiedId == entry.id, polishing = polish.running.containsKey(entry.id),
                    onOpen = { onOpenDetail(entry.id) },
                    onLongPress = { expandedId = if (expandedId == entry.id) null else entry.id },
                    onCopy = { actions.copy(entry.shownText); copiedId = entry.id },
                    onPolish = { if (DebugHooks.canPolish(controller)) polish.run(entry.id, entry.text, "polish") else onOpenAccount() },
                    onShare = { actions.share(entry.shownText) },
                    modifier = Modifier.animateItem().padding(start = Vox.gutter, end = Vox.gutter, bottom = 10.dp)
                )
            }
        }
    }
}

private fun matchCount(n: Int) = when (n) { 0 -> "No matches"; 1 -> "1 match"; else -> "$n matches" }

@Composable
private fun HomeHeader(
    summary: String,
    searchOpen: Boolean,
    query: String,
    onQuery: (String) -> Unit,
    onSearchOpen: (Boolean) -> Unit
) {
    val focus = remember { FocusRequester() }
    LaunchedEffect(searchOpen) {
        if (searchOpen) { delay(60); runCatching { focus.requestFocus() } }
    }
    Column(Modifier.fillMaxWidth().padding(start = Vox.gutter, end = Vox.gutter, top = 6.dp, bottom = 14.dp)) {
        AnimatedContent(
            targetState = searchOpen,
            transitionSpec = { (fadeIn(VoxMotion.spring()) + scaleIn(VoxMotion.spring(), initialScale = 0.96f)) togetherWith fadeOut(tween(90)) + scaleOut(tween(90), targetScale = 0.98f) },
            label = "home-header"
        ) { open ->
            if (!open) {
                Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Dictations", Modifier.weight(1f), style = VoxType.display, maxLines = 1)
                    RoundIconButton(Icons.Rounded.Search, "Search dictations", { onSearchOpen(true) }, Modifier.testTag("search-button"))
                }
            } else {
                Row(Modifier.fillMaxWidth().height(48.dp), verticalAlignment = Alignment.CenterVertically) {
                    VoxField(
                        value = query, onValueChange = onQuery, modifier = Modifier.weight(1f).testTag("search-field"),
                        placeholder = "Search your dictations", focusRequester = focus, minHeight = 48.dp,
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search), keyboardActions = KeyboardActions(onSearch = {}),
                        leading = { Icon(Icons.Rounded.Search, null, Modifier.size(20.dp), tint = Vox.text3) },
                        trailing = if (query.isNotEmpty()) ({
                            Box(Modifier.size(28.dp).clip(CircleShape).clickable { onQuery("") }.semantics { contentDescription = "Clear search" },
                                contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Close, null, Modifier.size(18.dp), tint = Vox.text3) }
                        }) else null
                    )
                    TextAction("Cancel", { onQuery(""); onSearchOpen(false) })
                }
            }
        }
        if (summary.isNotEmpty()) {
            Spacer(Modifier.height(4.dp))
            Text(summary, Modifier.padding(start = 1.dp), style = VoxType.meta, maxLines = 1)
        }
    }
}

@Composable
private fun DayLabel(label: String) {
    Box(Modifier.fillMaxWidth().background(Vox.canvas).padding(start = Vox.gutter + 2.dp, end = Vox.gutter, top = 8.dp, bottom = 8.dp)) {
        Text(label, style = VoxType.label)
    }
}

/** The free week's words are spent: when they come back, and the way on (the trial or Pro). */
@Composable
private fun WordsUsedCard(resetsAt: Long?, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Pressable(onClick = onClick, modifier = modifier.fillMaxWidth().testTag("words-card"), pressedScale = 0.985f, haptic = Haptic.TICK) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("This week's free words are used", style = VoxType.bodyMedium)
                Text((resetsAt?.let { "Back on ${com.voxden.android.core.FreeQuota.dayLabel(it)}. " } ?: "") + "Voxden Cloud keeps going.", style = VoxType.bodySmall)
            }
            Icon(Icons.Rounded.ChevronRight, null, Modifier.size(22.dp), tint = Vox.text3)
        }
    }
}

@Composable
private fun FlowBarCard(onClick: () -> Unit, modifier: Modifier = Modifier) {
    Pressable(onClick = onClick, modifier = modifier.fillMaxWidth().testTag("flow-bar-card"), pressedScale = 0.985f, haptic = Haptic.TICK) {
        Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            // The resting pill, drawn against a screen edge.
            Box(Modifier.size(44.dp).background(Vox.raised, RoundedCornerShape(14.dp)).border(1.dp, Vox.hairline, RoundedCornerShape(14.dp))) {
                Box(Modifier.align(Alignment.CenterEnd).padding(end = 5.dp).size(6.dp, 24.dp).background(Color.Black, CircleShape)
                    .border(1.dp, Color(0x4DFFFFFF), CircleShape))
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Turn on the flow bar", style = VoxType.bodyMedium)
                Text("Dictate in any app.", style = VoxType.bodySmall)
            }
            Icon(Icons.Rounded.ChevronRight, null, Modifier.size(22.dp), tint = Vox.text3)
        }
    }
}

@Composable
fun DictationRow(
    entry: HistoryEntry,
    is24Hour: Boolean,
    showActions: Boolean,
    expanded: Boolean,
    copied: Boolean,
    polishing: Boolean,
    onOpen: () -> Unit,
    onLongPress: () -> Unit,
    onCopy: () -> Unit,
    onPolish: () -> Unit,
    onShare: () -> Unit,
    modifier: Modifier = Modifier
) {
    Pressable(onClick = onOpen, onLongClick = onLongPress, modifier = modifier.fillMaxWidth().testTag("dictation-row"), pressedScale = 0.985f) {
        Column(
            Modifier.fillMaxWidth().animateContentSize(VoxMotion.spring()).padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = if (showActions) 8.dp else 18.dp)
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TargetIcon(entry)
                Spacer(Modifier.width(8.dp))
                Text("${clockTime(entry.createdAt, is24Hour)} · ${destinationText(entry)}", Modifier.weight(1f), style = VoxType.meta,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (entry.polished != null) {
                    Spacer(Modifier.width(10.dp))
                    Icon(Icons.Rounded.AutoAwesome, null, Modifier.size(12.dp), tint = Vox.text2)
                    Spacer(Modifier.width(4.dp))
                    Text("Polished", style = VoxType.meta.copy(color = Vox.text2), maxLines = 1)
                }
            }
            Spacer(Modifier.height(10.dp))
            val preview = remember(entry.text, entry.polished) { entry.shownText.trim().replace(Regex("[ \t]*[\r\n]+[ \t]*|[ \t]{2,}"), " ") }
            Text(preview, style = VoxType.dictation, maxLines = if (expanded) 14 else 4, overflow = TextOverflow.Ellipsis)
            if (showActions) {
                Spacer(Modifier.height(6.dp))
                Row(Modifier.offset(x = (-12).dp), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                    ActionPill(if (copied) "Copied" else "Copy", if (copied) Icons.Rounded.Check else Icons.Rounded.ContentCopy, onCopy,
                        tint = if (copied) Vox.text else Vox.text2)
                    ActionPill(if (polishing) "Polishing" else "Polish", Icons.Rounded.AutoAwesome, onPolish, loading = polishing)
                    ActionPill("Share", Icons.Rounded.IosShare, onShare)
                }
            }
        }
    }
}
