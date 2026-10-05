package com.voxden.android.flowbar

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import com.voxden.android.core.BarSide
import com.voxden.android.ui.island.IslandCapsule
import com.voxden.android.ui.island.IslandColors
import com.voxden.android.ui.island.IslandMode

/** What the two overlay windows draw. Written by the flow-bar engine, read by Compose. Main thread only. */
internal class FlowBarUi {
    // Resting pill
    var side by mutableStateOf(BarSide.RIGHT)
    var pillShown by mutableStateOf(false)
    /** Elastic stretch to draw while a finger is pulling, in px. */
    var stretchPx by mutableFloatStateOf(0f)
    var dragging by mutableStateOf(false)
    var armed by mutableStateOf(false)

    // Capsule
    var capsuleShown by mutableStateOf(false)
    var mode by mutableStateOf(IslandMode.RECORDING)
    var label by mutableStateOf<String?>(null)
    var actionLabel by mutableStateOf<String?>(null)
    var level by mutableFloatStateOf(0f)

    var onCancel: () -> Unit = {}
    var onStop: () -> Unit = {}
    var onAction: () -> Unit = {}
    var onTap: () -> Unit = {}
}

/**
 * The resting Island pill: 6 x 46 dp, black with the 30% white rim, inset 3 dp from the screen edge.
 * It never animates while it sits still. A pulling finger stretches it toward the middle of the
 * screen like rubber and a mic fades in; past the threshold the rim turns mint.
 */
@Composable
internal fun RestingPill(ui: FlowBarUi) {
    val density = LocalDensity.current
    var entered by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { entered = true }
    val appear by animateFloatAsState(if (entered && ui.pillShown) 1f else 0f, spring(0.8f, 320f), label = "pillAppear")
    val armedAmount by animateFloatAsState(if (ui.armed) 1f else 0f, tween(120), label = "pillArmed")
    val stretch = remember { Animatable(0f) }
    LaunchedEffect(ui.dragging, ui.stretchPx) {
        if (ui.dragging) stretch.snapTo(ui.stretchPx) else stretch.animateTo(0f, spring(0.55f, 420f))
    }
    val right = ui.side == BarSide.RIGHT
    val stretchDp = with(density) { stretch.value.toDp() }
    val shape = RoundedCornerShape(percent = 50)
    Box(Modifier.fillMaxSize(), contentAlignment = if (right) Alignment.CenterEnd else Alignment.CenterStart) {
        Box(
            Modifier
                .padding(start = if (right) 0.dp else FlowBarMetrics.PILL_EDGE_INSET.dp, end = if (right) FlowBarMetrics.PILL_EDGE_INSET.dp else 0.dp)
                .graphicsLayer {
                    alpha = appear
                    translationX = (1f - appear) * (if (right) 1f else -1f) * 14.dp.toPx()
                }
                .size(
                    FlowBarMetrics.PILL_WIDTH.dp + stretchDp,
                    (FlowBarMetrics.PILL_HEIGHT.dp - stretchDp * 0.12f).coerceAtLeast(40.dp)
                )
                .background(IslandColors.body, shape)
                .border(1.dp, lerp(IslandColors.rim, IslandColors.mint, armedAmount), shape),
            contentAlignment = Alignment.Center
        ) {
            if (stretchDp > 16.dp) {
                Icon(
                    Icons.Rounded.Mic, contentDescription = null,
                    tint = lerp(Color.White, IslandColors.mint, armedAmount),
                    modifier = Modifier.size(16.dp).graphicsLayer { alpha = ((stretchDp.toPx() - 16.dp.toPx()) / 14.dp.toPx()).coerceIn(0f, 1f) }
                )
            }
        }
    }
}

/**
 * The capsule window's content: the compact capsule, flush with the screen edge the pill sits on. It
 * springs open from that edge when it appears and shrinks back toward it when it goes.
 */
@Composable
internal fun CapsuleHost(ui: FlowBarUi) {
    val visible = remember { MutableTransitionState(false) }
    visible.targetState = ui.capsuleShown
    val right = ui.side == BarSide.RIGHT
    val origin = TransformOrigin(if (right) 1f else 0f, 0.5f)
    Box(Modifier.fillMaxSize(), contentAlignment = if (right) Alignment.CenterEnd else Alignment.CenterStart) {
        AnimatedVisibility(
            visibleState = visible,
            enter = fadeIn(tween(110)) + scaleIn(spring(dampingRatio = 0.78f, stiffness = 170f), initialScale = 0.4f, transformOrigin = origin),
            exit = fadeOut(tween(140)) + scaleOut(tween(160), targetScale = 0.86f, transformOrigin = origin)
        ) {
            IslandCapsule(
                mode = ui.mode, level = ui.level, label = ui.label, actionLabel = ui.actionLabel, compact = true,
                onTap = { ui.onTap() }, onCancel = { ui.onCancel() }, onStop = { ui.onStop() }, onAction = { ui.onAction() }
            )
        }
    }
}

/** Throwaway content for the start-up warm-up: touches every composable the flow bar will use. */
@Composable
internal fun WarmUpContent(ui: FlowBarUi) {
    LaunchedEffect(Unit) {
        for (next in listOf(IslandMode.PROCESSING, IslandMode.DONE, IslandMode.ERROR, IslandMode.RECORDING)) {
            kotlinx.coroutines.delay(140)
            ui.mode = next
        }
    }
    Box(Modifier.fillMaxSize()) {
        RestingPill(ui)
        CapsuleHost(ui)
    }
}
