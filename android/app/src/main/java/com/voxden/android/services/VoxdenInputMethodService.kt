package com.voxden.android.services

import android.inputmethodservice.InputMethodService
import android.text.InputType
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** A voice input method, with explicit preview/commit and no AccessibilityService. */
class VoxdenInputMethodService : InputMethodService() {
    private var preview: TextView? = null
    private var record: Button? = null
    private var insert: Button? = null
    private var target: EditorTarget? = null
    private var session: String? = null
    private var beforeCursor: String? = null
    private var afterCursor: String? = null
    private var protectedField = false

    override fun onCreateInputView(): View {
        val body = NativeStyle.column(this)
        body.addView(NativeStyle.hairlineView(this))
        body.addView(NativeStyle.header(this, "Voxden voice", 17f).apply { setPadding(0, NativeStyle.dp(this@VoxdenInputMethodService, 8), 0, 0) })
        preview = NativeStyle.label(this, "Speak a thought, then review and insert.", 16f).apply {
            minHeight = NativeStyle.dp(this@VoxdenInputMethodService, 54)
            maxLines = 4
        }
        body.addView(preview)
        record = NativeStyle.button(this, "Dictate", true) {
            val editor = currentInputEditorInfo ?: return@button
            if (editor.inputType == InputType.TYPE_NULL || isPassword(editor) || currentInputConnection == null) return@button
            target = EditorTarget.from(editor)
            beforeCursor = currentInputConnection?.getTextBeforeCursor(32, 0)?.toString()
            afterCursor = currentInputConnection?.getTextAfterCursor(32, 0)?.toString()
            session = VoiceInputSession.begin()
            RecordingActivity.launch(this, session)
        }
        insert = NativeStyle.button(this, "Insert text") { insertTranscript() }
        // Dictate and Insert share one row so the keyboard stays short.
        val gap = NativeStyle.dp(this, 6)
        val main = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        main.addView(record, LinearLayout.LayoutParams(0, -2, 1.45f).apply { marginEnd = gap; topMargin = NativeStyle.dp(this@VoxdenInputMethodService, 10) })
        main.addView(insert, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = gap; topMargin = NativeStyle.dp(this@VoxdenInputMethodService, 10) })
        body.addView(main)
        val keys = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        fun key(label: String, action: () -> Unit) {
            keys.addView(NativeStyle.button(this, label, compact = true, action = action).apply {
                layoutParams = LinearLayout.LayoutParams(0, -2, 1f).apply { setMargins(NativeStyle.dp(this@VoxdenInputMethodService, 3), NativeStyle.dp(this@VoxdenInputMethodService, 10), NativeStyle.dp(this@VoxdenInputMethodService, 3), 0) }
            })
        }
        key("⌫") { currentInputConnection?.deleteSurroundingTextInCodePoints(1, 0) }
        key("Space") { currentInputConnection?.commitText(" ", 1) }
        key("Keyboards") { getSystemService(InputMethodManager::class.java).showInputMethodPicker() }
        body.addView(keys, LinearLayout.LayoutParams(-1, -2).apply { marginStart = -NativeStyle.dp(this@VoxdenInputMethodService, 3); marginEnd = -NativeStyle.dp(this@VoxdenInputMethodService, 3) })
        // The keyboard is drawn edge to edge: keep its last row clear of the navigation bar.
        val basePadding = body.paddingBottom
        body.setOnApplyWindowInsetsListener { view, insets ->
            val bottom = if (android.os.Build.VERSION.SDK_INT >= 30) insets.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom
            else @Suppress("DEPRECATION") insets.systemWindowInsetBottom
            view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, basePadding + bottom)
            insets
        }
        render()
        return body
    }
    override fun onEvaluateFullscreenMode() = false
    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        protectedField = attribute == null || attribute.inputType == InputType.TYPE_NULL || isPassword(attribute)
        // Android starts a dummy, TYPE_NULL input connection while our recording activity takes
        // focus. It is not a new user editor. Preserve only this explicitly active roundtrip;
        // real editors (including password fields) still go through the identity check below.
        val recorderFocusTransition = session != null && session == VoiceInputSession.token &&
            VoiceInputSession.isRecordingScreenOpen &&
            (attribute == null || (attribute.packageName == packageName && attribute.inputType == InputType.TYPE_NULL))
        if (recorderFocusTransition) { render(); return }
        // The recording activity temporarily hides the editor. Only the same editor may receive
        // its result, and the user must still review and tap Insert after returning.
        if (protectedField || (target != null && target != attribute?.let(EditorTarget::from))) clearSession()
        render()
    }
    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        render()
    }
    private fun render() {
        val text = if (session != null && session == VoiceInputSession.token) VoiceInputSession.text else ""
        preview?.text = when {
            protectedField -> if (currentInputEditorInfo?.let(::isPassword) == true)
                "Voice input is unavailable in password fields. Switch keyboards below."
                else "Tap a text field to use the voice keyboard."
            text.isNotBlank() -> text
            else -> "Speak a thought, then review and insert."
        }
        record?.isEnabled = !protectedField
        insert?.isEnabled = !protectedField && text.isNotBlank() && target == currentInputEditorInfo?.let(EditorTarget::from)
    }
    private fun insertTranscript() {
        val editor = currentInputEditorInfo ?: return
        val connection = currentInputConnection ?: return
        val text = VoiceInputSession.text
        val surroundingChanged = beforeCursor != connection.getTextBeforeCursor(32, 0)?.toString() || afterCursor != connection.getTextAfterCursor(32, 0)?.toString()
        if (editor.inputType == InputType.TYPE_NULL || isPassword(editor) || session == null || session != VoiceInputSession.token || target != EditorTarget.from(editor) || surroundingChanged || text.isBlank()) {
            clearSession(); render(); return
        }
        if (connection.commitText(text, 1)) { clearSession(); render() }
    }
    private fun clearSession() { VoiceInputSession.clear(); session = null; target = null; beforeCursor = null; afterCursor = null }
    override fun onDestroy() { clearSession(); super.onDestroy() }
    private fun isPassword(info: EditorInfo): Boolean {
        val inputClass = info.inputType and InputType.TYPE_MASK_CLASS
        val variation = info.inputType and InputType.TYPE_MASK_VARIATION
        return inputClass == InputType.TYPE_CLASS_TEXT && variation in setOf(InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD) ||
            inputClass == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
    }
    private data class EditorTarget(val packageName: String?, val fieldId: Int, val inputType: Int, val hint: String?) {
        companion object {
            fun from(info: EditorInfo) = EditorTarget(info.packageName, info.fieldId, info.inputType, info.hintText?.toString())
        }
    }
}
