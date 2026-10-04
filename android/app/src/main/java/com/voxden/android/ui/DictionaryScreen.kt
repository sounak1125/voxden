@file:OptIn(ExperimentalFoundationApi::class)

package com.voxden.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.core.AppController
import com.voxden.android.core.AppState

private const val DictionaryLimit = 100

@Composable
fun DictionaryScreen(state: AppState, controller: AppController, listState: LazyListState, modifier: Modifier = Modifier) {
    var term by rememberSaveable { mutableStateOf("") }
    val words = state.dictionary
    val canAdd = canAddTerm(term, words)
    val haptic = rememberHaptics()
    val add = {
        if (canAdd) { controller.addTerm(term); term = ""; haptic(Haptic.CONFIRM) }
    }
    LazyColumn(modifier, state = listState, contentPadding = PaddingValues(bottom = 32.dp)) {
        item(key = "header") {
            Column(Modifier.fillMaxWidth().padding(start = Vox.gutter, end = Vox.gutter, top = 6.dp, bottom = 20.dp)) {
                Box(Modifier.height(48.dp), contentAlignment = Alignment.CenterStart) { Text("Dictionary", style = VoxType.display) }
                Spacer(Modifier.height(4.dp))
                Text("Names and words Voxden should always spell right.", Modifier.widthIn(max = 300.dp), style = VoxType.body.copy(color = Vox.text2))
            }
        }
        item(key = "add") {
            Column(Modifier.fillMaxWidth().padding(horizontal = Vox.gutter)) {
                VoxField(
                    value = term, onValueChange = { term = it.take(64) }, modifier = Modifier.testTag("dictionary-field"),
                    placeholder = "Add a word or name",
                    contentPadding = PaddingValues(start = 20.dp, end = 7.dp, top = 7.dp, bottom = 7.dp),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { add() }),
                    trailing = { AddButton(enabled = canAdd, onClick = add) }
                )
                Spacer(Modifier.height(12.dp))
                val duplicate = term.isNotBlank() && !canAdd
                Text(
                    if (duplicate) "That word is already in your dictionary." else "Used by Voxden Cloud. Your phone's speech engine doesn't support custom words.",
                    Modifier.padding(horizontal = 6.dp),
                    style = VoxType.bodySmall.copy(fontSize = 13.sp, lineHeight = 19.sp, color = if (duplicate) Vox.text2 else Vox.text3)
                )
                Spacer(Modifier.height(if (words.isEmpty()) 8.dp else 28.dp))
            }
        }
        if (words.isEmpty()) item(key = "empty") {
            Box(Modifier.animateItem().fillMaxWidth().padding(top = 56.dp), contentAlignment = Alignment.TopCenter) {
                EmptyBlock(
                    buildAnnotatedString {
                        append("Your words, spelled ")
                        withStyle(SpanStyle(fontFamily = SerifAccentFamily, fontStyle = FontStyle.Italic, fontSize = 34.sp)) { append("right.") }
                    },
                    "Add the names, brands and terms you say often."
                )
            }
        } else {
            item(key = "label") {
                Box(Modifier.padding(horizontal = Vox.gutter).animateItem()) {
                    SectionLabel("Your words", trailing = "${words.size} of $DictionaryLimit")
                }
            }
            items(words, key = { it }) { word ->
                WordRow(word, onRemove = { haptic(Haptic.TICK); controller.removeTerm(word) },
                    modifier = Modifier.animateItem().padding(start = Vox.gutter, end = Vox.gutter, bottom = 8.dp))
            }
        }
    }
}

@Composable
private fun AddButton(enabled: Boolean, onClick: () -> Unit) {
    val container by animateColorAsState(if (enabled) Vox.mint else Vox.surface, VoxMotion.spring(), label = "add-container")
    Pressable(
        onClick = onClick, enabled = enabled, shape = CircleShape, color = container, pressedColor = Color(0xFF86DBB0),
        border = null, pressedScale = 0.92f, haptic = null,
        modifier = Modifier.size(40.dp).testTag("dictionary-add").semantics { contentDescription = "Add word" },
        contentAlignment = Alignment.Center
    ) { Icon(Icons.Rounded.Add, null, Modifier.size(22.dp), tint = if (enabled) Vox.onMint else Vox.text3) }
}

@Composable
private fun WordRow(word: String, onRemove: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(18.dp)
    Pressable(onClick = null, modifier = modifier.fillMaxWidth().testTag("dictionary-word"), shape = shape) {
        Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 6.dp).height(56.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(word, Modifier.weight(1f), style = VoxType.body.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium, fontSize = 17.sp),
                maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            Pressable(
                onClick = onRemove, shape = CircleShape, color = Color.Transparent, pressedColor = Vox.raised, border = null, pressedScale = 0.9f,
                modifier = Modifier.size(44.dp).semantics { contentDescription = "Remove $word" }, contentAlignment = Alignment.Center
            ) { Icon(Icons.Rounded.Close, null, Modifier.size(20.dp), tint = Vox.text3) }
        }
    }
}
