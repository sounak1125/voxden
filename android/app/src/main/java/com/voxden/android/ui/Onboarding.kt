package com.voxden.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.R
import kotlinx.coroutines.delay

const val OnboardingSteps = 4

/**
 * First run. Step 0 welcome, 1 setup checklist, 2 try the real flow bar, 3 the trial sheet (shown by the app root
 * over a quiet backdrop). Skippable from the checklist.
 */
@Composable
fun OnboardingFlow(
    step: Int,
    onStep: (Int) -> Unit,
    status: SetupStatus,
    actions: AppActions,
    onTypeForYou: () -> Unit,
    modifier: Modifier = Modifier
) {
    BackHandler(enabled = step in 1..2) { onStep(step - 1) }
    Column(modifier.fillMaxSize().background(Vox.canvas).statusBarsPadding().navigationBarsPadding().imePadding()) {
        StepDots(step, Modifier.padding(start = Vox.gutter, end = Vox.gutter, top = 18.dp, bottom = 6.dp))
        AnimatedContent(
            targetState = step, modifier = Modifier.weight(1f).fillMaxWidth(),
            transitionSpec = {
                val forward = targetState > initialState
                (fadeIn(VoxMotion.spring()) + slideInHorizontally(VoxMotion.spring<IntOffset>()) { if (forward) it / 8 else -it / 8 }) togetherWith
                    (fadeOut(VoxMotion.spring()) + slideOutHorizontally(VoxMotion.spring<IntOffset>()) { if (forward) -it / 8 else it / 8 })
            },
            label = "onboarding-step"
        ) { page ->
            when (page) {
                0 -> WelcomePage(onNext = { onStep(1) })
                1 -> SetupPage(status, actions, onTypeForYou, onContinue = { onStep(2) }, onSkip = { onStep(3) })
                2 -> TryPage(status, onDone = { onStep(3) })
                else -> Backdrop()
            }
        }
    }
}

@Composable
private fun StepDots(step: Int, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        repeat(OnboardingSteps) { i ->
            val color by animateColorAsState(if (i <= step) Vox.text else Vox.hairlineStrong, VoxMotion.spring(), label = "dot")
            Box(Modifier.width(24.dp).height(3.dp).clip(CircleShape).background(color))
        }
    }
}

@Composable
private fun Page(
    modifier: Modifier = Modifier,
    bottom: @Composable () -> Unit,
    content: @Composable () -> Unit
) {
    Column(modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) { content() }
        Column(Modifier.fillMaxWidth().padding(start = Vox.gutter, end = Vox.gutter, top = 12.dp, bottom = 16.dp)) { bottom() }
    }
}

@Composable
private fun WelcomePage(onNext: () -> Unit) {
    Column(Modifier.fillMaxSize()) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            // The illustration takes whatever the headline and button leave, within sensible bounds.
            val card = (maxHeight - 236.dp).coerceIn(250.dp, 420.dp)
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                Box(
                    Modifier.fillMaxWidth().padding(horizontal = Vox.gutter).padding(top = 14.dp).height(card).clip(Vox.card)
                        .background(Vox.surface).border(1.dp, Vox.hairline, Vox.card)
                ) { IslandPullIllustration(Modifier.fillMaxSize()) }
                Spacer(Modifier.height(28.dp))
                Text(
                    buildAnnotatedString {
                        appendLine("Speak.")
                        append("It's ")
                        withStyle(SpanStyle(fontFamily = SerifAccentFamily, fontStyle = FontStyle.Italic, fontSize = 52.sp)) { append("written.") }
                    },
                    Modifier.padding(horizontal = Vox.gutter).testTag("onboarding-headline"), style = VoxType.hero
                )
                Spacer(Modifier.height(14.dp))
                Text("Voxden turns your voice into clean text, in any app.", Modifier.padding(horizontal = Vox.gutter).widthIn(max = 330.dp),
                    style = VoxType.body.copy(color = Vox.text2, fontSize = 17.sp, lineHeight = 26.sp))
                Spacer(Modifier.height(12.dp))
            }
        }
        Column(Modifier.fillMaxWidth().padding(start = Vox.gutter, end = Vox.gutter, top = 12.dp, bottom = 16.dp)) {
            PrimaryButton("Get started", onNext, Modifier.testTag("onboarding-start"))
        }
    }
}

@Composable
private fun SetupPage(status: SetupStatus, actions: AppActions, onTypeForYou: () -> Unit, onContinue: () -> Unit, onSkip: () -> Unit) {
    Page(
        bottom = {
            PrimaryButton("Continue", onContinue, Modifier.testTag("onboarding-continue"), enabled = status.required)
            Box(Modifier.fillMaxWidth().padding(top = 4.dp), contentAlignment = Alignment.Center) {
                TextAction("Skip for now", onSkip, Modifier.testTag("onboarding-skip"))
            }
        }
    ) {
        Column(Modifier.padding(horizontal = Vox.gutter, vertical = 18.dp)) {
            Text("Get set up", style = VoxType.display)
            Spacer(Modifier.height(10.dp))
            Text("Voxden needs your microphone, and your OK to type for you.", style = VoxType.body.copy(color = Vox.text2))
            Spacer(Modifier.height(28.dp))
            SetupChecklist(status, onMicrophone = actions::requestMicrophone, onTypeForYou = onTypeForYou,
                onNotifications = actions::requestNotifications, onAppInfo = actions::openAppInfo)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TryPage(status: SetupStatus, onDone: () -> Unit) {
    val focus = remember { FocusRequester() }
    var text by rememberSaveable { mutableStateOf("") }
    LaunchedEffect(Unit) { delay(450); runCatching { focus.requestFocus() } }
    Page(bottom = {
        PrimaryButton("Done", onDone, Modifier.testTag("onboarding-done"))
        // The flow bar's capsule opens 12dp above the keyboard and is 44dp tall: keep the button clear of it.
        if (WindowInsets.isImeVisible) Spacer(Modifier.height(52.dp))
    }) {
        Column(Modifier.padding(horizontal = Vox.gutter, vertical = 18.dp)) {
            Text("Try it", style = VoxType.display)
            Spacer(Modifier.height(10.dp))
            Text(
                if (status.flowBar) "Tap the field, then pull the bar out from the edge of your screen."
                else "The flow bar is off, so there is nothing to pull yet. You can turn it on later in Settings.",
                style = VoxType.body.copy(color = Vox.text2)
            )
            Spacer(Modifier.height(28.dp))
            VoxField(
                value = text, onValueChange = { text = it }, placeholder = "Tap here and pull the bar from the edge",
                singleLine = false, minLines = 5, shape = Vox.card, container = Vox.surface, focusRequester = focus,
                contentPadding = androidx.compose.foundation.layout.PaddingValues(18.dp), modifier = Modifier.testTag("try-field")
            )
        }
    }
}

/** Behind the trial sheet: the canvas and the mark, nothing else. */
@Composable
private fun Backdrop() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Image(painterResource(R.drawable.voxden_logo), null, Modifier.size(84.dp))
    }
}
