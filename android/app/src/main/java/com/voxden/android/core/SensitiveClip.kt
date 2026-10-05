package com.voxden.android.core

import android.content.ClipData
import android.os.PersistableBundle

/** The one way dictated text goes on the clipboard, so none of it is left unflagged. */
object SensitiveClip {
    /**
     * Keeps the text out of Android 13+'s clipboard preview, since dictations can be private. The extra's
     * name is spelled out because the constant is API 33 and Android 12 and older simply ignore the extra.
     */
    fun of(text: String): ClipData = ClipData.newPlainText("Voxden dictation", text).apply {
        description.extras = PersistableBundle().apply { putBoolean("android.content.extra.IS_SENSITIVE", true) }
    }
}
