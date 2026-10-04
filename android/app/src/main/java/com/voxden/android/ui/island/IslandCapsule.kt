package com.voxden.android.ui.island

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.voxden.android.R
import com.voxden.android.ui.InterFamily
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/** What the Island capsule is showing. Mirrors the desktop flow bar's Island states. */
enum class IslandMode {
    /** The in-app "Dictate" capsule: icon plus [label]. Tap starts. */
    LABEL,
    /** Listening: cancel disc, live level meter, stop disc. */
    RECORDING,
    /** Transcribing or polishing: a spinner, optional [label]. */
    PROCESSING,
    /** Finished: a check, [label] (e.g. "Inserted"), optional [actionLabel] (e.g. "Polish"). */
    DONE,
    /** Something went wrong: a short [label]. */
    ERROR
}

/** Exact Island colours from the desktop's src/flow-styles.css. */
object IslandColors {
    val body = Color(0xFF000000)
    val rim = Color(0x4DFFFFFF)          // rgba(255,255,255,.30)
    val fill = Color(0xFF2C2C2E)
    val fillPressed = Color(0xFF3A3A3C)
    val secondary = Color(0x9EEBEBF5)    // rgba(235,235,245,.62)
    val mint = Color(0xFF9CF3C4)
    val red = Color(0xFFFF453A)
    val grey = Color(0xFF8E8E93)
}

/** Sizes of the capsule's parts, in dp. */
internal object IslandMetrics {
    const val HEIGHT = 44
    const val RECORDING_WIDTH = 212
    const val DISC = 32
    const val DISC_TARGET = 44
    const val PROCESSING_MIN_WIDTH = 120
    const val METER_BAR = 3
    const val METER_GAP = 5
    const val METER_HEIGHT = 28
    const val MARK = 22
    const val LABEL_MAX_WIDTH = 188
    const val ACTION_HEIGHT = 32
}

/** The meter redraws at most this often: about 30 times a second. */
private const val METER_REDRAW_NANOS = 30_000_000L

private val IslandLabelStyle = TextStyle(
    fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 15.sp, lineHeight = 20.sp,
    letterSpacing = (-0.1).sp, color = Color.White
)
private val IslandActionStyle = TextStyle(
    fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 18.sp,
    letterSpacing = (-0.05).sp, color = IslandColors.mint
)

/** The one frame the capsule is showing; a change of any part morphs the capsule. */
private data class IslandFrame(val mode: IslandMode, val label: String?, val actionLabel: String?)

/**
 * The Island capsule shared by the in-app Dictate bar and the flow bar over other apps.
 * Springs between modes (the desktop's 540 ms morph, about 2% overshoot): the capsule's width
 * rides one spring while the content of the new mode fades in 60 ms after the shape starts moving.
 * Nothing animates while it sits still except the meter (recording) and the spinner (processing).
 */
@Composable
fun IslandCapsule(
    mode: IslandMode,
    level: Float,
    modifier: Modifier = Modifier,
    label: String? = null,
    actionLabel: String? = null,
    onTap: () -> Unit = {},
    onCancel: () -> Unit = {},
    onStop: () -> Unit = {},
    onAction: () -> Unit = {}
) {
    val shape = RoundedCornerShape(percent = 50)
    val frame = IslandFrame(mode, label, if (mode == IslandMode.DONE) actionLabel else null)
    val currentLevel by rememberUpdatedState(level)
    val tap by rememberUpdatedState(onTap)
    val cancel by rememberUpdatedState(onCancel)
    val stop by rememberUpdatedState(onStop)
    val action by rememberUpdatedState(onAction)
    Box(
        modifier
            .height(IslandMetrics.HEIGHT.dp)
            .clip(shape)
            .background(IslandColors.body, shape)
            .border(1.dp, IslandColors.rim, shape)
    ) {
        AnimatedContent(
            targetState = frame,
            modifier = Modifier.fillMaxHeight(),
            transitionSpec = {
                (fadeIn(tween(240, delayMillis = 60, easing = FastOutSlowInEasing)) +
                    scaleIn(tween(300, delayMillis = 60, easing = FastOutSlowInEasing), initialScale = 0.92f))
                    .togetherWith(fadeOut(tween(70)))
                    .using(SizeTransform(clip = false) { _, _ -> spring(dampingRatio = 0.78f, stiffness = 170f, visibilityThreshold = IntSize(1, 1)) })
            },
            contentAlignment = Alignment.Center,
            label = "islandMorph"
        ) { shown ->
            when (shown.mode) {
                IslandMode.LABEL -> LabelContent(shown.label, onTap = { tap() })
                IslandMode.RECORDING -> RecordingContent({ currentLevel }, onCancel = { cancel() }, onStop = { stop() })
                IslandMode.PROCESSING -> ProcessingContent(shown.label)
                IslandMode.DONE -> DoneContent(shown.label, shown.actionLabel, onTap = { tap() }, onAction = { action() })
                IslandMode.ERROR -> ErrorContent(shown.label, onTap = { tap() })
            }
        }
    }
}

@Composable
private fun LabelContent(label: String?, onTap: () -> Unit) {
    Row(
        Modifier
            .height(IslandMetrics.HEIGHT.dp)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onTap)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Icon(Icons.Rounded.Mic, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
        IslandText(label.orEmpty(), IslandLabelStyle)
    }
}

@Composable
private fun RecordingContent(level: () -> Float, onCancel: () -> Unit, onStop: () -> Unit) {
    Row(Modifier.width(IslandMetrics.RECORDING_WIDTH.dp).height(IslandMetrics.HEIGHT.dp), verticalAlignment = Alignment.CenterVertically) {
        Disc(stringResource(R.string.island_cancel_description), onCancel) {
            Icon(Icons.Rounded.Close, contentDescription = null, tint = IslandColors.red, modifier = Modifier.size(17.dp))
        }
        val listening = stringResource(R.string.island_listening_description)
        Box(Modifier.weight(1f).fillMaxHeight().semantics { contentDescription = listening }, contentAlignment = Alignment.Center) {
            LevelMeter(level)
        }
        Disc(stringResource(R.string.island_stop_description), onStop) {
            Box(Modifier.size(10.dp).background(Color.White, RoundedCornerShape(2.5.dp)))
        }
    }
}

@Composable
private fun ProcessingContent(label: String?) {
    Row(
        Modifier.widthIn(min = IslandMetrics.PROCESSING_MIN_WIDTH.dp).height(IslandMetrics.HEIGHT.dp).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally)
    ) {
        Spinner()
        if (!label.isNullOrBlank()) IslandText(label, IslandLabelStyle.copy(color = IslandColors.secondary))
    }
}

@Composable
private fun DoneContent(label: String?, actionLabel: String?, onTap: () -> Unit, onAction: () -> Unit) {
    Row(Modifier.height(IslandMetrics.HEIGHT.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier
                .fillMaxHeight()
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onTap)
                .padding(start = 11.dp, end = if (actionLabel == null) 16.dp else 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            CheckMark()
            IslandText(label.orEmpty(), IslandLabelStyle)
        }
        if (actionLabel != null) {
            ActionPill(actionLabel, onAction)
            Spacer(Modifier.width(6.dp))
        }
    }
}

@Composable
private fun ErrorContent(label: String?, onTap: () -> Unit) {
    Row(
        Modifier
            .height(IslandMetrics.HEIGHT.dp)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Button, onClick = onTap)
            .padding(start = 11.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        ErrorMark()
        IslandText(label.orEmpty(), IslandLabelStyle)
    }
}

@Composable
private fun IslandText(text: String, style: TextStyle) {
    // A polite live region: a screen reader announces "Inserted", "Polishing", an error, when the label changes.
    BasicText(
        text, style = style, maxLines = 1, overflow = TextOverflow.Ellipsis,
        modifier = Modifier.widthIn(max = IslandMetrics.LABEL_MAX_WIDTH.dp).semantics { liveRegion = LiveRegionMode.Polite }
    )
}

/** A 32 dp disc with a 44 dp touch target, lighter while pressed. No ripple: nothing glows. */
@Composable
private fun Disc(description: String, onClick: () -> Unit, content: @Composable () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    Box(
        Modifier
            .size(IslandMetrics.DISC_TARGET.dp)
            .clickable(interactionSource = source, indication = null, role = Role.Button, onClickLabel = description, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center
    ) {
        Box(
            Modifier.size(IslandMetrics.DISC.dp).background(if (pressed) IslandColors.fillPressed else IslandColors.fill, CircleShape),
            contentAlignment = Alignment.Center
        ) { content() }
    }
}

@Composable
private fun ActionPill(label: String, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    Box(
        Modifier
            .height(IslandMetrics.ACTION_HEIGHT.dp)
            .clip(CircleShape)
            .background(if (pressed) IslandColors.fillPressed else IslandColors.fill, CircleShape)
            .clickable(interactionSource = source, indication = null, role = Role.Button, onClickLabel = label, onClick = onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center
    ) { BasicText(label, style = IslandActionStyle, maxLines = 1) }
}

/** Eleven mint bars. Heights follow the live level through a filter, so the meter glides. */
@Composable
private fun LevelMeter(level: () -> Float, modifier: Modifier = Modifier) {
    val fractions = remember { FloatArray(IslandMeter.BARS) }
    var frame by remember { mutableLongStateOf(0L) }
    LaunchedEffect(Unit) {
        var last = withFrameNanos { it }
        var lastDrawn = last
        val start = last
        while (true) {
            // At rest in a silent room there is nothing to animate: stop asking for frames.
            if (level() <= 0.001f && fractions.all { it < 0.002f }) {
                snapshotFlow { level() }.first { it > 0.001f }
                last = withFrameNanos { it }
            }
            withFrameNanos { now ->
                val dt = ((now - last) / 1_000_000_000f).coerceIn(0f, 0.1f)
                last = now
                val seconds = (now - start) / 1_000_000_000f
                var moved = false
                for (i in fractions.indices) {
                    val next = IslandMeter.smooth(fractions[i], IslandMeter.target(level(), i, seconds), dt)
                    if (abs(next - fractions[i]) > 0.0004f) moved = true
                    fractions[i] = next
                }
                // The bars glide through the filter every frame, but a redraw every other frame is
                // indistinguishable for a meter and halves what the capsule's window costs to render.
                if (moved && now - lastDrawn >= METER_REDRAW_NANOS) { frame = now; lastDrawn = now }
            }
        }
    }
    Canvas(
        modifier
            .width((IslandMeter.BARS * IslandMetrics.METER_BAR + (IslandMeter.BARS - 1) * IslandMetrics.METER_GAP).dp)
            .height(IslandMetrics.METER_HEIGHT.dp)
    ) {
        frame // read in the draw phase only: a new frame redraws, it never recomposes
        val barWidth = IslandMetrics.METER_BAR.dp.toPx()
        val gap = IslandMetrics.METER_GAP.dp.toPx()
        for (i in 0 until IslandMeter.BARS) {
            val height = IslandMeter.heightDp(fractions[i]).dp.toPx()
            drawRoundRect(
                IslandColors.mint, Offset(i * (barWidth + gap), (size.height - height) / 2f), Size(barWidth, height),
                CornerRadius(2.dp.toPx())
            )
        }
    }
}

/**
 * The iOS-style spinner: twelve spokes, white head and a grey tail, turning clockwise in whole steps
 * (twelve a second). It redraws only when a step happens, not every frame.
 */
@Composable
private fun Spinner() {
    var head by remember { mutableIntStateOf(0) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1000L / IslandSpinner.SPOKES)
            head = (head + 1) % IslandSpinner.SPOKES
        }
    }
    Canvas(Modifier.size(18.dp)) {
        val lead = head
        val centre = Offset(size.width / 2f, size.height / 2f)
        val inner = size.minDimension * 0.27f
        val outer = size.minDimension * 0.5f
        for (i in 0 until IslandSpinner.SPOKES) {
            val angle = Math.toRadians(i * 30.0 - 90.0)
            val alpha = IslandSpinner.spokeAlpha(i, lead)
            val color = androidx.compose.ui.graphics.lerp(IslandColors.grey, Color.White, ((alpha - 0.2f) / 0.8f).coerceIn(0f, 1f)).copy(alpha = alpha)
            drawLine(
                color, Offset(centre.x + cos(angle).toFloat() * inner, centre.y + sin(angle).toFloat() * inner),
                Offset(centre.x + cos(angle).toFloat() * outer, centre.y + sin(angle).toFloat() * outer),
                strokeWidth = 1.7.dp.toPx(), cap = StrokeCap.Round
            )
        }
    }
}

/** A mint disc with a black tick. */
@Composable
private fun CheckMark() {
    Canvas(Modifier.size(IslandMetrics.MARK.dp)) {
        drawCircle(IslandColors.mint)
        val unit = size.minDimension / 22f
        val tick = Path().apply {
            moveTo(6.4f * unit, 11.6f * unit); lineTo(9.7f * unit, 14.9f * unit); lineTo(15.8f * unit, 7.9f * unit)
        }
        drawPath(tick, Color.Black, style = Stroke(2.2f * unit, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
}

/** A red disc with a black exclamation mark. */
@Composable
private fun ErrorMark() {
    Canvas(Modifier.size(IslandMetrics.MARK.dp)) {
        drawCircle(IslandColors.red)
        val unit = size.minDimension / 22f
        drawLine(Color.Black, Offset(11f * unit, 6.2f * unit), Offset(11f * unit, 12.2f * unit), strokeWidth = 2.2f * unit, cap = StrokeCap.Round)
        drawCircle(Color.Black, radius = 1.25f * unit, center = Offset(11f * unit, 15.7f * unit))
    }
}
