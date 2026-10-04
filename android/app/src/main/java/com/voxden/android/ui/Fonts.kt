@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package com.voxden.android.ui

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import com.voxden.android.R

/**
 * Voxden's typefaces, all SIL OFL 1.1 (notices in assets/licenses):
 * Inter for everything you read, Sora for display titles, Instrument Serif italic as a rare accent.
 */
private fun inter(weight: Int) = Font(R.font.inter_variable, FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)))

val InterFamily = FontFamily(inter(400), inter(500), inter(600), inter(700))
val SoraFamily = FontFamily(
    Font(R.font.sora_regular, FontWeight.Normal),
    Font(R.font.sora_semibold, FontWeight.SemiBold)
)
val SerifAccentFamily = FontFamily(Font(R.font.instrument_serif_italic, FontWeight.Normal, FontStyle.Italic))
