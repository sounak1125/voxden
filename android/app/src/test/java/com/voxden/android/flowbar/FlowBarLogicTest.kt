package com.voxden.android.flowbar

import android.text.InputType
import com.voxden.android.core.BarSide
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/** A text field in memory: selection, a window onto it, and the three edits the flow bar makes. */
private class FakeField(
    var text: String = "",
    var selStart: Int = text.length,
    var selEnd: Int = selStart,
    private val reportsOffset: Boolean = true,
    private val ignoreCommit: Boolean = false,
    private val transform: ((String) -> String)? = null,
    /** Reads work until the first commit, then the connection stops answering (a keyboard that restarted under us). */
    private val goesBlindAfterCommit: Boolean = false
) : EditorSurface {
    var selects = 0
    var deletes = 0
    private var committed = false

    override fun surrounding(before: Int, after: Int): Surrounding? {
        if (goesBlindAfterCommit && committed) return null
        val lo = min(selStart, selEnd)
        val hi = max(selStart, selEnd)
        val from = max(0, lo - before)
        val to = min(text.length, hi + after)
        return Surrounding(text.substring(from, to), selStart - from, selEnd - from, if (reportsOffset) from else -1)
    }

    override fun commitText(text: String): Boolean {
        committed = true
        if (ignoreCommit) return true
        val lo = min(selStart, selEnd)
        val hi = max(selStart, selEnd)
        val put = transform?.invoke(text) ?: text
        this.text = this.text.substring(0, lo) + put + this.text.substring(hi)
        selStart = lo + put.length; selEnd = selStart
        return true
    }

    override fun select(start: Int, end: Int): Boolean { selects++; selStart = start; selEnd = end; return true }

    override fun deleteBeforeCursor(count: Int): Boolean {
        deletes++
        val lo = min(selStart, selEnd)
        val from = max(0, lo - count)
        text = text.substring(0, from) + text.substring(lo)
        selStart = from; selEnd = from
        return true
    }
}

class PullGestureTest {
    private fun gesture(side: BarSide = BarSide.RIGHT) = PullGesture(side, slopPx = 8f, thresholdPx = 40f, stretchLimitPx = 96f)

    @Test fun aTouchThatStaysInsideTheSlopIsATap() {
        val g = gesture()
        g.down(1000f, 500f)
        assertFalse(g.move(996f, 503f))
        assertEquals(PullGesture.Mode.PENDING, g.mode)
        assertEquals(PullOutcome.TAP, g.up())
    }

    @Test fun pullingInwardPastTheThresholdStartsDictation() {
        val g = gesture()
        g.down(1000f, 500f)
        assertFalse(g.move(985f, 500f))
        assertEquals(PullGesture.Mode.PULLING, g.mode)
        assertTrue("stretch follows the finger", g.stretchPx > 10f)
        assertFalse(g.armed)
        assertTrue("the move that crosses 40 reports the tick", g.move(958f, 501f))
        assertTrue(g.armed)
        assertEquals(PullOutcome.START, g.up())
    }

    @Test fun releasingBeforeTheThresholdSnapsBack() {
        val g = gesture()
        g.down(1000f, 500f)
        g.move(975f, 500f)
        assertEquals(PullOutcome.SNAP_BACK, g.up())
    }

    @Test fun theTickPlaysOncePerCrossingAndNeedsAnEasingOffToRearm() {
        val g = gesture()
        g.down(1000f, 500f)
        assertTrue(g.move(955f, 500f))
        assertFalse("still armed, no second tick", g.move(950f, 500f))
        assertFalse("a hair under the threshold stays armed (hysteresis)", g.move(962f, 500f))
        assertTrue(g.armed)
        assertFalse(g.move(990f, 500f))
        assertFalse("well under: disarmed", g.armed)
        assertTrue("pulling in again ticks again", g.move(955f, 500f))
    }

    @Test fun aMostlyVerticalDragMovesTheBarAndNeverBecomesAPull() {
        val g = gesture()
        g.down(1000f, 500f)
        g.move(998f, 540f)
        assertEquals(PullGesture.Mode.MOVING, g.mode)
        assertEquals(40f, g.moveDy, 0.001f)
        g.move(930f, 600f)       // the finger wanders inward, the mode sticks
        assertEquals(PullGesture.Mode.MOVING, g.mode)
        assertEquals(0f, g.stretchPx, 0.001f)
        assertEquals(PullOutcome.MOVED, g.up())
    }

    @Test fun aLeftEdgeBarPullsTowardPositiveX() {
        val g = gesture(BarSide.LEFT)
        g.down(10f, 500f)
        g.move(60f, 500f)
        assertEquals(PullGesture.Mode.PULLING, g.mode)
        assertTrue(g.armed)
        assertEquals(PullOutcome.START, g.up())
    }

    @Test fun pullingTowardTheEdgeIsNotAPull() {
        val g = gesture()
        g.down(1000f, 500f)
        g.move(1030f, 500f)
        assertEquals(PullGesture.Mode.MOVING, g.mode)
        assertEquals(PullOutcome.MOVED, g.up())
    }

    @Test fun cancelForgetsEverything() {
        val g = gesture()
        g.down(1000f, 500f)
        g.move(950f, 500f)
        g.cancel()
        assertEquals(PullOutcome.NONE, g.up())
        assertEquals(0f, g.stretchPx, 0f)
    }

    @Test fun elasticStretchIsRubber() {
        assertEquals(0f, elasticStretch(-5f, 96f), 0f)
        assertEquals(0f, elasticStretch(0f, 96f), 0f)
        var last = 0f
        for (d in 1..400 step 10) {
            val s = elasticStretch(d.toFloat(), 96f)
            assertTrue("monotonic at $d", s > last)
            assertTrue("never past the limit at $d", s < 96f)
            last = s
        }
        assertEquals("follows the finger at first", 5f, elasticStretch(5f, 96f), 0.2f)
        assertTrue("and gives less later", elasticStretch(200f, 96f) < 200f * 0.5f)
    }
}

class FlowBarLayoutTest {
    // 1080 x 2400 at 420 dpi (2.625), status bar 63, navigation bar 126.
    private val g = ScreenGeometry(1080, 2400, 0, 63, 0, 126, 2.625f)
    private val targetHeight = g.dp(FlowBarMetrics.TARGET_HEIGHT)
    private val targetWidth = g.dp(FlowBarMetrics.TARGET_WIDTH)

    /** The capsule is centred in a window whose spare height may be odd: one pixel either way is the same place. */
    private fun assertNear(expected: Int, actual: Int) = assertTrue("expected $expected, was $actual", abs(expected - actual) <= 1)

    @Test fun dpRoundsToPixels() {
        assertEquals(29, g.dp(11f))
        assertEquals(200, g.dp(76f))
    }

    @Test fun theRestingWindowIsFlushWithTheChosenEdge() {
        assertEquals(1080 - targetWidth, FlowBarLayout.pillLeft(BarSide.RIGHT, targetWidth, g))
        assertEquals(0, FlowBarLayout.pillLeft(BarSide.LEFT, targetWidth, g))
    }

    @Test fun aSideCutoutOrBarPushesTheWindowInside() {
        val landscape = ScreenGeometry(2400, 1080, 120, 63, 126, 0, 2.625f)
        assertEquals(120, FlowBarLayout.pillLeft(BarSide.LEFT, targetWidth, landscape))
        assertEquals(2400 - 126 - targetWidth, FlowBarLayout.pillLeft(BarSide.RIGHT, targetWidth, landscape))
    }

    @Test fun thePillIsCentredOnItsOffset() {
        val top = FlowBarLayout.pillTop(0.42f, targetHeight, g, null)
        assertEquals((0.42f * 2400 - targetHeight / 2f).toInt(), top)
        assertEquals(0.42f * 2400, top + targetHeight / 2f, 1f)
    }

    @Test fun thePillStaysClearOfTheBars() {
        val margin = g.dp(FlowBarMetrics.SAFE_MARGIN)
        assertTrue(FlowBarLayout.pillTop(0.0f, targetHeight, g, null) >= 63 + margin)
        val low = FlowBarLayout.pillTop(0.99f, targetHeight, g, null)
        assertTrue(low + targetHeight <= 2400 - 126 - margin)
    }

    @Test fun theKeyboardPushesThePillUp() {
        val margin = g.dp(FlowBarMetrics.SAFE_MARGIN)
        val top = FlowBarLayout.pillTop(0.85f, targetHeight, g, 1517)
        assertEquals(1517 - margin - targetHeight, top)
    }

    @Test fun aTinyScreenDoesNotCrashTheClamp() {
        val tiny = ScreenGeometry(300, 300, 0, 100, 0, 100, 2.625f)
        assertEquals(100 + tiny.dp(FlowBarMetrics.SAFE_MARGIN), FlowBarLayout.pillTop(0.5f, targetHeight, tiny, null))
    }

    @Test fun draggingConvertsBackToASavedFraction() {
        val offset = FlowBarLayout.offsetForCenter(1200f, g)
        assertEquals(0.5f, offset, 0.001f)
        assertEquals(FlowBarLayout.MIN_OFFSET, FlowBarLayout.offsetForCenter(10f, g), 0f)
        assertEquals(FlowBarLayout.MAX_OFFSET, FlowBarLayout.offsetForCenter(2390f, g), 0f)
        assertEquals(FlowBarLayout.pillTop(0.5f, targetHeight, g, null), FlowBarLayout.pillTopForCenter(1200f, targetHeight, g, null))
    }

    @Test fun theCapsuleSitsTwelveDpAboveTheKeyboard() {
        val windowHeight = g.dp(FlowBarMetrics.CAPSULE_WINDOW_HEIGHT)
        val capsuleHeight = g.dp(FlowBarMetrics.CAPSULE_HEIGHT)
        val top = FlowBarLayout.capsuleTop(1517, windowHeight, capsuleHeight, g)
        val pad = (windowHeight - capsuleHeight) / 2
        val capsuleBottom = top + pad + capsuleHeight
        assertNear(1517 - g.dp(FlowBarMetrics.CAPSULE_ABOVE_IME), capsuleBottom)
    }

    @Test fun withoutAKeyboardTheCapsuleIs96DpAboveTheUsableBottom() {
        val windowHeight = g.dp(FlowBarMetrics.CAPSULE_WINDOW_HEIGHT)
        val capsuleHeight = g.dp(FlowBarMetrics.CAPSULE_HEIGHT)
        val top = FlowBarLayout.capsuleTop(null, windowHeight, capsuleHeight, g)
        val pad = (windowHeight - capsuleHeight) / 2
        assertNear(2400 - 126 - g.dp(FlowBarMetrics.CAPSULE_ABOVE_BOTTOM), top + pad + capsuleHeight)
    }

    @Test fun theCapsuleNeverRidesIntoTheStatusBar() {
        val windowHeight = g.dp(FlowBarMetrics.CAPSULE_WINDOW_HEIGHT)
        val capsuleHeight = g.dp(FlowBarMetrics.CAPSULE_HEIGHT)
        val top = FlowBarLayout.capsuleTop(120, windowHeight, capsuleHeight, g)   // a keyboard that fills the screen
        val pad = (windowHeight - capsuleHeight) / 2
        assertTrue(top + pad >= 63)
    }

    @Test fun theCapsuleIsCentredAndNeverWiderThanTheScreen() {
        assertEquals((1080 - 640) / 2, FlowBarLayout.capsuleLeft(640, g))
        assertEquals(0, FlowBarLayout.capsuleLeft(1080, g))
        assertEquals(0, FlowBarLayout.capsuleLeft(2000, g))
        val cutout = ScreenGeometry(2400, 1080, 120, 0, 0, 0, 2.625f)
        assertEquals(120 + (2280 - 640) / 2, FlowBarLayout.capsuleLeft(640, cutout))
    }
}

class PillVisibilityTest {
    private val ime = Box(0, 1517, 1080, 2400)
    private val typing = FieldSnapshot(ime, editableFocused = true)

    @Test fun showsWhileTypingWithTheKeyboardUp() = assertTrue(shouldShowPill(false, false, true, typing))
    @Test fun hiddenWithoutAKeyboard() = assertFalse(shouldShowPill(false, false, true, typing.copy(imeBounds = null)))
    @Test fun hiddenWhenTheFocusIsNotEditable() = assertFalse(shouldShowPill(false, false, true, typing.copy(editableFocused = false)))
    @Test fun alwaysShowShowsItEverywhere() = assertTrue(shouldShowPill(true, false, true, FieldSnapshot()))
    // The keyboard's own editor fills in a field the accessibility tree reports as a plain view.
    @Test fun anEditorTheKeyboardIsTypingIntoCountsAsAField() {
        val plainView = FieldSnapshot(ime, editableFocused = false, packageName = "com.example")
        val filled = withEditor(plainView, InputType.TYPE_CLASS_TEXT, "com.example")
        assertTrue(filled.editableFocused)
        assertTrue(shouldShowPill(false, false, true, filled))
    }
    @Test fun aPasswordEditorHidesThePillEvenWhenTheTreeSaysOtherwise() {
        val filled = withEditor(typing.copy(packageName = "com.example"), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD, "com.example")
        assertTrue(filled.password)
        assertFalse(shouldShowPill(false, false, true, filled))
    }
    @Test fun noEditorOrANullEditorChangesNothing() {
        val plainView = FieldSnapshot(ime, packageName = "com.example")
        assertEquals(plainView, withEditor(plainView, null, null))
        assertEquals(plainView, withEditor(plainView, InputType.TYPE_NULL, "com.example"))
    }
    @Test fun anEditorFromAnotherAppIsIgnored() {
        val plainView = FieldSnapshot(ime, packageName = "com.example")
        assertEquals(plainView, withEditor(plainView, InputType.TYPE_CLASS_TEXT, "com.other"))
    }
    @Test fun anEditorFillsInTheAppWhenTheTreeFoundNoNode() {
        val filled = withEditor(FieldSnapshot(ime), InputType.TYPE_CLASS_TEXT, "com.example")
        assertTrue(filled.editableFocused)
        assertEquals("com.example", filled.packageName)
    }
    @Test fun neverOverAPasswordField() {
        assertFalse(shouldShowPill(false, false, true, typing.copy(password = true)))
        assertFalse(shouldShowPill(true, false, true, typing.copy(password = true)))
    }
    @Test fun neverOnTheLockScreen() {
        assertFalse(shouldShowPill(false, true, true, typing))
        assertFalse(shouldShowPill(true, true, true, typing))
    }
    @Test fun neverWhileTheScreenIsOff() = assertFalse(shouldShowPill(true, false, false, typing))
    @Test fun anEmptyKeyboardWindowIsNoKeyboard() = assertFalse(FieldSnapshot(Box(0, 0, 0, 0), editableFocused = true).imeVisible)
}

class SpacingTest {
    @Test fun addsASpaceAfterAWord() = assertTrue(needsLeadingSpace("Hello", "world"))
    @Test fun addsASpaceAfterSentencePunctuation() = assertTrue(needsLeadingSpace("Hello.", "World"))
    @Test fun noSpaceInAnEmptyField() { assertFalse(needsLeadingSpace("", "hello")); assertFalse(needsLeadingSpace(null, "hello")) }
    @Test fun noSpaceAfterWhitespaceOrANewline() {
        assertFalse(needsLeadingSpace("Hello ", "world"))
        assertFalse(needsLeadingSpace("Hello\n", "world"))
        assertFalse(needsLeadingSpace("Hello ", "world"))
        assertFalse(needsLeadingSpace("Hello\t", "world"))
    }
    @Test fun noSpaceBeforeClosingPunctuation() {
        listOf(".", ",", ";", ":", "!", "?", ")", "]", "%", "…", "”", "’").forEach {
            assertFalse("before '$it'", needsLeadingSpace("Hello", it + " rest"))
        }
    }
    @Test fun aTextThatStartsWithASpaceIsLeftAlone() = assertFalse(needsLeadingSpace("Hello", " world"))
    @Test fun spaceBeforeAnOpeningBracketOrAMention() {
        assertTrue(needsLeadingSpace("Hello", "(maybe)"))
        assertTrue(needsLeadingSpace("Hello", "@sam"))
        assertTrue(needsLeadingSpace("Hello", "#tag"))
    }
    @Test fun noSpaceAfterAnOpeningBracketOrASlash() {
        assertFalse(needsLeadingSpace("(", "maybe"))
        assertFalse(needsLeadingSpace("Hello “", "world"))
        assertFalse(needsLeadingSpace("@", "sam"))
        assertFalse(needsLeadingSpace("http://", "example"))
    }
    @Test fun noSpaceInScriptsWrittenWithoutSpaces() {
        assertFalse(needsLeadingSpace("你好", "世界"))
        assertFalse(needsLeadingSpace("こんにちは", "世界"))
        assertFalse(needsLeadingSpace("hello", "世界"))
        assertFalse(needsLeadingSpace("สวัสดี", "ครับ"))
        assertTrue("Korean is written with spaces", needsLeadingSpace("안녕", "하세요"))
    }
    @Test fun noSpaceWhenThereIsNothingToInsert() = assertFalse(needsLeadingSpace("Hello", ""))
    @Test fun surrogatePairsAreRead() {
        assertTrue(needsLeadingSpace("Hello 😀", "world"))   // an emoji is not whitespace
    }

    @Test fun trailingSpaceBeforeAWord() = assertTrue(needsTrailingSpace("the hand off", "typed after"))
    @Test fun noTrailingSpaceAtTheEndOfTheField() { assertFalse(needsTrailingSpace("", "x")); assertFalse(needsTrailingSpace(null, "x")) }
    @Test fun noTrailingSpaceBeforeWhitespace() = assertFalse(needsTrailingSpace(" more", "x"))
    @Test fun noTrailingSpaceBeforeClosingPunctuation() {
        assertFalse(needsTrailingSpace(", and", "x"))
        assertFalse(needsTrailingSpace(".", "x"))
        assertFalse(needsTrailingSpace(")", "x"))
    }
    @Test fun noTrailingSpaceWhenTheTextAlreadyEndsInOne() = assertFalse(needsTrailingSpace("more", "x "))
    @Test fun noTrailingSpaceAfterAnOpeningBracketOrInCjk() {
        assertFalse(needsTrailingSpace("more", "see ("))
        assertFalse(needsTrailingSpace("世界", "你好"))
    }
}

class InputTypeTest {
    @Test fun passwordVariationsAreDetected() {
        val text = InputType.TYPE_CLASS_TEXT
        assertTrue(isPasswordInputType(text or InputType.TYPE_TEXT_VARIATION_PASSWORD))
        assertTrue(isPasswordInputType(text or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD))
        assertTrue(isPasswordInputType(text or InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD))
        assertTrue(isPasswordInputType(InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD))
    }

    @Test fun ordinaryFieldsAreNot() {
        assertFalse(isPasswordInputType(InputType.TYPE_CLASS_TEXT))
        assertFalse(isPasswordInputType(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE))
        assertFalse(isPasswordInputType(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS))
        assertFalse(isPasswordInputType(InputType.TYPE_CLASS_NUMBER))
        assertFalse(isPasswordInputType(InputType.TYPE_NULL))
    }

    @Test fun aFlagDoesNotHideAPassword() {
        assertTrue(isPasswordInputType(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS))
    }
}

class TypingTest {
    @Test fun typesIntoAnEmptyFieldWithoutASpace() {
        val field = FakeField("")
        val result = typeThrough(field, "hello world")
        assertEquals("hello world", field.text)
        val inserted = (result as TypeResult.Typed).inserted
        assertEquals(InsertedText("", "hello world", "", 0), inserted)
    }

    @Test fun addsALeadingSpaceAfterExistingText() {
        val field = FakeField("Hello")
        val inserted = (typeThrough(field, "world") as TypeResult.Typed).inserted
        assertEquals("Hello world", field.text)
        assertEquals(InsertedText(" ", "world", "", 5), inserted)
    }

    @Test fun noSpaceBeforeAFullStop() {
        val field = FakeField("Hello")
        typeThrough(field, ".")
        assertEquals("Hello.", field.text)
    }

    @Test fun addsATrailingSpaceWhenTypingInFrontOfAWord() {
        val field = FakeField("typed after the hand off", selStart = 12)
        val inserted = (typeThrough(field, "ship it") as TypeResult.Typed).inserted
        assertEquals("typed after ship it the hand off", field.text)
        assertEquals("", inserted.prefix)
        assertEquals(" ", inserted.suffix)
        assertEquals(12, inserted.start)
    }

    @Test fun replacesASelection() {
        val field = FakeField("Hello big world", selStart = 6, selEnd = 9)
        typeThrough(field, "small")
        assertEquals("Hello small world", field.text)
    }

    @Test fun anEditorThatIgnoresTheCommitFallsThrough() {
        assertEquals(TypeResult.NotApplied, typeThrough(FakeField("Hello", ignoreCommit = true), "world"))
        assertEquals(TypeResult.NotApplied, typeThrough(FakeField("", ignoreCommit = true), "world"))
    }

    @Test fun anEditorThatRewritesTheTextIsAcceptedButNotRemembered() {
        val field = FakeField("Hello", transform = { it.uppercase() })
        val result = typeThrough(field, "world")
        assertEquals("Hello WORLD", field.text)
        assertTrue(result is TypeResult.TypedUnknown)
        assertEquals(-1, (result as TypeResult.TypedUnknown).inserted.start)
    }

    @Test fun aConnectionThatStopsAnsweringIsReportedAsUnverifiedNotAsSuccess() {
        val field = FakeField("Hello", goesBlindAfterCommit = true)
        val result = typeThrough(field, "world")
        assertTrue(result is TypeResult.Unverified)
        assertEquals("world", (result as TypeResult.Unverified).inserted.body)
    }

    @Test fun anEditorThatCannotReportPositionsStillWorks() {
        val field = FakeField("Hello", reportsOffset = false)
        val inserted = (typeThrough(field, "world") as TypeResult.Typed).inserted
        assertEquals("Hello world", field.text)
        assertEquals(-1, inserted.start)
    }

    @Test fun classifyCommit() {
        fun s(text: String, cursor: Int = text.length) = Surrounding(text, cursor, cursor, 0)
        assertEquals(CommitCheck.APPLIED, classifyCommit("Hello", s("Hello world"), " world"))
        assertEquals(CommitCheck.NOT_APPLIED, classifyCommit("Hello", s("Hello"), " world"))
        assertEquals(CommitCheck.NOT_APPLIED, classifyCommit("", s(""), "world"))
        assertEquals(CommitCheck.CHANGED, classifyCommit("Hello", s("Hello WORLD"), " world"))
        assertEquals("cannot be confirmed from here", CommitCheck.UNKNOWN, classifyCommit("Hello", null, " world"))
    }

    @Test fun mergeIntoSelectionReplacesTheSelectionAndPlacesTheCaret() {
        val merged = mergeIntoSelection("Hello big world", 6, 9, "small")
        assertEquals("Hello small world", merged.text)
        assertEquals(11, merged.caret)
        assertEquals(6, merged.insertStart)
    }

    @Test fun mergeIntoSelectionWithNoSelectionAppends() {
        assertEquals("Hello world", mergeIntoSelection("Hello", -1, -1, " world").text)
        assertEquals("abc", mergeIntoSelection(null, 0, 0, "abc").text)
        assertEquals("a selection past the end is clamped", "ab-", mergeIntoSelection("ab", 9, 9, "-").text)
    }

    @Test fun mergeIntoSelectionAcceptsABackwardsSelection() {
        assertEquals("Hello small world", mergeIntoSelection("Hello big world", 9, 6, "small").text)
    }
}

class PolishReplaceTest {
    private fun typed(field: FakeField, text: String): InsertedText = (typeThrough(field, text) as TypeResult.Typed).inserted

    @Test fun replacesTheDictationInPlaceWhenItIsStillExactlyThere() {
        val field = FakeField("Hello")
        val inserted = typed(field, "see you at six")
        val outcome = replaceInserted(inserted, field, "See you at six.")
        assertEquals("Hello See you at six.", field.text)
        val replaced = outcome as PolishOutcome.Replaced
        assertEquals("See you at six.", replaced.inserted.body)
        assertEquals(" ", replaced.inserted.prefix)
        assertEquals("the leading space is kept, not selected", 1, field.selects)
    }

    @Test fun theRangeIsFoundEvenWhenTheCursorMovedAway() {
        val field = FakeField("Hello")
        val inserted = typed(field, "see you at six")
        field.selStart = 0; field.selEnd = 0
        val outcome = replaceInserted(inserted, field, "See you at six.")
        assertEquals("Hello See you at six.", field.text)
        assertTrue(outcome is PolishOutcome.Replaced)
    }

    @Test fun textAfterTheInsertionIsUntouched() {
        val field = FakeField("typed after the hand off", selStart = 12)
        val inserted = typed(field, "ship it on friday")
        replaceInserted(inserted, field, "Ship it on Friday.")
        assertEquals("typed after Ship it on Friday. the hand off", field.text)
    }

    @Test fun goesToTheClipboardWhenTheUserEditedTheDictation() {
        val field = FakeField("")
        val inserted = typed(field, "see you at six")
        field.text = "see you at seven"; field.selStart = field.text.length; field.selEnd = field.selStart
        val outcome = replaceInserted(inserted, field, "See you at six.")
        assertEquals("see you at seven", field.text)
        assertEquals("See you at six.", (outcome as PolishOutcome.Moved).polished)
    }

    @Test fun goesToTheClipboardWhenTextWasAddedBeforeIt() {
        val field = FakeField("Hello")
        val inserted = typed(field, "see you")
        field.text = "Oh. " + field.text
        val outcome = replaceInserted(inserted, field, "See you.")
        assertTrue("the range moved by 4, so it is not exactly where it was", outcome is PolishOutcome.Moved)
        assertEquals("Oh. Hello see you", field.text)
    }

    @Test fun goesToTheClipboardWhenTheFieldIsGone() {
        val outcome = replaceInserted(InsertedText("", "x", "", 0), null, "X.")
        assertEquals(PolishOutcome.Moved("X."), outcome)
    }

    @Test fun goesToTheClipboardWhenNothingWasRemembered() {
        assertEquals(PolishOutcome.Moved("X."), replaceInserted(null, FakeField("x"), "X."))
    }

    @Test fun withoutOffsetsItReplacesWhileTheCursorSitsRightBehindTheDictation() {
        val field = FakeField("Hello", reportsOffset = false)
        val inserted = typed(field, "see you")
        val outcome = replaceInserted(inserted, field, "See you.")
        assertEquals("Hello See you.", field.text)
        assertTrue(outcome is PolishOutcome.Replaced)
        assertEquals("took the text back instead of selecting", 1, field.deletes)
    }

    @Test fun withoutOffsetsAMovedCursorMeansGoToTheClipboard() {
        val field = FakeField("Hello", reportsOffset = false)
        val inserted = typed(field, "see you")
        field.selStart = 2; field.selEnd = 2
        assertTrue(replaceInserted(inserted, field, "See you.") is PolishOutcome.Moved)
        assertEquals("Hello see you", field.text)
    }

    @Test fun withoutOffsetsATrailingSpaceIsKeptBehindThePolishedText() {
        val field = FakeField("one two", selStart = 4, reportsOffset = false)
        val inserted = typed(field, "mid")
        assertEquals("one mid two", field.text)
        replaceInserted(inserted, field, "Mid.")
        assertEquals("one Mid. two", field.text)
    }

    @Test fun polishInPlaceAsksForTheFieldOnlyAfterPolishingFinished() = runBlocking {
        val field = FakeField("Hello")
        val inserted = typed(field, "see you")
        var polishedWith: String? = null
        var surfaceAskedAfterPolish = false
        val outcome = polishInPlace("see you", inserted, {
            surfaceAskedAfterPolish = polishedWith != null
            field
        }) { text -> polishedWith = text; "See you." }
        assertEquals("see you", polishedWith)
        assertTrue(surfaceAskedAfterPolish)
        assertEquals("Hello See you.", field.text)
        assertTrue(outcome is PolishOutcome.Replaced)
    }

    @Test fun anErrorFromPolishPropagatesAndLeavesTheFieldAlone() {
        val field = FakeField("Hello")
        val inserted = typed(field, "see you")
        val failure = runCatching {
            runBlocking { polishInPlace("see you", inserted, { field }) { throw IllegalStateException("Sign in to polish text.") } }
        }.exceptionOrNull()
        assertEquals("Sign in to polish text.", failure?.message)
        assertEquals("Hello see you", field.text)
    }

    @Test fun locateRejectsAnEmptyInsertion() = assertNull(locateInserted(InsertedText("", "", "", 0), Surrounding("abc", 3, 3, 0)))

    @Test fun locateFindsTheBodyInsideTheFullInsertion() {
        val found = locateInserted(InsertedText(" ", "world", "", 5), Surrounding("Hello world", 11, 11, 0))
        assertNotNull(found)
        assertEquals(6, found!!.bodyStart)
        assertEquals(11, found.bodyEnd)
        assertEquals(6, found.absoluteBodyStart)
    }
}

class ErrorTest {
    @Test fun sortsTheControllersMessages() {
        assertEquals(ErrorKind.NO_SPEECH, classifyError("No speech was recognized. Try again a little closer to the microphone."))
        assertEquals(ErrorKind.MICROPHONE, classifyError("Allow microphone access to start dictation."))
        assertEquals(ErrorKind.MICROPHONE, classifyError("Allow microphone access in Android settings."))
        assertEquals(ErrorKind.MICROPHONE, classifyError("Android denied microphone access. Check Voxden's permissions."))
        assertEquals(ErrorKind.NETWORK, classifyError("Your phone's speech engine needs a connection. Check your network and try again."))
        assertEquals(ErrorKind.NETWORK, classifyError("Cannot reach Voxden Cloud. Check your internet connection."))
        assertEquals(ErrorKind.TIMEOUT, classifyError("Voxden Cloud took too long to respond. Try again."))
        assertEquals(ErrorKind.TIMEOUT, classifyError("Android speech did not return a result. Please try again."))
        assertEquals(ErrorKind.BUSY, classifyError("Your phone's speech engine is busy. Wait a moment and try again."))
        assertEquals(ErrorKind.LANGUAGE, classifyError("This language isn't available in your phone's speech engine."))
        assertEquals(ErrorKind.SIGN_IN, classifyError("Sign in to polish text."))
        assertEquals(ErrorKind.CLOUD_NEEDED, classifyError("Polish uses Voxden Cloud minutes. Start your free trial or upgrade to Pro."))
        assertEquals(ErrorKind.CLOUD_NEEDED, classifyError("Turn on Voxden Cloud to polish text."))
        assertEquals(ErrorKind.OTHER, classifyError("Something odd happened."))
        assertEquals(ErrorKind.OTHER, classifyError(null))
    }

    @Test fun onlyAMissingPermissionOpensTheApp() {
        assertTrue(needsMicrophonePermission("Allow microphone access to start dictation."))
        assertTrue(needsMicrophonePermission("Allow microphone access in Android settings."))
        assertFalse(needsMicrophonePermission("Android denied microphone access. Check Voxden's permissions."))
        assertFalse(needsMicrophonePermission("No speech was recognized."))
        assertFalse(needsMicrophonePermission(null))
    }

    @Test fun firstSentenceIsShortened() {
        assertEquals("Disk is full", firstSentence("Disk is full. Free some space and try again."))
        assertEquals("", firstSentence(null))
        val long = firstSentence("This message has no full stop but runs on and on and on")
        assertTrue(long.length <= 30)
        assertTrue(long.endsWith("…"))
        assertTrue(abs(long.length - 30) <= 1)
    }
}
