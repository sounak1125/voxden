package com.voxden.android.services

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.os.Build
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.voxden.android.R

/**
 * The few Android Views Voxden still uses (the voice-keyboard backup path: the recording screen and the keyboard
 * itself), dressed in the same tokens as the Compose app: canvas and surface steps, hairlines, mint pills.
 */
internal object NativeStyle {
    val canvas = Color.parseColor("#0B0C0D")
    val raised = Color.parseColor("#1B1E21")
    val hairline = Color.parseColor("#24282B")
    val hairlineStrong = Color.parseColor("#30363A")
    val text = Color.parseColor("#EEF1EF")
    val text2 = Color.parseColor("#A3ADA6")
    val mint = Color.parseColor("#9CF3C4")
    val onMint = Color.parseColor("#0E2A1C")

    fun dp(context: Context, value: Int) = (value * context.resources.displayMetrics.density).toInt()

    /** Inter at the given weight (variable font on Android 9+, regular or bold before that). */
    fun inter(context: Context, weight: Int): Typeface {
        val base = context.resources.getFont(R.font.inter_variable)
        return if (Build.VERSION.SDK_INT >= 28) Typeface.create(base, weight, false)
        else if (weight >= 600) Typeface.create(base, Typeface.BOLD) else base
    }

    fun sora(context: Context): Typeface = context.resources.getFont(R.font.sora_semibold)

    fun shape(fill: Int, radiusPx: Float, strokePx: Int = 0, stroke: Int = hairline) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = radiusPx
        if (strokePx > 0) setStroke(strokePx, stroke)
    }

    fun header(context: Context, title: String = "Voxden", size: Float = 20f) = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(ImageView(context).apply {
            setImageResource(R.drawable.voxden_logo)
            scaleType = ImageView.ScaleType.FIT_CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        }, LinearLayout.LayoutParams(dp(context, 30), dp(context, 30)).apply { marginEnd = dp(context, 8) })
        addView(TextView(context).apply {
            text = title
            textSize = size
            typeface = sora(context)
            letterSpacing = -0.015f
            setTextColor(NativeStyle.text)
        })
    }

    /** The vertical container. [card] gives the rounded, hairline-edged dialog look; otherwise it is flat canvas for the keyboard. */
    fun column(context: Context, card: Boolean = false) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(context, 20), dp(context, if (card) 22 else 14), dp(context, 20), dp(context, if (card) 20 else 14))
        background = if (card) shape(raised, dp(context, 28).toFloat(), 1, hairlineStrong) else ColorDrawable(canvas)
    }

    /** A 1dp hairline across the top of the keyboard. */
    fun hairlineView(context: Context) = View(context).apply {
        setBackgroundColor(hairline)
        layoutParams = LinearLayout.LayoutParams(-1, 1)
    }

    fun label(context: Context, value: String, size: Float = 16f, prominent: Boolean = false) = TextView(context).apply {
        text = value
        textSize = size
        typeface = inter(context, if (prominent) 500 else 400)
        setTextColor(if (prominent) NativeStyle.text else text2)
        setLineSpacing(0f, 1.18f)
        setPadding(0, dp(context, 6), 0, dp(context, 6))
    }

    /** A pill button: mint when [primary], a hairline outline otherwise. [compact] is 44dp tall instead of 54dp. */
    fun button(context: Context, value: String, primary: Boolean = false, compact: Boolean = false, action: () -> Unit) = PillButton(context).apply {
        text = value
        isAllCaps = false
        textSize = 16f
        typeface = inter(context, 600)
        stateListAnimator = null
        minHeight = dp(context, if (compact) 44 else 54)
        minimumHeight = minHeight
        setPadding(dp(context, 18), 0, dp(context, 18), 0)
        setTextColor(if (primary) onMint else NativeStyle.text)
        val radius = dp(context, 27).toFloat()
        val fill = if (primary) shape(mint, radius) else shape(Color.TRANSPARENT, radius, 1, hairlineStrong)
        val mask = shape(Color.WHITE, radius)
        background = RippleDrawable(ColorStateList.valueOf(if (primary) Color.parseColor("#33000000") else Color.parseColor("#1AFFFFFF")), fill, mask)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(context, 10) }
        setOnClickListener { action() }
    }
}

/** A Button that dims itself when disabled, so the pill never has to swap drawables. */
internal class PillButton(context: Context) : Button(context) {
    override fun setEnabled(enabled: Boolean) {
        super.setEnabled(enabled)
        alpha = if (enabled) 1f else 0.4f
    }
}
