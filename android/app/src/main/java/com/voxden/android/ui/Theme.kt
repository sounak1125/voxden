package com.voxden.android.ui

import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.os.Build

/** Voxden's design tokens (DESIGN.md): one canvas, three surface steps, hairlines instead of shadows, one mint accent. */
object Vox {
    val canvas = Color(0xFF0B0C0D)
    val surface = Color(0xFF141618)
    val raised = Color(0xFF1B1E21)
    val hairline = Color(0xFF24282B)
    val hairlineStrong = Color(0xFF30363A)
    val text = Color(0xFFEEF1EF)
    val text2 = Color(0xFFA3ADA6)
    val text3 = Color(0xFF6E7872)
    val mint = Color(0xFF9CF3C4)
    val onMint = Color(0xFF0E2A1C)
    val mintTint = Color(0xFF16241D)
    val danger = Color(0xFFFF6B61)
    val scrim = Color(0x99000000)

    val card = RoundedCornerShape(22.dp)
    val sheet = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
    val dialog = RoundedCornerShape(28.dp)
    val pill = CircleShape

    val gutter = 20.dp
}

// Kept for code outside this workstream that still names the old tokens.
val VoxdenMint = Vox.mint
val VoxdenOnMint = Vox.onMint
val VoxdenFrame = Vox.canvas

/** Motion: UI springs everywhere, never linear slides. */
object VoxMotion {
    fun <T> spring(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.85f, stiffness = 380f)
    /** Slower, with a touch of overshoot: the Island's own morph. */
    fun <T> island(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.78f, stiffness = 170f)
}

private val Trimless = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None)

/** Typography (DESIGN.md): Sora for display and titles, Inter for everything you read. */
object VoxType {
    val display = TextStyle(fontFamily = SoraFamily, fontWeight = FontWeight.SemiBold, fontSize = 30.sp,
        lineHeight = 36.sp, letterSpacing = (-0.6).sp, color = Vox.text, lineHeightStyle = Trimless)
    val hero = TextStyle(fontFamily = SoraFamily, fontWeight = FontWeight.SemiBold, fontSize = 42.sp,
        lineHeight = 48.sp, letterSpacing = (-1.1).sp, color = Vox.text, lineHeightStyle = Trimless)
    val title = TextStyle(fontFamily = SoraFamily, fontWeight = FontWeight.SemiBold, fontSize = 22.sp,
        lineHeight = 28.sp, letterSpacing = (-0.3).sp, color = Vox.text, lineHeightStyle = Trimless)
    val brand = TextStyle(fontFamily = SoraFamily, fontWeight = FontWeight.SemiBold, fontSize = 20.sp,
        lineHeight = 24.sp, letterSpacing = (-0.3).sp, color = Vox.text, lineHeightStyle = Trimless)
    val body = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 16.sp,
        lineHeight = 24.sp, color = Vox.text, lineHeightStyle = Trimless)
    val bodyMedium = body.copy(fontWeight = FontWeight.Medium)
    val bodySmall = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 14.sp,
        lineHeight = 21.sp, color = Vox.text2, lineHeightStyle = Trimless)
    val dictation = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Normal, fontSize = 17.sp,
        lineHeight = 26.sp, color = Vox.text, lineHeightStyle = Trimless)
    val meta = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 13.sp,
        lineHeight = 18.sp, color = Vox.text3, fontFeatureSettings = "tnum", lineHeightStyle = Trimless)
    val label = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 13.sp,
        lineHeight = 18.sp, color = Vox.text3, lineHeightStyle = Trimless)
    val button = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.SemiBold, fontSize = 16.sp,
        lineHeight = 20.sp, color = Vox.text, lineHeightStyle = Trimless)
    val buttonSmall = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 14.sp,
        lineHeight = 18.sp, color = Vox.text2, lineHeightStyle = Trimless)
    val chip = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 13.sp,
        lineHeight = 16.sp, color = Vox.text2, fontFeatureSettings = "tnum", lineHeightStyle = Trimless)
    val nav = TextStyle(fontFamily = InterFamily, fontWeight = FontWeight.Medium, fontSize = 12.sp,
        lineHeight = 14.sp, color = Vox.text3, lineHeightStyle = Trimless)
}

/** What a haptic means, mapped to the best constant the running Android version has. */
enum class Haptic { TICK, CONFIRM, REJECT, THRESHOLD }

@android.annotation.SuppressLint("InlinedApi")
fun View.vox(kind: Haptic) {
    val api = Build.VERSION.SDK_INT
    val constant = when (kind) {
        Haptic.TICK -> HapticFeedbackConstants.CLOCK_TICK
        Haptic.CONFIRM -> if (api >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.CONTEXT_CLICK
        Haptic.REJECT -> if (api >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
        Haptic.THRESHOLD -> if (api >= 34) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CLOCK_TICK
    }
    performHapticFeedback(constant)
}

/** The user's haptics setting (Settings > Flow bar > Haptics) as a composition-wide switch. */
val LocalHapticsEnabled = compositionLocalOf { true }

/** Returns a function that performs [Haptic] feedback when the user has haptics on. */
@Composable
fun rememberHaptics(): (Haptic) -> Unit {
    val view = LocalView.current
    val enabled = LocalHapticsEnabled.current
    return remember(view, enabled) { { kind -> if (enabled) view.vox(kind) } }
}

private val DarkColors = darkColorScheme(
    primary = Vox.mint, onPrimary = Vox.onMint,
    background = Vox.canvas, onBackground = Vox.text,
    surface = Vox.raised, onSurface = Vox.text,
    surfaceVariant = Vox.surface, onSurfaceVariant = Vox.text2,
    surfaceTint = Color.Transparent,
    surfaceContainer = Vox.raised, surfaceContainerLow = Vox.surface, surfaceContainerLowest = Vox.canvas,
    surfaceContainerHigh = Vox.raised, surfaceContainerHighest = Vox.raised,
    outline = Vox.hairlineStrong, outlineVariant = Vox.hairline,
    error = Vox.danger, onError = Vox.canvas, scrim = Color.Black
)

/** Dark only in this build. */
@Composable
fun VoxdenTheme(dark: Boolean = true, content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors) {
        CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides Vox.text, content = content)
    }
}
