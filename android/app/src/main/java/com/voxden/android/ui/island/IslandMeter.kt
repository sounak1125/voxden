package com.voxden.android.ui.island

import kotlin.math.exp
import kotlin.math.pow
import kotlin.math.sin

/**
 * The Island's level meter as plain maths, so the shape of the motion can be unit-tested.
 * Eleven bars; the middle ones swing most. Each bar has a fixed phase, so the variation between
 * bars is smooth and repeatable (never random flicker), and a silent room is a row of still dots.
 */
object IslandMeter {
    const val BARS = 11

    /** How far each bar may swing (0..1). A soft bell: the middle bars lead. */
    private val profile = floatArrayOf(0.46f, 0.58f, 0.72f, 0.86f, 0.96f, 1f, 0.94f, 0.84f, 0.7f, 0.56f, 0.44f)

    /** The level a bar is heading for, 0..1. [timeSeconds] drives only the slow per-bar variation. */
    fun target(level: Float, bar: Int, timeSeconds: Float): Float {
        val clamped = level.coerceIn(0f, 1f)
        if (clamped <= 0.001f) return 0f
        // Speech sits low on the scale; lift it a little so ordinary talking fills the meter.
        val shaped = clamped.pow(0.72f)
        val wobble = 0.5f + 0.5f * sin(timeSeconds * 5.2f + bar * 0.83f + bar * bar * 0.045f)
        return (profile[bar.coerceIn(0, BARS - 1)] * shaped * (0.76f + 0.24f * wobble)).coerceIn(0f, 1f)
    }

    /**
     * One step of a one-pole filter: quick to rise ([attackSeconds]) and slower to fall
     * ([releaseSeconds]), independent of the frame rate.
     */
    fun smooth(current: Float, target: Float, dtSeconds: Float, attackSeconds: Float = 0.045f, releaseSeconds: Float = 0.2f): Float {
        if (dtSeconds <= 0f) return current
        val tau = if (target > current) attackSeconds else releaseSeconds
        val alpha = 1f - exp(-dtSeconds / tau)
        return current + (target - current) * alpha
    }

    /** Bar height in dp for a smoothed fraction 0..1. */
    fun heightDp(fraction: Float, minDp: Float = MIN_HEIGHT_DP, maxDp: Float = MAX_HEIGHT_DP): Float =
        minDp + (maxDp - minDp) * fraction.coerceIn(0f, 1f)

    const val MIN_HEIGHT_DP = 4f
    const val MAX_HEIGHT_DP = 26f
}

/** The 12-spoke spinner's brightness per spoke, head first. Grey tail to white head. */
object IslandSpinner {
    const val SPOKES = 12

    /** Opacity of spoke [index] when spoke [head] leads and the others trail behind it clockwise. */
    fun spokeAlpha(index: Int, head: Int): Float {
        val behind = ((head - index) % SPOKES + SPOKES) % SPOKES
        return (1f - behind * 0.065f).coerceAtLeast(0.2f)
    }
}
