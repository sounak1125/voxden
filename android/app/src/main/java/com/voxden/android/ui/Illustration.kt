package com.voxden.android.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.sp
import androidx.compose.ui.util.lerp
import com.voxden.android.ui.island.IslandColors
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sin

private const val LoopMillis = 8600

/**
 * The welcome illustration, drawn in Compose and looping: the resting pill on the screen edge is pulled inward,
 * springs open into the recording capsule above the keyboard, listens, transcribes, types the words into the
 * page, and folds back to the edge.
 */
@Composable
fun IslandPullIllustration(modifier: Modifier = Modifier) {
    val transition = rememberInfiniteTransition(label = "illustration")
    val loop by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(LoopMillis, easing = LinearEasing)), label = "illustration-t")
    val t = DebugHooks.illustrationT ?: loop
    val measurer = rememberTextMeasurer()
    Canvas(modifier) { drawScene(t, measurer) }
}

private fun ease(u: Float): Float { val x = u.coerceIn(0f, 1f); return x * x * (3f - 2f * x) }
private fun easeOutBack(u: Float): Float {
    val x = u.coerceIn(0f, 1f) - 1f
    return 1f + 2.1f * x * x * x + 1.1f * x * x
}
private fun seg(t: Float, from: Float, to: Float) = ((t - from) / (to - from)).coerceIn(0f, 1f)

private data class Box4(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width get() = right - left
    val height get() = bottom - top
    val centerY get() = (top + bottom) / 2f
    fun lerpTo(o: Box4, f: Float) = Box4(lerp(left, o.left, f), lerp(top, o.top, f), lerp(right, o.right, f), lerp(bottom, o.bottom, f))
}

private fun DrawScope.drawScene(t: Float, measurer: TextMeasurer) {
    val w = size.width
    val h = size.height
    val d = density
    fun dp(v: Float) = v * d

    // The page behind: a quiet note with a few words already in it.
    val keyboardTop = h - dp(150f)
    drawRoundRect(Vox.raised, Offset(dp(22f), dp(26f)), Size(w * 0.34f, dp(10f)), CornerRadius(dp(5f)))
    val baseStyle = TextStyle(fontFamily = InterFamily, fontSize = 15.sp, color = Vox.text3)
    val typedStyle = baseStyle.copy(color = Vox.text)
    val lead = measurer.measure("Hi Maya, ", baseStyle)
    val lineTop = dp(58f)
    drawText(lead, topLeft = Offset(dp(22f), lineTop))
    val full = "I'll be there by seven."
    val shown = full.take(((full.length) * ((seg(t, 0.795f, 0.87f))).let { ease(it) } + 0.001f).toInt().coerceAtMost(full.length))
    val typedLayout = if (shown.isNotEmpty()) measurer.measure(shown, typedStyle) else null
    val fade = 1f - ease(seg(t, 0.965f, 0.995f))
    if (typedLayout != null && fade > 0f) drawText(typedLayout, topLeft = Offset(dp(22f) + lead.size.width, lineTop), alpha = fade)
    // Caret
    val caretX = dp(22f) + lead.size.width + ((typedLayout?.size?.width ?: 0) * (if (fade > 0f) 1f else 0f))
    val blink = 0.35f + 0.65f * (0.5f + 0.5f * sin(t * LoopMillis / 1000f * 2f * PI.toFloat() * 1.2f))
    drawRoundRect(Vox.mint.copy(alpha = blink), Offset(caretX + dp(1f), lineTop + dp(1f)), Size(dp(1.6f), dp(18f)), CornerRadius(dp(1f)))
    drawRoundRect(Vox.raised, Offset(dp(22f), lineTop + dp(34f)), Size(w * 0.5f, dp(8f)), CornerRadius(dp(4f)))
    drawRoundRect(Vox.raised, Offset(dp(22f), lineTop + dp(54f)), Size(w * 0.38f, dp(8f)), CornerRadius(dp(4f)))

    // The keyboard.
    drawRect(Vox.canvas, Offset(0f, keyboardTop), Size(w, h - keyboardTop))
    drawRect(Vox.hairline, Offset(0f, keyboardTop), Size(w, dp(1f)))
    val rows = listOf(10, 9, 7)
    val keyH = dp(26f)
    val gap = dp(6f)
    rows.forEachIndexed { r, count ->
        val rowW = w - dp(24f) - (if (r == 1) dp(18f) else if (r == 2) dp(58f) else 0f)
        val keyW = (rowW - gap * (count - 1)) / count
        val startX = (w - (keyW * count + gap * (count - 1))) / 2f
        for (i in 0 until count) {
            drawRoundRect(Vox.raised, Offset(startX + i * (keyW + gap), keyboardTop + dp(14f) + r * (keyH + gap)), Size(keyW, keyH), CornerRadius(dp(6f)))
        }
    }
    drawRoundRect(Vox.raised, Offset(dp(12f) + w * 0.18f, keyboardTop + dp(14f) + 3 * (keyH + gap)), Size(w * 0.5f, keyH), CornerRadius(dp(6f)))

    // Geometry of the pill, the stretched pill, and the capsule.
    val restY = h * 0.34f
    val restRight = w - dp(3f)
    val restBox = Box4(restRight - dp(6f), restY - dp(23f), restRight, restY + dp(23f))
    val pullAmount = dp(120f) * ease(seg(t, 0.10f, 0.30f))
    val stretch = Box4(restRight - dp(6f) - pullAmount * 0.86f, restY - dp(23f) + min(pullAmount, dp(80f)) / dp(80f) * dp(4f), restRight, restY + dp(23f) - min(pullAmount, dp(80f)) / dp(80f) * dp(4f))
    val capsuleW = min(dp(212f), w - dp(40f))
    val capsuleCenterY = keyboardTop - dp(12f) - dp(22f)
    val recordingBox = Box4(w / 2f - capsuleW / 2f, capsuleCenterY - dp(22f), w / 2f + capsuleW / 2f, capsuleCenterY + dp(22f))

    val processingW = dp(120f)
    val doneW = dp(138f)
    val toProcessing = ease(seg(t, 0.735f, 0.775f))
    val toDone = ease(seg(t, 0.80f, 0.835f))
    val midW = lerp(lerp(capsuleW, processingW, toProcessing), doneW, toDone)
    val liveBox = Box4(w / 2f - midW / 2f, capsuleCenterY - dp(22f), w / 2f + midW / 2f, capsuleCenterY + dp(22f))

    val box: Box4 = when {
        t < 0.34f -> if (t < 0.10f) restBox else stretch
        t < 0.46f -> stretch.lerpTo(recordingBox, easeOutBack(seg(t, 0.34f, 0.46f)))
        t < 0.90f -> liveBox
        t < 0.97f -> liveBox.lerpTo(restBox, ease(seg(t, 0.90f, 0.97f)))
        else -> restBox
    }

    // The finger.
    val fingerAlpha = ease(seg(t, 0.04f, 0.10f)) * (1f - ease(seg(t, 0.30f, 0.38f)))
    if (fingerAlpha > 0f) {
        val fingerX = restRight - dp(2f) - pullAmount
        val pressed = 1f - 0.12f * ease(seg(t, 0.09f, 0.12f))
        drawCircle(Color.White.copy(alpha = 0.14f * fingerAlpha), dp(17f) * pressed, Offset(fingerX, restY))
        drawCircle(Color.White.copy(alpha = 0.36f * fingerAlpha), dp(17f) * pressed, Offset(fingerX, restY), style = Stroke(dp(1.5f)))
    }
    // The tick when the pull passes its threshold.
    val tick = seg(t, 0.205f, 0.30f)
    if (tick > 0f && tick < 1f) {
        drawCircle(IslandColors.mint.copy(alpha = 0.55f * (1f - tick)), dp(14f) + dp(26f) * ease(tick), Offset(stretch.left, restY), style = Stroke(dp(1.5f)))
    }

    // The Island itself: black, with the white 30% rim.
    val corner = CornerRadius(box.height / 2f)
    drawRoundRect(IslandColors.body, Offset(box.left, box.top), Size(box.width, box.height), corner)
    drawRoundRect(IslandColors.rim, Offset(box.left + 0.5f, box.top + 0.5f), Size(box.width - 1f, box.height - 1f), corner, style = Stroke(dp(1f)))

    // Contents.
    val recordingAlpha = ease(seg(t, 0.43f, 0.48f)) * (1f - ease(seg(t, 0.735f, 0.755f)))
    if (recordingAlpha > 0f) drawRecording(box, t, recordingAlpha)
    val processingAlpha = ease(seg(t, 0.755f, 0.78f)) * (1f - ease(seg(t, 0.79f, 0.805f)))
    if (processingAlpha > 0f) drawSpinner(Offset(box.left + box.width / 2f, box.centerY), dp(8f), t, processingAlpha)
    val doneAlpha = ease(seg(t, 0.81f, 0.84f)) * (1f - ease(seg(t, 0.90f, 0.925f)))
    if (doneAlpha > 0f) drawDone(box, measurer, doneAlpha)
}

private fun DrawScope.drawRecording(box: Box4, t: Float, alpha: Float) {
    val d = density
    fun dp(v: Float) = v * d
    val cy = box.centerY
    val leftC = Offset(box.left + dp(6f) + dp(16f), cy)
    val rightC = Offset(box.right - dp(6f) - dp(16f), cy)
    drawCircle(IslandColors.fill.copy(alpha = alpha), dp(16f), leftC)
    drawCircle(IslandColors.fill.copy(alpha = alpha), dp(16f), rightC)
    // Cancel: a red rounded x.
    val x = dp(4.2f)
    drawLine(IslandColors.red.copy(alpha = alpha), Offset(leftC.x - x, cy - x), Offset(leftC.x + x, cy + x), dp(2f), StrokeCap.Round)
    drawLine(IslandColors.red.copy(alpha = alpha), Offset(leftC.x - x, cy + x), Offset(leftC.x + x, cy - x), dp(2f), StrokeCap.Round)
    // Stop: a white rounded square.
    drawRoundRect(Color.White.copy(alpha = alpha), Offset(rightC.x - dp(5f), cy - dp(5f)), Size(dp(10f), dp(10f)), CornerRadius(dp(2.5f)))
    // Meter: eleven mint bars following a gentle voice envelope.
    val bars = 11
    val barW = dp(3f)
    val gap = dp(7.5f)
    val total = bars * barW + (bars - 1) * gap
    val startX = box.left + box.width / 2f - total / 2f
    val seconds = t * LoopMillis / 1000f
    for (i in 0 until bars) {
        val centre = 1f - abs(i - (bars - 1) / 2f) / ((bars - 1) / 2f) * 0.55f
        val voice = 0.5f + 0.5f * sin(seconds * 6.2f + i * 0.9f)
        val swell = 0.55f + 0.45f * sin(seconds * 2.1f)
        val height = dp(4f) + dp(20f) * centre * (0.25f + 0.75f * voice * swell)
        drawRoundRect(IslandColors.mint.copy(alpha = alpha), Offset(startX + i * (barW + gap), cy - height / 2f), Size(barW, height), CornerRadius(dp(2f)))
    }
}

private fun DrawScope.drawSpinner(center: Offset, radius: Float, t: Float, alpha: Float) {
    val head = floor(t * LoopMillis / 1000f * 12f).toInt()
    for (i in 0 until 12) {
        val behind = ((head - i) % 12 + 12) % 12
        val a = (1f - behind / 12f * 0.8f) * alpha
        rotate(i * 30f, center) {
            drawLine(Color.White.copy(alpha = a), Offset(center.x, center.y - radius), Offset(center.x, center.y - radius * 0.52f), radius * 0.17f * 2f, StrokeCap.Round)
        }
    }
}

private fun DrawScope.drawDone(box: Box4, measurer: TextMeasurer, alpha: Float) {
    val d = density
    fun dp(v: Float) = v * d
    val style = TextStyle(fontFamily = InterFamily, fontSize = 14.sp, color = Color.White.copy(alpha = alpha))
    val layout = measurer.measure("Inserted", style)
    val contentW = dp(16f) + dp(8f) + layout.size.width
    val startX = box.left + box.width / 2f - contentW / 2f
    val cy = box.centerY
    val path = Path().apply {
        moveTo(startX + dp(1.5f), cy + dp(0.5f)); lineTo(startX + dp(5.5f), cy + dp(4.5f)); lineTo(startX + dp(13.5f), cy - dp(4.5f))
    }
    drawPath(path, IslandColors.mint.copy(alpha = alpha), style = Stroke(dp(2.2f), cap = StrokeCap.Round, join = StrokeJoin.Round))
    drawText(layout, topLeft = Offset(startX + dp(24f), cy - layout.size.height / 2f))
}
