package com.voxden.android.flowbar

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.FrameLayout
import com.voxden.android.R
import com.voxden.android.core.BarSide
import com.voxden.android.ui.island.IslandMode

internal enum class Haptic { TICK, CONFIRM, REJECT }

/** What the windows tell the engine. */
internal interface FlowBarWindowEvents {
    fun pillTapped()
    fun pillPulledOut()
    /** The pill was dragged to a new height: [offset] is the new fraction of the screen height to save. */
    fun pillMoved(offset: Float)
    /** The user's haptics setting (Settings > Flow bar > Haptics). */
    fun hapticsEnabled(): Boolean
}

/**
 * The flow bar's two windows, both `TYPE_ACCESSIBILITY_OVERLAY` (so no "display over other apps"
 * permission) and both `FLAG_NOT_FOCUSABLE` (so the app's text field keeps focus and the keyboard
 * stays up):
 *
 *  - the resting pill: a small edge window exactly the size of its touch target, so every touch
 *    elsewhere reaches the app. It widens only while a finger is pulling it, to have room to stretch;
 *  - the capsule: a window just larger than the compact Island capsule, in the pill's own place on the
 *    screen edge, so it opens inward from where the pill was pulled out and leaves the rest of the
 *    screen (the field being typed into, the keyboard) uncovered.
 *
 * Both host Compose through a hand-made lifecycle ([OverlayOwner]).
 */
internal class FlowBarWindows(
    private val service: AccessibilityService,
    private val ui: FlowBarUi,
    private val events: FlowBarWindowEvents
) {
    private val windowManager: WindowManager = service.getSystemService(WindowManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private val density: Float get() = service.resources.displayMetrics.density

    private var pill: PillWindow? = null
    private var capsule: CapsuleWindow? = null
    private var imeTop: Int? = null
    private var pillSide = BarSide.RIGHT
    private var pillOffset = 0.42f
    private var capsuleMode = IslandMode.RECORDING
    private var warm: View? = null

    val isPillAttached: Boolean get() = pill != null
    val isCapsuleAttached: Boolean get() = capsule != null

    // ---- Geometry --------------------------------------------------------------------------

    @SuppressLint("DiscouragedApi")    // Android 10 and older have no WindowMetrics: the bar sizes are system dimens
    fun geometry(): ScreenGeometry {
        if (Build.VERSION.SDK_INT >= 30) {
            val metrics = windowManager.currentWindowMetrics
            val insets = metrics.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val bounds = metrics.bounds
            return ScreenGeometry(bounds.width(), bounds.height(), insets.left, insets.top, insets.right, insets.bottom, density)
        }
        @Suppress("DEPRECATION")
        val display = windowManager.defaultDisplay
        val real = DisplayMetrics()
        @Suppress("DEPRECATION")
        display.getRealMetrics(real)
        val resources = service.resources
        fun dimen(name: String): Int {
            val id = resources.getIdentifier(name, "dimen", "android")
            return if (id > 0) resources.getDimensionPixelSize(id) else 0
        }
        val landscape = real.widthPixels > real.heightPixels
        return ScreenGeometry(
            real.widthPixels, real.heightPixels, 0, dimen("status_bar_height"), 0,
            if (landscape) 0 else dimen("navigation_bar_height"), density
        )
    }

    private fun baseParams(width: Int, height: Int) = WindowManager.LayoutParams(
        width, height, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        PixelFormat.TRANSLUCENT
    ).apply {
        gravity = Gravity.TOP or Gravity.START
        title = service.getString(R.string.flow_bar_window_title)
        if (Build.VERSION.SDK_INT >= 30) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            fitInsetsTypes = 0
        } else if (Build.VERSION.SDK_INT >= 28) {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
    }

    // ---- Resting pill ----------------------------------------------------------------------

    private inner class PillWindow {
        val owner = OverlayOwner()
        val root = PillTouchHost(service) { onPillTouch(it) }
        var expanded = false
        var dragCenterY: Float? = null
        var shrink: Runnable? = null
        var removal: Runnable? = null
        lateinit var params: WindowManager.LayoutParams
        var gesture: PullGesture? = null
        var startCenterY = 0f
    }

    /** Puts the pill on screen (or moves it). Safe to call as often as the state changes. */
    fun showPill(side: BarSide, offset: Float, imeTop: Int?) {
        pillSide = side; pillOffset = offset; this.imeTop = imeTop
        ui.side = side
        val existing = pill
        if (existing != null) {
            existing.removal?.let { main.removeCallbacks(it) }; existing.removal = null
            ui.pillShown = true
            layoutPill(existing)
            return
        }
        val window = PillWindow()
        val g = geometry()
        window.params = baseParams(g.dp(FlowBarMetrics.TARGET_WIDTH), g.dp(FlowBarMetrics.TARGET_HEIGHT))
        window.root.contentDescription = service.getString(R.string.flow_bar_pill_description)
        window.root.isClickable = true
        window.root.setOnClickListener { events.pillTapped() }
        composeRoot(service, window.owner, window.root) { RestingPill(ui) }
        ui.pillShown = true
        ui.stretchPx = 0f; ui.dragging = false; ui.armed = false
        if (layoutPill(window, add = true)) pill = window
    }

    /** Animates the pill away, then removes its window. */
    fun hidePill() {
        val window = pill ?: return
        if (window.removal != null) return
        ui.pillShown = false
        val removal = Runnable { removePill(window) }
        window.removal = removal
        main.postDelayed(removal, 280)
    }

    private fun removePill(window: PillWindow) {
        window.removal?.let { main.removeCallbacks(it) }
        window.shrink?.let { main.removeCallbacks(it) }
        runCatching { windowManager.removeViewImmediate(window.root) }
        window.owner.destroy()
        if (pill === window) pill = null
    }

    /** Puts the pill window where it belongs. Returns false only when a new window could not be added. */
    private fun layoutPill(window: PillWindow, add: Boolean = false): Boolean {
        val g = geometry()
        val width = g.dp(if (window.expanded) PILL_EXPANDED_WIDTH else FlowBarMetrics.TARGET_WIDTH)
        val height = g.dp(FlowBarMetrics.TARGET_HEIGHT)
        val params = window.params
        val x = FlowBarLayout.pillLeft(pillSide, width, g)
        val y = window.dragCenterY?.let { FlowBarLayout.pillTopForCenter(it, height, g, imeTop) }
            ?: FlowBarLayout.pillTop(pillOffset, height, g, imeTop)
        // Same place as before: leave the window alone (every update can cost an accessibility event).
        if (!add && params.width == width && params.height == height && params.x == x && params.y == y) return true
        params.width = width; params.height = height; params.x = x; params.y = y
        return try {
            if (add) {
                windowManager.addView(window.root, params)
                window.owner.resume()
            } else windowManager.updateViewLayout(window.root, params)
            true
        } catch (error: Exception) {
            Log.w(TAG, "Could not place the resting pill", error)
            if (add) window.owner.destroy()
            !add
        }
    }

    private fun onPillTouch(event: MotionEvent): Boolean {
        val window = pill ?: return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                window.shrink?.let { main.removeCallbacks(it) }; window.shrink = null
                val g = geometry()
                window.gesture = PullGesture(pillSide, g.dp(FlowBarMetrics.TOUCH_SLOP).toFloat(), g.dp(FlowBarMetrics.PULL_THRESHOLD).toFloat(), g.dp(FlowBarMetrics.STRETCH_LIMIT).toFloat())
                    .also { it.down(event.rawX, event.rawY) }
                window.startCenterY = window.params.y + window.params.height / 2f
                ui.dragging = true; ui.stretchPx = 0f; ui.armed = false
            }
            MotionEvent.ACTION_MOVE -> {
                val gesture = window.gesture ?: return true
                val crossed = gesture.move(event.rawX, event.rawY)
                when (gesture.mode) {
                    PullGesture.Mode.PULLING -> {
                        if (!window.expanded) { window.expanded = true; layoutPill(window) }
                        ui.stretchPx = gesture.stretchPx
                        ui.armed = gesture.armed
                    }
                    PullGesture.Mode.MOVING -> {
                        window.dragCenterY = window.startCenterY + gesture.moveDy
                        layoutPill(window)
                    }
                    else -> Unit
                }
                if (crossed) haptic(Haptic.TICK)
            }
            MotionEvent.ACTION_UP -> {
                val gesture = window.gesture
                val outcome = gesture?.up() ?: PullOutcome.NONE
                window.gesture = null
                ui.dragging = false; ui.armed = false
                when (outcome) {
                    PullOutcome.TAP -> window.root.callOnClick()
                    PullOutcome.START -> events.pillPulledOut()
                    PullOutcome.MOVED -> window.dragCenterY?.let { events.pillMoved(FlowBarLayout.offsetForCenter(it, geometry())) }
                    else -> Unit
                }
                window.dragCenterY = null
                scheduleShrink(window)
            }
            MotionEvent.ACTION_CANCEL -> {
                window.gesture?.cancel(); window.gesture = null
                ui.dragging = false; ui.armed = false
                window.dragCenterY = null
                layoutPill(window)
                scheduleShrink(window)
            }
        }
        return true
    }

    /** Takes the pill window back to its touch-target size once its snap-back has finished. */
    private fun scheduleShrink(window: PillWindow) {
        if (!window.expanded) return
        val shrink = Runnable {
            window.shrink = null
            if (pill === window && window.gesture == null) { window.expanded = false; layoutPill(window) }
        }
        window.shrink = shrink
        main.postDelayed(shrink, 420)
    }

    // ---- Capsule ---------------------------------------------------------------------------

    private inner class CapsuleWindow {
        val owner = OverlayOwner()
        val root = FrameLayout(service)
        var shrink: Runnable? = null
        var removal: Runnable? = null
        lateinit var params: WindowManager.LayoutParams
    }

    /** Each mode's window width: its compact capsule plus a little room for the morph spring to overshoot. */
    private fun capsuleWidthDp(mode: IslandMode): Float = when (mode) {
        IslandMode.LABEL -> 120f
        IslandMode.RECORDING -> 120f
        IslandMode.PROCESSING -> 120f
        IslandMode.DONE -> 172f
        IslandMode.ERROR -> 180f
    }

    /** Opens the capsule window; the capsule itself springs open inside it. */
    fun showCapsule(mode: IslandMode, imeTop: Int?) {
        capsuleMode = mode; this.imeTop = imeTop
        val existing = capsule
        if (existing != null) {
            existing.removal?.let { main.removeCallbacks(it) }; existing.removal = null
            ui.capsuleShown = true
            layoutCapsule(existing)
            return
        }
        val window = CapsuleWindow()
        val g = geometry()
        window.params = baseParams(g.dp(capsuleWidthDp(mode)), g.dp(FlowBarMetrics.CAPSULE_WINDOW_HEIGHT))
        composeRoot(service, window.owner, window.root) { CapsuleHost(ui) }
        ui.capsuleShown = true
        if (layoutCapsule(window, add = true)) capsule = window
    }

    /** The capsule window follows the mode's width: growing at once, shrinking after the morph. */
    fun setCapsuleMode(mode: IslandMode) {
        val previous = capsuleMode
        capsuleMode = mode
        val window = capsule ?: return
        window.shrink?.let { main.removeCallbacks(it) }; window.shrink = null
        if (capsuleWidthDp(mode) >= capsuleWidthDp(previous)) layoutCapsule(window)
        else {
            val shrink = Runnable { window.shrink = null; if (capsule === window) layoutCapsule(window) }
            window.shrink = shrink
            main.postDelayed(shrink, 700)
        }
    }

    fun hideCapsule() {
        val window = capsule ?: return
        if (window.removal != null) return
        ui.capsuleShown = false
        val removal = Runnable { removeCapsule(window) }
        window.removal = removal
        main.postDelayed(removal, 320)
    }

    private fun removeCapsule(window: CapsuleWindow) {
        window.removal?.let { main.removeCallbacks(it) }
        window.shrink?.let { main.removeCallbacks(it) }
        runCatching { windowManager.removeViewImmediate(window.root) }
        window.owner.destroy()
        if (capsule === window) capsule = null
    }

    private fun layoutCapsule(window: CapsuleWindow, add: Boolean = false): Boolean {
        val g = geometry()
        val params = window.params
        // While a shrink is pending the window keeps the wider of the two modes' widths.
        val widthDp = if (window.shrink != null) maxOf(capsuleWidthDp(capsuleMode), params.width / g.density) else capsuleWidthDp(capsuleMode)
        val usable = g.width - g.insetLeft - g.insetRight - 2 * g.dp(FlowBarMetrics.SAFE_MARGIN)
        val width = minOf(g.dp(widthDp), usable)
        val height = g.dp(FlowBarMetrics.CAPSULE_WINDOW_HEIGHT)
        val x = FlowBarLayout.capsuleLeft(pillSide, width, g)
        val y = FlowBarLayout.pillTop(pillOffset, height, g, imeTop)
        if (!add && params.width == width && params.height == height && params.x == x && params.y == y) return true
        params.width = width; params.height = height; params.x = x; params.y = y
        return try {
            if (add) {
                windowManager.addView(window.root, params)
                window.owner.resume()
            } else windowManager.updateViewLayout(window.root, params)
            true
        } catch (error: Exception) {
            Log.w(TAG, "Could not place the capsule", error)
            if (add) window.owner.destroy()
            !add
        }
    }

    // ---- Warm-up ---------------------------------------------------------------------------

    /**
     * Compose's first composition, the fonts and the animation classes cost about a second on a cold
     * process. Pay it once at start-up, in a 1 px window nobody can see, instead of the first time a
     * user pulls the bar.
     */
    fun warmUp() {
        if (warm != null) return
        val owner = OverlayOwner()
        val root = FrameLayout(service)
        val warmUi = FlowBarUi().apply { capsuleShown = true; pillShown = true; mode = IslandMode.RECORDING; label = "Inserted"; actionLabel = "Polish"; level = 0.5f }
        composeRoot(service, owner, root) { WarmUpContent(warmUi) }
        val params = baseParams(1, 1).apply {
            flags = flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            alpha = 0.02f
        }
        try {
            windowManager.addView(root, params)
            owner.resume()
        } catch (error: Exception) {
            Log.w(TAG, "Warm-up window failed", error); owner.destroy(); return
        }
        warm = root
        main.postDelayed({
            runCatching { windowManager.removeViewImmediate(root) }
            owner.destroy()
            if (warm === root) warm = null
        }, 1800)
    }

    // ---- Shared ----------------------------------------------------------------------------

    /** The keyboard moved, the screen turned or the settings changed: put everything where it belongs. */
    fun relayout(imeTop: Int?, side: BarSide, offset: Float) {
        this.imeTop = imeTop; pillSide = side; pillOffset = offset
        ui.side = side
        pill?.let { if (it.gesture == null) layoutPill(it) }
        capsule?.let { layoutCapsule(it) }
    }

    fun haptic(kind: Haptic) {
        if (!events.hapticsEnabled()) return
        val view: View = pill?.root ?: capsule?.root ?: return
        val constant = when (kind) {
            Haptic.TICK -> when {
                Build.VERSION.SDK_INT >= 34 -> HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE
                else -> HapticFeedbackConstants.CLOCK_TICK
            }
            Haptic.CONFIRM -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
            Haptic.REJECT -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
        }
        view.performHapticFeedback(constant)
    }

    /** Removes every window at once (the service is stopping). */
    fun removeAll() {
        pill?.let { removePill(it) }
        capsule?.let { removeCapsule(it) }
        warm?.let { runCatching { windowManager.removeViewImmediate(it) } }
        warm = null
        ui.pillShown = false; ui.capsuleShown = false
    }

    companion object {
        private const val TAG = "VoxdenFlowBar"
        /** Room for the pill to stretch to its limit: its inset, its width, the stretch and a little air. */
        private const val PILL_EXPANDED_WIDTH = 112f
    }
}

/**
 * The resting pill's window root. It takes every touch itself (the pill is one target), reports the
 * raw stream to [onTouch] and keeps the whole window out of the system's back-gesture zone, so a pull
 * from the edge is a pull and not Back.
 */
internal class PillTouchHost(context: android.content.Context, private val onTouch: (MotionEvent) -> Boolean) : FrameLayout(context) {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean = onTouch(event)

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        if (Build.VERSION.SDK_INT >= 29) systemGestureExclusionRects = listOf(Rect(0, 0, right - left, bottom - top))
    }
}
