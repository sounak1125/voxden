package com.voxden.android.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.core.AppController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Language: a sheet with the supported speech languages, the current one checked. */
@Composable
fun LanguageSheet(current: String, controller: AppController, onDismiss: () -> Unit) {
    val haptic = rememberHaptics()
    VoxSheet(onDismiss) {
        Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 24.dp)) {
            Text("Language", style = VoxType.title)
            Spacer(Modifier.height(8.dp))
            Text("The language you speak. Used by your phone's speech engine and Voxden Cloud.", style = VoxType.bodySmall.copy(fontSize = 15.sp, lineHeight = 22.sp))
            Spacer(Modifier.height(20.dp))
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                SettingsGroup {
                    Languages.forEachIndexed { index, (code, name) ->
                        if (index > 0) GroupDivider(inset = 16.dp)
                        SettingsRow(
                            title = name, modifier = Modifier.testTag("language-$code"),
                            onClick = { controller.setLanguage(code); haptic(Haptic.TICK); onDismiss() },
                            trailing = { CheckBadge(on = code == current, size = 24.dp) }
                        )
                    }
                }
            }
        }
    }
}

private data class LicenceFile(val file: String, val title: String)

/** Full-screen page listing the files in assets/licenses, each expandable to its full text. */
@Composable
fun LicencesScreen(onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val files by produceState(emptyList<LicenceFile>()) {
        value = withContext(Dispatchers.IO) {
            runCatching { context.assets.list("licenses").orEmpty().sorted().map { LicenceFile(it, licenceTitle(it)) } }.getOrDefault(emptyList())
        }
    }
    var open by remember { mutableStateOf<String?>(null) }
    Column(modifier.fillMaxSize().background(Vox.canvas).statusBarsPadding().navigationBarsPadding().testTag("licences-screen")) {
        Row(Modifier.fillMaxWidth().height(60.dp).padding(horizontal = Vox.gutter), verticalAlignment = Alignment.CenterVertically) {
            RoundIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 36.dp, modifier = Modifier.testTag("licences-back"))
        }
        LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 32.dp)) {
            item {
                Column(Modifier.fillMaxWidth().padding(start = Vox.gutter, end = Vox.gutter, top = 6.dp, bottom = 22.dp)) {
                    Box(Modifier.height(48.dp), contentAlignment = Alignment.CenterStart) { Text("Licences", style = VoxType.display) }
                    Spacer(Modifier.height(4.dp))
                    Text("Voxden's typefaces are open source, under the SIL Open Font License 1.1.", style = VoxType.body.copy(color = Vox.text2))
                }
            }
            items(files, key = { it.file }) { licence ->
                val expanded = open == licence.file
                Box(Modifier.padding(start = Vox.gutter, end = Vox.gutter, bottom = 10.dp)) {
                    Pressable(onClick = { open = if (expanded) null else licence.file }, modifier = Modifier.fillMaxWidth(), pressedScale = 0.99f, haptic = Haptic.TICK) {
                        Column(Modifier.fillMaxWidth().animateContentSize(VoxMotion.spring()).padding(18.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    Text(licence.title, style = VoxType.bodyMedium)
                                    Text("SIL Open Font License 1.1", style = VoxType.meta)
                                }
                                val turn by animateFloatAsState(if (expanded) 180f else 0f, VoxMotion.spring(), label = "licence-turn")
                                Icon(Icons.Rounded.ExpandMore, null, Modifier.size(24.dp).graphicsLayer { rotationZ = turn }, tint = Vox.text3)
                            }
                            if (expanded) {
                                val text by produceState("") {
                                    value = withContext(Dispatchers.IO) {
                                        runCatching { context.assets.open("licenses/${licence.file}").bufferedReader().use { it.readText() } }.getOrDefault("")
                                    }
                                }
                                Spacer(Modifier.height(14.dp))
                                Box(Modifier.fillMaxWidth().height(1.dp).background(Vox.hairline))
                                Spacer(Modifier.height(14.dp))
                                Text(reflowLicence(text), style = VoxType.bodySmall.copy(fontSize = 12.sp, lineHeight = 18.sp, color = Vox.text2))
                            }
                        }
                    }
                }
            }
        }
    }
}
