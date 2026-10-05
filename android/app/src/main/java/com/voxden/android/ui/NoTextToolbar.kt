package com.voxden.android.ui

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.platform.TextToolbar
import androidx.compose.ui.platform.TextToolbarStatus

/**
 * A text toolbar that never shows anything. The sign-in code's hidden text field is given this so it can never ask
 * Android for a floating Cut / Copy / Paste menu: that menu is platform code that differs by phone maker, and the
 * code boxes paste by themselves (see `CodeField`).
 */
internal object NoTextToolbar : TextToolbar {
    override val status: TextToolbarStatus get() = TextToolbarStatus.Hidden

    override fun showMenu(
        rect: Rect,
        onCopyRequested: (() -> Unit)?,
        onPasteRequested: (() -> Unit)?,
        onCutRequested: (() -> Unit)?,
        onSelectAllRequested: (() -> Unit)?
    ) = Unit

    override fun hide() = Unit
}
