@file:OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class, androidx.compose.ui.ExperimentalComposeUiApi::class)

package com.voxden.android.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.core.animateFloat
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import kotlin.math.floor

/** A tappable surface: springs to a slightly raised colour and scale while pressed. Everything tappable builds on this. */
@Composable
fun Pressable(
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    shape: Shape = Vox.card,
    color: Color = Vox.surface,
    pressedColor: Color = Vox.raised,
    border: Color? = Vox.hairline,
    enabled: Boolean = true,
    pressedScale: Float = 1f,
    haptic: Haptic? = null,
    onLongClick: (() -> Unit)? = null,
    role: Role? = Role.Button,
    contentAlignment: Alignment = Alignment.TopStart,
    content: @Composable BoxScope.() -> Unit
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val active = pressed && enabled
    val background by animateColorAsState(if (active) pressedColor else color, VoxMotion.spring(), label = "pressable-color")
    val scale by animateFloatAsState(if (active) pressedScale else 1f, VoxMotion.spring(), label = "pressable-scale")
    val perform = rememberHaptics()
    Box(
        modifier
            .graphicsLayer { scaleX = scale; scaleY = scale }
            .clip(shape)
            .background(background)
            .then(if (border != null) Modifier.border(1.dp, border, shape) else Modifier)
            .then(
                if (onClick != null) Modifier.combinedClickable(
                    interactionSource = source, indication = null, enabled = enabled, role = role,
                    onLongClick = onLongClick?.let { long -> { perform(Haptic.TICK); long() } },
                    onClick = { haptic?.let(perform); onClick() }
                ) else Modifier
            ),
        contentAlignment = contentAlignment,
        content = content
    )
}

/** The iOS-style spinner the Island uses: twelve spokes, the leading one brightest, stepping once per twelfth. */
@Composable
fun VoxSpinner(modifier: Modifier = Modifier, size: Dp = 20.dp, color: Color = Vox.text2) {
    val transition = rememberInfiniteTransition(label = "spinner")
    val phase by transition.animateFloat(0f, 12f, infiniteRepeatable(tween(1000, easing = LinearEasing)), label = "spinner-phase")
    Canvas(modifier.size(size)) {
        val head = floor(phase).toInt()
        val outer = this.size.minDimension / 2f
        val inner = outer * 0.52f
        for (i in 0 until 12) {
            val behind = ((head - i) % 12 + 12) % 12
            val alpha = 1f - behind / 12f * 0.82f
            rotate(degrees = i * 30f, pivot = center) {
                drawLine(color.copy(alpha = alpha), Offset(center.x, center.y - outer), Offset(center.x, center.y - inner),
                    strokeWidth = outer * 0.17f, cap = StrokeCap.Round)
            }
        }
    }
}

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
    fullWidth: Boolean = true,
    haptic: Haptic? = Haptic.TICK
) {
    val live = enabled || loading
    Pressable(
        onClick = if (loading) null else onClick,
        modifier = modifier.then(if (fullWidth) Modifier.fillMaxWidth() else Modifier).height(54.dp),
        shape = Vox.pill,
        color = if (live) Vox.mint else Vox.hairline,
        pressedColor = Color(0xFF86DBB0),
        border = null, enabled = enabled && !loading, pressedScale = 0.98f, haptic = haptic,
        contentAlignment = Alignment.Center
    ) {
        Row(Modifier.padding(horizontal = 24.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (loading) VoxSpinner(size = 20.dp, color = Vox.onMint)
            else {
                if (icon != null) Icon(icon, null, Modifier.size(20.dp), tint = if (live) Vox.onMint else Vox.text3)
                Text(text, style = VoxType.button.copy(color = if (live) Vox.onMint else Vox.text3), maxLines = 1)
            }
        }
    }
}

@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    textColor: Color = Vox.text,
    compact: Boolean = false,
    fullWidth: Boolean = true
) {
    Pressable(
        onClick = onClick,
        modifier = modifier.then(if (fullWidth) Modifier.fillMaxWidth() else Modifier).height(if (compact) 46.dp else 54.dp),
        shape = Vox.pill, color = Color.Transparent, pressedColor = Vox.raised, border = Vox.hairlineStrong,
        enabled = enabled, pressedScale = 0.98f, haptic = Haptic.TICK, contentAlignment = Alignment.Center
    ) {
        Row(Modifier.padding(horizontal = 22.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (icon != null) Icon(icon, null, Modifier.size(20.dp), tint = if (enabled) textColor else Vox.text3)
            Text(text, style = VoxType.button.copy(color = if (enabled) textColor else Vox.text3), maxLines = 1)
        }
    }
}

/** A quiet text-only action with a 44dp target. */
@Composable
fun TextAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, color: Color = Vox.text2, enabled: Boolean = true) {
    Pressable(
        onClick = onClick, modifier = modifier.heightIn(min = 44.dp), shape = Vox.pill, color = Color.Transparent,
        pressedColor = Vox.raised, border = null, enabled = enabled, contentAlignment = Alignment.Center
    ) {
        Text(text, Modifier.padding(horizontal = 14.dp), style = VoxType.buttonSmall.copy(color = if (enabled) color else Vox.text3))
    }
}

/** The small inline actions on a dictation row: Copy, Polish, Share. */
@Composable
fun ActionPill(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    loading: Boolean = false,
    enabled: Boolean = true,
    tint: Color = Vox.text2
) {
    Pressable(
        onClick = if (loading) null else onClick, modifier = modifier.height(36.dp), shape = Vox.pill,
        color = Color.Transparent, pressedColor = Vox.raised, border = null, enabled = enabled, haptic = Haptic.TICK,
        contentAlignment = Alignment.Center
    ) {
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (loading) VoxSpinner(size = 16.dp, color = tint)
            else Icon(icon, null, Modifier.size(18.dp), tint = if (enabled) tint else Vox.text3)
            Text(label, style = VoxType.buttonSmall.copy(color = if (enabled) tint else Vox.text3), maxLines = 1)
        }
    }
}

@Composable
fun RoundIconButton(
    icon: ImageVector,
    description: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 40.dp,
    container: Color = Vox.raised,
    border: Color? = Vox.hairline,
    tint: Color = Vox.text2
) {
    Pressable(
        onClick = onClick,
        modifier = modifier.size(size).semantics { contentDescription = description },
        shape = CircleShape, color = container, pressedColor = Vox.hairline, border = border, pressedScale = 0.94f,
        haptic = Haptic.TICK, contentAlignment = Alignment.Center
    ) { Icon(icon, null, Modifier.size(22.dp), tint = tint) }
}

/** A switch with a mint track when on and a dark thumb, no shadow. */
@Composable
fun VoxSwitch(checked: Boolean, onCheckedChange: ((Boolean) -> Unit)?, modifier: Modifier = Modifier) {
    val track by animateColorAsState(if (checked) Vox.mint else Vox.raised, VoxMotion.spring(), label = "switch-track")
    val thumb by animateColorAsState(if (checked) Vox.onMint else Vox.text3, VoxMotion.spring(), label = "switch-thumb")
    val offset by animateDpAsState(if (checked) 22.dp else 0.dp, VoxMotion.spring(), label = "switch-offset")
    val haptic = rememberHaptics()
    Box(
        modifier
            .size(52.dp, 32.dp)
            .clip(CircleShape)
            .background(track)
            .border(1.dp, if (checked) Color.Transparent else Vox.hairlineStrong, CircleShape)
            .then(if (onCheckedChange != null) Modifier.toggleable(checked, role = Role.Switch) { haptic(Haptic.TICK); onCheckedChange(it) } else Modifier)
    ) {
        Box(Modifier.padding(start = 4.dp).offset { IntOffset(offset.roundToPx(), 0) }.align(Alignment.CenterStart).size(24.dp).clip(CircleShape).background(thumb))
    }
}

/** A pill segmented control with a sliding indicator. */
@Composable
fun <T> Segmented(
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    track: Color = Vox.canvas,
    height: Dp = 40.dp
) {
    val haptic = rememberHaptics()
    val index = options.indexOfFirst { it.first == selected }.coerceAtLeast(0)
    BoxWithConstraints(
        modifier.height(height).clip(CircleShape).background(track).border(1.dp, Vox.hairline, CircleShape).padding(3.dp)
    ) {
        val segment = maxWidth / options.size
        val x by animateDpAsState(segment * index, VoxMotion.spring(), label = "segment-x")
        Box(Modifier.offset { IntOffset(x.roundToPx(), 0) }.width(segment).fillMaxSize().clip(CircleShape).background(Vox.hairlineStrong))
        Row(Modifier.fillMaxSize()) {
            options.forEachIndexed { i, (value, label) ->
                val color by animateColorAsState(if (i == index) Vox.text else Vox.text3, VoxMotion.spring(), label = "segment-color")
                Box(
                    Modifier.weight(1f).fillMaxSize().clip(CircleShape)
                        .toggleable(i == index, role = Role.RadioButton) { if (i != index) { haptic(Haptic.TICK); onSelect(value) } },
                    contentAlignment = Alignment.Center
                ) { Text(label, style = VoxType.buttonSmall.copy(color = color), maxLines = 1) }
            }
        }
    }
}

/** The text input: a raised container, hairlineStrong border while focused, mint cursor. */
@Composable
fun VoxField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else Int.MAX_VALUE,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    shape: Shape = Vox.pill,
    container: Color = Vox.raised,
    textStyle: TextStyle = VoxType.body,
    enabled: Boolean = true,
    readOnly: Boolean = false,
    focusRequester: FocusRequester? = null,
    contentPadding: PaddingValues = PaddingValues(horizontal = 18.dp, vertical = 15.dp),
    minHeight: Dp = if (singleLine) 54.dp else 0.dp,
    visualTransformation: VisualTransformation = VisualTransformation.None
) {
    val source = remember { MutableInteractionSource() }
    val focused by source.collectIsFocusedAsState()
    val borderColor by animateColorAsState(if (focused) Vox.hairlineStrong else Vox.hairline, VoxMotion.spring(), label = "field-border")
    BasicTextField(
        value = value, onValueChange = onValueChange,
        modifier = modifier.then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier),
        enabled = enabled, readOnly = readOnly, textStyle = textStyle, interactionSource = source,
        cursorBrush = SolidColor(Vox.mint), singleLine = singleLine, minLines = minLines, maxLines = maxLines,
        keyboardOptions = keyboardOptions, keyboardActions = keyboardActions, visualTransformation = visualTransformation,
        decorationBox = { inner ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = minHeight).clip(shape).background(container).border(1.dp, borderColor, shape).padding(contentPadding),
                verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                if (leading != null) leading()
                Box(Modifier.weight(1f), contentAlignment = if (singleLine) Alignment.CenterStart else Alignment.TopStart) {
                    if (value.isEmpty()) Text(placeholder, style = textStyle.copy(color = Vox.text3), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                }
                if (trailing != null) trailing()
            }
        }
    )
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, trailing: String? = null) {
    Row(modifier.fillMaxWidth().padding(start = 6.dp, end = 6.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), style = VoxType.label)
        if (trailing != null) Text(trailing, style = VoxType.meta)
    }
}

/** An inset grouped list: 22dp radius, hairline outline, rows separated by [GroupDivider]. */
@Composable
fun SettingsGroup(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().clip(Vox.card).background(Vox.surface).border(1.dp, Vox.hairline, Vox.card), content = content)
}

/** The 1dp divider between grouped rows, inset 52dp so it starts under the text. */
@Composable
fun GroupDivider(inset: Dp = 52.dp) {
    Box(Modifier.fillMaxWidth().padding(start = inset).height(1.dp).background(Vox.hairline))
}

@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    subtitle: String? = null,
    titleColor: Color = Vox.text,
    iconTint: Color = Vox.text2,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    chevron: Boolean = false,
    trailing: (@Composable () -> Unit)? = null
) {
    Pressable(
        onClick = onClick ?: if (onLongClick != null) ({}) else null, onLongClick = onLongClick, modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(0.dp), color = Color.Transparent, pressedColor = Vox.raised, border = null, role = Role.Button
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            if (icon != null) {
                Icon(icon, null, Modifier.size(22.dp), tint = iconTint)
                Box(Modifier.width(14.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = VoxType.bodyMedium.copy(color = titleColor))
                if (subtitle != null) Text(subtitle, style = VoxType.bodySmall.copy(fontSize = 13.sp, lineHeight = 18.sp))
            }
            if (trailing != null) { Box(Modifier.width(12.dp)); trailing() }
            if (chevron) { Box(Modifier.width(4.dp)); Icon(Icons.Rounded.ChevronRight, null, Modifier.size(22.dp), tint = Vox.text3) }
        }
    }
}

/** The check that draws itself when a setup step turns on. */
@Composable
fun CheckBadge(on: Boolean, modifier: Modifier = Modifier, size: Dp = 28.dp) {
    val fill by animateColorAsState(if (on) Vox.mint else Color.Transparent, VoxMotion.spring(), label = "check-fill")
    val ring by animateColorAsState(if (on) Color.Transparent else Vox.hairlineStrong, VoxMotion.spring(), label = "check-ring")
    val draw by animateFloatAsState(if (on) 1f else 0f, tween(if (on) 320 else 120), label = "check-draw")
    val pop by animateFloatAsState(if (on) 1f else 0.9f, VoxMotion.spring(), label = "check-pop")
    Canvas(modifier.size(size).graphicsLayer { scaleX = pop; scaleY = pop }) {
        drawCircle(fill)
        drawCircle(ring, radius = this.size.minDimension / 2f - 0.75.dp.toPx(), style = Stroke(1.5.dp.toPx()))
        if (draw > 0f) {
            val s = this.size.minDimension
            val path = Path().apply {
                moveTo(s * 0.29f, s * 0.52f); lineTo(s * 0.44f, s * 0.67f); lineTo(s * 0.72f, s * 0.35f)
            }
            val measure = PathMeasure().apply { setPath(path, false) }
            val partial = Path()
            measure.getSegment(0f, measure.length * draw.coerceIn(0f, 1f), partial, true)
            drawPath(partial, Vox.onMint, style = Stroke(2.4.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

@Composable
fun PlanChip(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Pressable(
        onClick = onClick, modifier = modifier.height(32.dp).semantics { contentDescription = "Plan: $text. Opens your account." },
        shape = Vox.pill, color = Vox.mintTint, pressedColor = Color(0xFF1C2E25), border = null, pressedScale = 0.96f,
        haptic = Haptic.TICK, contentAlignment = Alignment.Center
    ) { Text(text, Modifier.padding(horizontal = 13.dp), style = VoxType.chip.copy(color = Vox.mint), maxLines = 1) }
}

/** A short message pill that slides in from the top. */
@Composable
fun VoxToast(message: String, isError: Boolean, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(20.dp)
    Row(
        modifier.widthIn(max = 420.dp).clip(shape).background(Vox.raised).border(1.dp, Vox.hairlineStrong, shape)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        if (isError) Box(Modifier.size(8.dp).clip(CircleShape).background(Vox.danger))
        Text(message, style = VoxType.bodySmall.copy(color = Vox.text), maxLines = 4, overflow = TextOverflow.Ellipsis)
    }
}

/** The sheet's grab handle with the hairline outline along its top edge. */
@Composable
private fun SheetChrome() {
    Box(
        Modifier.fillMaxWidth().height(28.dp).drawBehind {
            val r = 28.dp.toPx()
            val inset = 0.5.dp.toPx()
            val w = size.width
            val path = Path().apply {
                moveTo(inset, r)
                arcTo(androidx.compose.ui.geometry.Rect(inset, inset, inset + 2 * (r - inset), inset + 2 * (r - inset)), 180f, 90f, false)
                lineTo(w - r, inset)
                arcTo(androidx.compose.ui.geometry.Rect(w - inset - 2 * (r - inset), inset, w - inset, inset + 2 * (r - inset)), 270f, 90f, false)
            }
            drawPath(path, Vox.hairlineStrong, style = Stroke(1.dp.toPx()))
        },
        contentAlignment = Alignment.TopCenter
    ) { Box(Modifier.padding(top = 10.dp).size(36.dp, 4.dp).clip(CircleShape).background(Vox.hairlineStrong)) }
}

/**
 * Voxden's bottom sheet: raised surface, 28dp top radius, hairline edge, no shadow.
 * The content handles its own gutters; this adds the navigation-bar and keyboard insets.
 */
@Composable
fun VoxSheet(onDismiss: () -> Unit, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = Vox.sheet, containerColor = Vox.raised, contentColor = Vox.text, scrimColor = Vox.scrim, tonalElevation = 0.dp,
        dragHandle = null, contentWindowInsets = { WindowInsets(0, 0, 0, 0) }
    ) {
        DarkSheetBars()
        Column(modifier.fillMaxWidth().semantics { testTagsAsResourceId = true }.navigationBarsPadding().imePadding()) {
            SheetChrome()
            content()
        }
    }
}

/**
 * A sheet lives in its own window, which otherwise picks light system-bar icons and, under three-button
 * navigation, a light contrast scrim: a pale strip under a dark sheet. Keep its bars dark like the app's.
 */
@Composable
private fun DarkSheetBars() {
    val view = androidx.compose.ui.platform.LocalView.current
    androidx.compose.runtime.SideEffect {
        var parent: android.view.ViewParent? = view.parent
        while (parent != null && parent !is androidx.compose.ui.window.DialogWindowProvider) parent = parent.parent
        val window = (parent as? androidx.compose.ui.window.DialogWindowProvider)?.window ?: return@SideEffect
        if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        androidx.core.view.WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightNavigationBars = false
            isAppearanceLightStatusBars = false
        }
    }
}

/** A confirmation dialog in the app's own surfaces. The destructive action reads in danger red. */
@Composable
fun VoxDialog(
    title: String,
    body: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = true,
    dismissLabel: String = "Cancel"
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(
            Modifier.padding(horizontal = 24.dp).widthIn(max = 360.dp).clip(Vox.dialog).background(Vox.raised)
                .border(1.dp, Vox.hairlineStrong, Vox.dialog).padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(title, style = VoxType.title)
            Text(body, style = VoxType.bodySmall.copy(fontSize = 15.sp, lineHeight = 22.sp))
            Box(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SecondaryButton(dismissLabel, onDismiss, Modifier.weight(1f), compact = true)
                SecondaryButton(confirmLabel, onConfirm, Modifier.weight(1f), compact = true,
                    textColor = if (destructive) Vox.danger else Vox.text)
            }
        }
    }
}

/** A thin progress line: 3dp, hairline track, mint fill that springs to its value. */
@Composable
fun ThinProgress(fraction: Float, modifier: Modifier = Modifier) {
    val value by animateFloatAsState(fraction.coerceIn(0f, 1f), VoxMotion.spring(), label = "progress")
    Box(modifier.fillMaxWidth().height(3.dp).clip(CircleShape).background(Vox.hairline)) {
        Box(Modifier.fillMaxWidth(value).fillMaxSize().clip(CircleShape).background(Vox.mint))
    }
}

/** Centred empty-state block with an optional accent line in Instrument Serif. */
@Composable
fun EmptyBlock(title: androidx.compose.ui.text.AnnotatedString, body: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(horizontal = 36.dp), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = VoxType.display.copy(fontSize = 28.sp, lineHeight = 34.sp), textAlign = TextAlign.Center)
        Text(body, style = VoxType.body.copy(color = Vox.text2), textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 300.dp))
    }
}
