package com.voxden.android.flowbar

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.InputMethod
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.view.accessibility.AccessibilityNodeInfo
import androidx.annotation.RequiresApi

/**
 * The service's seat in the input pipeline (Android 13+). With `flagInputMethodEditor` an accessibility
 * service gets a [currentInputConnection] to whatever editor the real keyboard is typing into, which
 * lets it commit text and read the text around the cursor without touching the clipboard.
 */
@RequiresApi(33)
internal class FlowBarInputMethod(
    service: AccessibilityService,
    private val onEditorChanged: () -> Unit = {}
) : InputMethod(service) {
    @Volatile var editor: EditorInfo? = null
        private set

    override fun onStartInput(attribute: EditorInfo, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        editor = attribute
        onEditorChanged()
    }

    override fun onFinishInput() {
        super.onFinishInput()
        editor = null
        onEditorChanged()
    }
}

/** An input connection as an [EditorSurface]. */
@RequiresApi(33)
internal class InputConnectionSurface(private val connection: InputMethod.AccessibilityInputConnection) : EditorSurface {
    override fun surrounding(before: Int, after: Int): Surrounding? {
        val s = connection.getSurroundingText(before.coerceAtLeast(0), after.coerceAtLeast(0), 0) ?: return null
        return Surrounding(s.text.toString(), s.selectionStart, s.selectionEnd, s.offset)
    }
    override fun commitText(text: String): Boolean { connection.commitText(text, 1, null); return true }
    override fun select(start: Int, end: Int): Boolean { connection.setSelection(start, end); return true }
    override fun deleteBeforeCursor(count: Int): Boolean { connection.deleteSurroundingText(count, 0); return true }
}

/**
 * A text node as an [EditorSurface], for Android 12 and older or editors without an input connection.
 * Edits go through ACTION_SET_TEXT with the new text merged at the selection, so the cursor lands after it.
 */
internal class NodeSurface(private val node: AccessibilityNodeInfo) : EditorSurface {
    private fun fresh(): Boolean = node.refresh()

    private fun content(): Triple<String, Int, Int>? {
        if (!fresh()) return null
        val text = if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
        val start = node.textSelectionStart.let { if (it < 0) text.length else it.coerceAtMost(text.length) }
        val end = node.textSelectionEnd.let { if (it < 0) start else it.coerceAtMost(text.length) }
        return Triple(text, start, end)
    }

    override fun surrounding(before: Int, after: Int): Surrounding? {
        val (text, start, end) = content() ?: return null
        val low = minOf(start, end)
        val high = maxOf(start, end)
        val from = (low - before).coerceAtLeast(0)
        val to = (high + after).coerceAtMost(text.length)
        return Surrounding(text.substring(from, to), start - from, end - from, from)
    }

    override fun commitText(text: String): Boolean {
        val (existing, start, end) = content() ?: return false
        val merged = mergeIntoSelection(existing, start, end, text)
        val set = setText(merged.text)
        // Best effort: Android answers false when the selection is already where we ask for it.
        if (set) select(merged.caret, merged.caret)
        return set
    }

    override fun select(start: Int, end: Int): Boolean {
        if (fresh() && node.textSelectionStart == start && node.textSelectionEnd == end) return true
        val args = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, args)
    }

    override fun deleteBeforeCursor(count: Int): Boolean {
        val (existing, start, end) = content() ?: return false
        val cursor = minOf(start, end)
        val from = (cursor - count).coerceAtLeast(0)
        val merged = existing.substring(0, from) + existing.substring(cursor)
        return setText(merged) && select(from, from)
    }

    private fun setText(text: String): Boolean = node.performAction(
        AccessibilityNodeInfo.ACTION_SET_TEXT,
        Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
    )
}

enum class TypePath { INPUT_CONNECTION, SET_TEXT, PASTE, CLIPBOARD }

/**
 * What typing did. [inserted] is what Polish needs to find the text again; [surface] gives a fresh
 * handle on the same field later (null when the field is gone or changed, and for PASTE and CLIPBOARD).
 */
internal class TypeOutcome(
    val path: TypePath,
    val inserted: InsertedText?,
    val surface: () -> EditorSurface? = { null }
) {
    val typed: Boolean get() = path != TypePath.CLIPBOARD
}

/**
 * Types a dictation at the cursor. Ways in, in order of preference:
 *
 *  1. the accessibility input connection (Android 13+): commits at the cursor like a keyboard would;
 *  2. ACTION_SET_TEXT on the focused node, merged at its selection;
 *  3. ACTION_PASTE after putting the text on the clipboard;
 *  4. the clipboard alone.
 *
 * Never into a password field, never into a field of a different app than the dictation started in.
 */
internal class TextTyper(
    private val service: AccessibilityService,
    private val probe: FieldProbe,
    private val inputMethod: () -> FlowBarInputMethodHandle?
) {
    /** The input method as far as typing is concerned (a seam so API 26-32 builds never touch the 33+ class). */
    interface FlowBarInputMethodHandle {
        val editorInfo: EditorInfo?
        fun surface(): EditorSurface?
    }

    fun type(text: String, expectedPackage: String?, only: TypePath? = null): TypeOutcome {
        val node = probe.focusedInput()
        try {
            val nodePackage = node?.packageName?.toString()
            debugLog { "type: only=$only node=${node?.className} pkg=$nodePackage expected=$expectedPackage editable=${node?.isEditable} password=${node?.let { probe.isPassword(it) }}" }
            if (node != null && probe.isPassword(node)) return clipboardOnly(text)
            if (expectedPackage != null && nodePackage != null && nodePackage != expectedPackage) return clipboardOnly(text)

            if (only == null || only == TypePath.INPUT_CONNECTION) icSurface(expectedPackage)?.let { (surface, key) ->
                val result = typeThrough(surface, text)
                debugLog { "input connection: ${result::class.simpleName}" }
                when (result) {
                    is TypeResult.Typed -> return TypeOutcome(TypePath.INPUT_CONNECTION, result.inserted) { icSurface(expectedPackage)?.takeIf { it.second == key }?.first }
                    is TypeResult.TypedUnknown -> return TypeOutcome(TypePath.INPUT_CONNECTION, result.inserted)
                    // The connection would not answer after the commit: it may have been replaced under us. Ask the field itself.
                    is TypeResult.Unverified -> if (nodeShows(node, result.inserted.body) != false)
                        return TypeOutcome(TypePath.INPUT_CONNECTION, result.inserted) { icSurface(expectedPackage)?.takeIf { it.second == key }?.first }
                    TypeResult.NotApplied -> Unit
                }
            }
            if (node != null && node.isEditable) {
                if ((only == null || only == TypePath.SET_TEXT) && node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT }) {
                    val identity = probe.identity(node)
                    val result = typeThrough(NodeSurface(node), text)
                    debugLog { "set text: ${result::class.simpleName}" }
                    when (result) {
                        is TypeResult.Typed -> return TypeOutcome(TypePath.SET_TEXT, result.inserted) { nodeSurface(identity) }
                        is TypeResult.TypedUnknown -> return TypeOutcome(TypePath.SET_TEXT, result.inserted)
                        is TypeResult.Unverified -> if (nodeShows(node, result.inserted.body) != false)
                            return TypeOutcome(TypePath.SET_TEXT, result.inserted) { nodeSurface(identity) }
                        TypeResult.NotApplied -> Unit
                    }
                }
                if (only == null || only == TypePath.PASTE) {
                    // The paste action only shows up in a node once the clipboard holds text, so put the text there first and ask.
                    copy(text)
                    node.refresh()
                    if (node.performAction(AccessibilityNodeInfo.ACTION_PASTE) && nodeShows(node, text) != false) return TypeOutcome(TypePath.PASTE, null)
                }
            }
            return clipboardOnly(text)
        } finally { node.release() }
    }

    /** A handle on whatever field has focus now: the input connection if there is one, else the focused node. For tests and tooling. */
    fun currentSurface(): EditorSurface? {
        icSurface(null)?.let { return it.first }
        val node = probe.focusedInput() ?: return null
        if (probe.isPassword(node)) { node.release(); return null }
        return NodeSurface(node)
    }

    /**
     * Whether the focused field's own text now contains [body]: true or false when it says, null when it
     * cannot be read. Polls for up to 400 ms, because a commit through the keyboard reaches the field a
     * moment after it was sent.
     */
    private fun nodeShows(node: AccessibilityNodeInfo?, body: String): Boolean? {
        if (node == null) return null
        repeat(8) {
            if (!node.refresh()) return null
            val text = (if (node.isShowingHintText) "" else node.text?.toString()) ?: return null
            if (text.contains(body)) return true
            try { Thread.sleep(50) } catch (_: InterruptedException) { return null }
        }
        return false
    }

    fun copy(text: String) {
        val clipboard = service.getSystemService(ClipboardManager::class.java) ?: return
        val clip = ClipData.newPlainText("Voxden dictation", text)
        if (Build.VERSION.SDK_INT >= 33) clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        clipboard.setPrimaryClip(clip)
    }

    private fun clipboardOnly(text: String): TypeOutcome { copy(text); return TypeOutcome(TypePath.CLIPBOARD, null) }

    private fun icSurface(expectedPackage: String?): Pair<EditorSurface, EditorKey>? {
        val method = inputMethod() ?: return null
        val info = method.editorInfo ?: return null
        if (info.inputType == InputType.TYPE_NULL || isPasswordInputType(info.inputType)) return null
        if (expectedPackage != null && info.packageName != null && info.packageName != expectedPackage) return null
        val surface = method.surface() ?: return null
        return surface to EditorKey(info.packageName, info.fieldId, info.inputType)
    }

    /** A fresh node surface for the field [identity] names, if that field still has input focus. */
    private fun nodeSurface(identity: FieldIdentity): EditorSurface? {
        val node = probe.focusedInput() ?: return null
        if (probe.isPassword(node) || probe.identity(node) != identity) { node.release(); return null }
        return NodeSurface(node)   // released with the next GC; polish uses it once
    }

    private data class EditorKey(val packageName: String?, val fieldId: Int, val inputType: Int)

}

/** The Android 13+ handle: an [InputMethod] seen through [TextTyper.FlowBarInputMethodHandle]. */
@RequiresApi(33)
internal class InputMethodHandle(private val method: FlowBarInputMethod) : TextTyper.FlowBarInputMethodHandle {
    override val editorInfo: EditorInfo? get() = method.editor
    override fun surface(): EditorSurface? = method.currentInputConnection?.let { InputConnectionSurface(it) }
}
