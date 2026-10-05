package com.voxden.android.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.core.text.HtmlCompat

/** Rich text from a mail app can be long; only the start is ever looked at for a code. */
private const val HTML_LIMIT = 20_000

/**
 * The text on the clipboard, or null when there is none. Safe to call from a tap: it never throws, and it never
 * opens a file or web address another app put on the clipboard (reading one is a call into that app, on the
 * main thread, which can fail or stall). Plain text is used as it is; rich text from a mail app has its markup
 * taken off, so colours and sizes in it are not mistaken for digits.
 */
fun clipboardText(context: Context): CharSequence? = try {
    val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip
    val item = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)
    item?.text ?: item?.htmlText?.let { HtmlCompat.fromHtml(it.take(HTML_LIMIT), HtmlCompat.FROM_HTML_MODE_COMPACT) }
} catch (_: Exception) {
    null
}
