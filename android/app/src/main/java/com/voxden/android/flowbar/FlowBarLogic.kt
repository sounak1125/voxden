package com.voxden.android.flowbar

import android.text.InputType
import com.voxden.android.core.BarSide
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min

/*
 * The flow bar's decisions as plain Kotlin: no Context, no View, nothing from the Android framework
 * except compile-time constants. That keeps thresholds, spacing, positions and range bookkeeping
 * unit-testable on the JVM; the Android-facing classes only feed them numbers and apply the answers.
 */

/** An integer rectangle (the framework's Rect cannot be used in JVM unit tests). */
data class Box(val left: Int, val top: Int, val right: Int, val bottom: Int) {
    val width: Int get() = right - left
    val height: Int get() = bottom - top
    val isEmpty: Boolean get() = width <= 0 || height <= 0
}

/** Fixed sizes of the flow bar, in dp (DESIGN.md "The flow bar over other apps"). */
object FlowBarMetrics {
    const val PILL_WIDTH = 6f
    const val PILL_HEIGHT = 46f
    const val PILL_EDGE_INSET = 3f
    const val TARGET_WIDTH = 28f
    const val TARGET_HEIGHT = 76f
    /** Inward pull that starts a dictation. */
    const val PULL_THRESHOLD = 40f
    /** Finger travel before a touch stops being a tap. */
    const val TOUCH_SLOP = 8f
    /** The most the pill can stretch, however far the finger goes. */
    const val STRETCH_LIMIT = 96f
    const val CAPSULE_HEIGHT = 44f
    /** The capsule window is a little taller than the capsule so its springs have room. */
    const val CAPSULE_WINDOW_HEIGHT = 56f
    const val CAPSULE_ABOVE_IME = 12f
    const val CAPSULE_ABOVE_BOTTOM = 96f
    const val SAFE_MARGIN = 8f
    const val DONE_MILLIS = 4000L
    const val ERROR_MILLIS = 2600L
}

/** How a pull ends. */
enum class PullOutcome { NONE, TAP, START, SNAP_BACK, MOVED }

/**
 * The resting pill's touch logic, fed raw screen coordinates (the window moves and resizes under
 * the finger, so window-relative coordinates would not be stable).
 *
 * A touch that stays inside the slop is a tap. Past the slop it becomes either a pull (mostly
 * toward the middle of the screen: the pill stretches like rubber and a release past the
 * threshold starts dictation) or a vertical move (the pill follows the finger and its position is
 * saved). The mode is decided once, so a pull never turns into a move halfway.
 */
class PullGesture(
    private val side: BarSide,
    private val slopPx: Float,
    private val thresholdPx: Float,
    private val stretchLimitPx: Float
) {
    enum class Mode { IDLE, PENDING, PULLING, MOVING }

    var mode: Mode = Mode.IDLE; private set
    /** The elastic stretch to draw, in px, toward the middle of the screen. */
    var stretchPx: Float = 0f; private set
    /** True while the finger is past the threshold (a release now starts dictation). */
    var armed: Boolean = false; private set
    /** Vertical travel since the touch began, in px (only while moving). */
    var moveDy: Float = 0f; private set
    private var downX = 0f
    private var downY = 0f
    private var disarmBelow = 0f

    fun down(x: Float, y: Float) {
        mode = Mode.PENDING; stretchPx = 0f; armed = false; moveDy = 0f
        downX = x; downY = y
        disarmBelow = thresholdPx - slopPx * 0.5f
    }

    /** Inward travel in px (positive toward the middle of the screen). */
    fun inward(x: Float): Float = if (side == BarSide.RIGHT) downX - x else x - downX

    /** Returns true when this move crossed the threshold (the caller plays the haptic tick). */
    fun move(x: Float, y: Float): Boolean {
        if (mode == Mode.IDLE) return false
        val dx = inward(x)
        val dy = y - downY
        if (mode == Mode.PENDING) {
            if (abs(dx) < slopPx && abs(dy) < slopPx) return false
            mode = if (abs(dy) > abs(dx) || dx < 0) Mode.MOVING else Mode.PULLING
        }
        when (mode) {
            Mode.MOVING -> moveDy = dy
            Mode.PULLING -> {
                stretchPx = elasticStretch(dx, stretchLimitPx)
                val wasArmed = armed
                armed = if (armed) dx >= disarmBelow else dx >= thresholdPx
                return armed && !wasArmed
            }
            else -> Unit
        }
        return false
    }

    fun up(): PullOutcome {
        val outcome = when (mode) {
            Mode.IDLE -> PullOutcome.NONE
            Mode.PENDING -> PullOutcome.TAP
            Mode.PULLING -> if (armed) PullOutcome.START else PullOutcome.SNAP_BACK
            Mode.MOVING -> PullOutcome.MOVED
        }
        mode = Mode.IDLE; armed = false
        return outcome
    }

    fun cancel() { mode = Mode.IDLE; armed = false; stretchPx = 0f; moveDy = 0f }
}

/** Rubber-band stretch: follows the finger at first, then gives less and less, never past [limit]. */
fun elasticStretch(inwardPx: Float, limit: Float): Float {
    if (inwardPx <= 0f || limit <= 0f) return 0f
    return limit * (1f - exp(-inwardPx / limit))
}

/** What the screen looks like to the flow bar, in px. Insets are the system bars plus any cutout. */
data class ScreenGeometry(
    val width: Int,
    val height: Int,
    val insetLeft: Int,
    val insetTop: Int,
    val insetRight: Int,
    val insetBottom: Int,
    val density: Float
) {
    fun dp(value: Float): Int = (value * density + 0.5f).toInt()
}

/** Where each window goes. All coordinates are physical-screen pixels. */
object FlowBarLayout {
    const val MIN_OFFSET = 0.08f
    const val MAX_OFFSET = 0.85f

    fun clampOffset(offset: Float): Float = offset.coerceIn(MIN_OFFSET, MAX_OFFSET)

    fun offsetForCenter(centerY: Float, g: ScreenGeometry): Float = clampOffset(centerY / g.height)

    /** Left edge of the resting window: flush with the chosen screen edge, inside any cutout or bar. */
    fun pillLeft(side: BarSide, windowWidth: Int, g: ScreenGeometry): Int =
        if (side == BarSide.LEFT) g.insetLeft else g.width - g.insetRight - windowWidth

    /**
     * Top of the resting window so that the pill is centred on [offset] of the screen height,
     * kept clear of the status bar, the navigation bar and (when the keyboard is up) the keyboard.
     */
    fun pillTop(offset: Float, windowHeight: Int, g: ScreenGeometry, imeTop: Int?): Int {
        val margin = g.dp(FlowBarMetrics.SAFE_MARGIN)
        val low = g.insetTop + margin
        var high = g.height - g.insetBottom - margin - windowHeight
        if (imeTop != null && imeTop > 0) high = min(high, imeTop - margin - windowHeight)
        val wanted = (clampOffset(offset) * g.height - windowHeight / 2f).toInt()
        return if (high < low) low else wanted.coerceIn(low, high)
    }

    /** Same as [pillTop] for a pill the finger has dragged to [centerY]. */
    fun pillTopForCenter(centerY: Float, windowHeight: Int, g: ScreenGeometry, imeTop: Int?): Int =
        pillTop(offsetForCenter(centerY, g), windowHeight, g, imeTop)

    /**
     * Top of the capsule window. The capsule's bottom edge sits [FlowBarMetrics.CAPSULE_ABOVE_IME] dp
     * above the keyboard, or [FlowBarMetrics.CAPSULE_ABOVE_BOTTOM] dp above the bottom of the usable
     * screen when there is no keyboard. [windowHeight] is a little taller than the capsule, centred on it.
     */
    fun capsuleTop(imeTop: Int?, windowHeight: Int, capsuleHeight: Int, g: ScreenGeometry): Int {
        val capsuleBottom = if (imeTop != null && imeTop > 0) imeTop - g.dp(FlowBarMetrics.CAPSULE_ABOVE_IME)
        else g.height - g.insetBottom - g.dp(FlowBarMetrics.CAPSULE_ABOVE_BOTTOM)
        val pad = (windowHeight - capsuleHeight) / 2
        val top = capsuleBottom + pad - windowHeight
        val lowest = g.insetTop + g.dp(FlowBarMetrics.SAFE_MARGIN) - pad
        return max(top, lowest)
    }

    /** Left of a capsule window of [windowWidth]: centred, never off the usable width. */
    fun capsuleLeft(windowWidth: Int, g: ScreenGeometry): Int {
        val usable = g.width - g.insetLeft - g.insetRight
        return if (windowWidth >= usable) g.insetLeft else g.insetLeft + (usable - windowWidth) / 2
    }
}

/** What the accessibility probe found. */
data class FieldSnapshot(
    val imeBounds: Box? = null,
    val editableFocused: Boolean = false,
    val password: Boolean = false,
    val packageName: String? = null
) {
    val imeVisible: Boolean get() = imeBounds != null && !(imeBounds.isEmpty)
}

/**
 * Whether the resting pill is on screen. Never on the lock screen, never over a password field;
 * otherwise while an editable field is focused with the keyboard up (or always, when asked).
 */
fun shouldShowPill(alwaysShow: Boolean, locked: Boolean, screenOn: Boolean, field: FieldSnapshot): Boolean {
    if (locked || !screenOn) return false
    if (field.password) return false
    return alwaysShow || (field.imeVisible && field.editableFocused)
}

/**
 * Fills in what the accessibility tree could not say, from the editor the keyboard is typing into
 * (Android 13+, [editorInputType] null when there is none). Some fields reach the tree as a plain view:
 * Compose in this app's own process when Android started the process for the service, and some web
 * and cross-platform toolkits. An editor the keyboard is connected to is a text field, and its input
 * type says whether it is a password. An editor from another app than the focused node's is stale and
 * is ignored.
 */
fun withEditor(field: FieldSnapshot, editorInputType: Int?, editorPackage: String?): FieldSnapshot {
    if (editorInputType == null || editorInputType == InputType.TYPE_NULL) return field
    if (field.packageName != null && editorPackage != null && field.packageName != editorPackage) return field
    return field.copy(
        editableFocused = true,
        password = field.password || isPasswordInputType(editorInputType),
        packageName = field.packageName ?: editorPackage
    )
}

// ---- Typing the text ---------------------------------------------------------------------

/** True when the character after which a dictation lands asks for a space before it. */
fun needsLeadingSpace(before: CharSequence?, text: String): Boolean {
    if (before.isNullOrEmpty() || text.isEmpty()) return false
    val last = Character.codePointBefore(before, before.length)
    val first = Character.codePointAt(text, 0)
    if (isSpace(last) || isSpace(first)) return false
    if (isOpening(last)) return false
    if (isClosing(first)) return false
    // Scripts written without spaces between words: never add one.
    if (isUnspacedScript(last) || isUnspacedScript(first)) return false
    return true
}

/**
 * True when a dictation that lands right before [after] (the text behind the cursor) asks for a space
 * after it, so the next word does not run into it. Mirrors [needsLeadingSpace].
 */
fun needsTrailingSpace(after: CharSequence?, text: String): Boolean {
    if (after.isNullOrEmpty() || text.isEmpty()) return false
    val next = Character.codePointAt(after, 0)
    val last = Character.codePointBefore(text, text.length)
    if (isSpace(next) || isSpace(last)) return false
    if (isClosing(next) || isOpening(last)) return false
    if (isUnspacedScript(next) || isUnspacedScript(last)) return false
    return true
}

private fun isSpace(cp: Int) = Character.isWhitespace(cp) || Character.isSpaceChar(cp)

private fun isOpening(cp: Int): Boolean {
    val type = Character.getType(cp)
    return type == Character.START_PUNCTUATION.toInt() || type == Character.INITIAL_QUOTE_PUNCTUATION.toInt() ||
        cp == '@'.code || cp == '#'.code || cp == '/'.code || cp == '\\'.code
}

private const val CLOSERS = ".,;:!?%…。、，！？；：‼⁇"

private fun isClosing(cp: Int): Boolean {
    val type = Character.getType(cp)
    return type == Character.END_PUNCTUATION.toInt() || type == Character.FINAL_QUOTE_PUNCTUATION.toInt() ||
        (cp < 0x10000 && CLOSERS.indexOf(cp.toChar()) >= 0)
}

private fun isUnspacedScript(cp: Int): Boolean = when (Character.UnicodeScript.of(cp)) {
    Character.UnicodeScript.HAN, Character.UnicodeScript.HIRAGANA, Character.UnicodeScript.KATAKANA,
    Character.UnicodeScript.THAI, Character.UnicodeScript.LAO, Character.UnicodeScript.KHMER,
    Character.UnicodeScript.MYANMAR -> true
    else -> false
}

/** The editor's own `inputType` says it holds a password. */
fun isPasswordInputType(inputType: Int): Boolean {
    val inputClass = inputType and InputType.TYPE_MASK_CLASS
    val variation = inputType and InputType.TYPE_MASK_VARIATION
    return when (inputClass) {
        InputType.TYPE_CLASS_TEXT -> variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
            variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
            variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
        InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
        else -> false
    }
}

/** The text of a field around its selection, as an input connection or an accessibility node reports it. */
data class Surrounding(
    val text: String,
    val selStart: Int,
    val selEnd: Int,
    /** Index in the whole field of [text]'s first character, or -1 when the editor does not say. */
    val offset: Int
) {
    val cursor: Int get() = min(selStart, selEnd).coerceIn(0, text.length)
    val before: String get() = text.substring(0, cursor)
    /** The text behind the selection (the selection itself is replaced by a commit). */
    val after: String get() = text.substring(max(selStart, selEnd).coerceIn(0, text.length))
}

/** Reading and editing one text field. */
interface EditorSurface {
    /** Up to [before] characters before the selection, the selection, and up to [after] characters after it. */
    fun surrounding(before: Int, after: Int): Surrounding?
    /** Replaces the selection with [text] and leaves the cursor after it. */
    fun commitText(text: String): Boolean
    /** Selects the absolute range [start, end). */
    fun select(start: Int, end: Int): Boolean
    /** Deletes [count] characters before the cursor. */
    fun deleteBeforeCursor(count: Int): Boolean
}

/** The text a dictation put into a field, remembered so Polish can find it again. */
data class InsertedText(
    /** The space put in front when the text before the cursor asked for one (or empty). */
    val prefix: String,
    val body: String,
    /** The space put behind when the text after the cursor asked for one (or empty). */
    val suffix: String,
    /** Index of [prefix]'s first character in the whole field, or -1 when the editor did not say. */
    val start: Int
) {
    val full: String get() = prefix + body + suffix
}

enum class CommitCheck { APPLIED, NOT_APPLIED, CHANGED, UNKNOWN }

/**
 * Decides whether a commit landed by looking at the text before the cursor afterwards.
 * [beforeBefore] is that text from before the commit. [after] null means the editor would not say
 * (or the connection is gone), so the commit cannot be confirmed from here: [CommitCheck.UNKNOWN].
 */
fun classifyCommit(beforeBefore: String, after: Surrounding?, full: String): CommitCheck {
    if (after == null) return CommitCheck.UNKNOWN
    val now = after.before
    if (now.endsWith(full)) return CommitCheck.APPLIED
    val tail = beforeBefore.takeLast(32)
    if (now.endsWith(tail) && (tail.isNotEmpty() || now.isEmpty())) return CommitCheck.NOT_APPLIED
    return CommitCheck.CHANGED
}

/**
 * What typing through an [EditorSurface] did: the text now in the field, or null when it did not land
 * (the caller tries the next way in). [inserted] has start -1 when the editor does not report offsets.
 */
sealed interface TypeResult {
    data class Typed(val inserted: InsertedText) : TypeResult
    /** The editor changed in a way we cannot attribute to our text; Polish will not touch it. */
    data class TypedUnknown(val inserted: InsertedText) : TypeResult
    /** The commit was sent but could not be read back; the caller checks another way before believing it. */
    data class Unverified(val inserted: InsertedText) : TypeResult
    object NotApplied : TypeResult
}

fun typeThrough(surface: EditorSurface, body: String): TypeResult {
    val context = surface.surrounding(CONTEXT, CONTEXT)
    val before = context?.before.orEmpty()
    val prefix = if (needsLeadingSpace(before, body)) " " else ""
    val suffix = if (needsTrailingSpace(context?.after, body)) " " else ""
    val start = if (context != null && context.offset >= 0) context.offset + context.cursor else -1
    val full = prefix + body + suffix
    if (!surface.commitText(full)) return TypeResult.NotApplied
    val inserted = InsertedText(prefix, body, suffix, start)
    return when (classifyCommit(before, surface.surrounding(full.length + CONTEXT, 0), full)) {
        CommitCheck.APPLIED -> TypeResult.Typed(inserted)
        CommitCheck.NOT_APPLIED -> TypeResult.NotApplied
        CommitCheck.CHANGED -> TypeResult.TypedUnknown(inserted.copy(start = -1))
        CommitCheck.UNKNOWN -> TypeResult.Unverified(inserted)
    }
}

private const val CONTEXT = 32

/** Result of merging a dictation into a field's text with ACTION_SET_TEXT. */
data class SetTextMerge(val text: String, val caret: Int, val insertStart: Int)

/** [existing] with the selection [selStart, selEnd) replaced by [insert]. Negative selections mean "at the end". */
fun mergeIntoSelection(existing: CharSequence?, selStart: Int, selEnd: Int, insert: String): SetTextMerge {
    val text = existing?.toString().orEmpty()
    var a = if (selStart < 0) text.length else selStart
    var b = if (selEnd < 0) text.length else selEnd
    a = a.coerceIn(0, text.length); b = b.coerceIn(0, text.length)
    if (a > b) { val t = a; a = b; b = t }
    return SetTextMerge(text.substring(0, a) + insert + text.substring(b), a + insert.length, a)
}

/** Where the inserted text sits in a fresh read of the field, or null when it is no longer exactly there. */
data class Located(val bodyStart: Int, val bodyEnd: Int, /** absolute index of the body's start, or -1 */ val absoluteBodyStart: Int, val cursorAtEnd: Boolean)

fun locateInserted(inserted: InsertedText, s: Surrounding): Located? {
    val full = inserted.full
    if (full.isEmpty()) return null
    if (inserted.start >= 0 && s.offset >= 0) {
        val a = inserted.start - s.offset
        val b = a + full.length
        if (a < 0 || b > s.text.length || s.text.substring(a, b) != full) return null
        return Located(a + inserted.prefix.length, a + inserted.prefix.length + inserted.body.length, inserted.start + inserted.prefix.length, s.cursor == b && s.selStart == s.selEnd)
    }
    // Offsets unknown: the insertion is where we left the cursor, right behind it.
    if (s.selStart != s.selEnd) return null
    val b = s.cursor
    val a = b - full.length
    if (a < 0 || s.text.substring(a, b) != full) return null
    val absolute = if (s.offset >= 0) s.offset + a + inserted.prefix.length else -1
    return Located(a + inserted.prefix.length, a + inserted.prefix.length + inserted.body.length, absolute, true)
}

/** What Polish did to the field. */
sealed interface PolishOutcome {
    /** The polished text now stands where the dictation was. */
    data class Replaced(val polished: String, val inserted: InsertedText) : PolishOutcome
    /** The dictation is no longer exactly where it was put; the polished text must go elsewhere (the clipboard). */
    data class Moved(val polished: String) : PolishOutcome
}

private const val REPLACE_WINDOW = 4000

/**
 * Polishes [original] with [polish] and, if [inserted] still sits exactly where it was typed in the
 * field behind [surface], selects it and types the polished text over it. [surface] is asked for
 * after polishing finished, because the field may have changed (or gone) while the network call ran.
 */
suspend fun polishInPlace(
    original: String,
    inserted: InsertedText?,
    surface: () -> EditorSurface?,
    polish: suspend (String) -> String
): PolishOutcome {
    val polished = polish(original)
    return replaceInserted(inserted, surface(), polished)
}

/** The replace step on its own, for callers that already hold the polished text. */
fun replaceInserted(inserted: InsertedText?, surface: EditorSurface?, polished: String): PolishOutcome {
    if (inserted == null || surface == null) return PolishOutcome.Moved(polished)
    val now = surface.surrounding(REPLACE_WINDOW, REPLACE_WINDOW) ?: return PolishOutcome.Moved(polished)
    val found = locateInserted(inserted, now) ?: return PolishOutcome.Moved(polished)
    val applied = if (found.absoluteBodyStart >= 0) {
        surface.select(found.absoluteBodyStart, found.absoluteBodyStart + inserted.body.length) && surface.commitText(polished)
    } else if (found.cursorAtEnd) {
        // Offsets unknown: the cursor is right behind the insertion, so take back body and suffix, put them back polished.
        surface.deleteBeforeCursor(inserted.body.length + inserted.suffix.length) && surface.commitText(polished + inserted.suffix)
    } else false
    if (!applied) return PolishOutcome.Moved(polished)
    val start = if (inserted.start >= 0) inserted.start else if (found.absoluteBodyStart >= 0) found.absoluteBodyStart - inserted.prefix.length else -1
    return PolishOutcome.Replaced(polished, InsertedText(inserted.prefix, polished, inserted.suffix, start))
}

// ---- Errors ------------------------------------------------------------------------------

/** The short reasons the capsule can show; each has its own string. */
enum class ErrorKind { NO_SPEECH, MICROPHONE, NETWORK, BUSY, LANGUAGE, TIMEOUT, SIGN_IN, CLOUD_NEEDED, WORDS_USED, OTHER }

/** Sorts the controller's long, friendly messages into one of the short labels. */
fun classifyError(message: String?): ErrorKind {
    val m = message?.lowercase().orEmpty()
    return when {
        m.isBlank() -> ErrorKind.OTHER
        "free words" in m -> ErrorKind.WORDS_USED
        "no speech" in m || "didn't catch" in m -> ErrorKind.NO_SPEECH
        "microphone access" in m || "denied microphone" in m || "microphone was interrupted" in m || "microphone could not" in m -> ErrorKind.MICROPHONE
        "free trial" in m || "upgrade" in m || "turn on voxden cloud" in m || "cloud minutes" in m -> ErrorKind.CLOUD_NEEDED
        "sign in" in m -> ErrorKind.SIGN_IN
        "timed out" in m || "took too long" in m || "did not return" in m -> ErrorKind.TIMEOUT
        "connection" in m || "network" in m || "cannot reach" in m -> ErrorKind.NETWORK
        "busy" in m -> ErrorKind.BUSY
        "language" in m -> ErrorKind.LANGUAGE
        else -> ErrorKind.OTHER
    }
}

/** True when the failure is "this app has no microphone permission": the flow bar then opens the app. */
fun needsMicrophonePermission(message: String?): Boolean {
    val m = message?.lowercase().orEmpty()
    return "allow microphone access" in m
}

/** First sentence of [message], cut to [max] characters, for an error with no dedicated label. */
fun firstSentence(message: String?, max: Int = 30): String {
    val text = message.orEmpty().trim()
    if (text.isEmpty()) return ""
    val end = text.indexOfAny(charArrayOf('.', '!', '?')).let { if (it < 0) text.length else it }
    val sentence = text.substring(0, end).trim()
    return if (sentence.length <= max) sentence else sentence.take(max - 1).trimEnd() + "…"
}
