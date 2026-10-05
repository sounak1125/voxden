package com.voxden.android.flowbar

import com.voxden.android.ui.island.IslandMeter
import com.voxden.android.ui.island.IslandSpinner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

class IslandMeterTest {
    @Test fun aSilentRoomIsAFlatRowOfDots() {
        for (bar in 0 until IslandMeter.BARS) assertEquals(0f, IslandMeter.target(0f, bar, 1.7f), 0f)
        assertEquals(IslandMeter.MIN_HEIGHT_DP, IslandMeter.heightDp(0f), 0f)
    }

    @Test fun louderSpeechSwingsTheBarsFurther() {
        for (bar in 0 until IslandMeter.BARS) {
            var last = 0f
            for (level in listOf(0.05f, 0.2f, 0.4f, 0.7f, 1f)) {
                val t = IslandMeter.target(level, bar, 0.37f)
                assertTrue("bar $bar at $level", t > last)
                last = t
            }
        }
    }

    @Test fun theMiddleBarsLeadAndTheEdgesTrail() {
        val t = 0.0f
        val values = (0 until IslandMeter.BARS).map { IslandMeter.target(0.8f, it, t) }
        val centre = values[IslandMeter.BARS / 2]
        assertTrue(values.first() < centre && values.last() < centre)
        assertTrue("the bell is not flat", centre - values.first() > 0.2f)
    }

    @Test fun theVariationBetweenBarsIsSmoothInTimeNotFlicker() {
        // Two instants 16 ms apart (one frame) must be close; the meter drifts, it does not jump.
        for (bar in 0 until IslandMeter.BARS) {
            var worst = 0f
            var time = 0f
            while (time < 3f) {
                worst = maxOf(worst, abs(IslandMeter.target(0.6f, bar, time + 0.016f) - IslandMeter.target(0.6f, bar, time)))
                time += 0.016f
            }
            assertTrue("bar $bar jumps by $worst in one frame", worst < 0.03f)
        }
    }

    @Test fun targetsStayInRange() {
        for (level in listOf(-1f, 0f, 0.3f, 1f, 5f)) for (bar in -2..IslandMeter.BARS + 2) {
            val t = IslandMeter.target(level, bar, 2.2f)
            assertTrue(t in 0f..1f)
        }
    }

    @Test fun theFilterRisesFasterThanItFalls() {
        val up = IslandMeter.smooth(0f, 1f, 0.05f)
        val down = 1f - IslandMeter.smooth(1f, 0f, 0.05f)
        assertTrue("attack $up vs release $down", up > down)
    }

    @Test fun theFilterConvergesWithoutOvershooting() {
        var x = 0f
        repeat(200) {
            val next = IslandMeter.smooth(x, 0.8f, 0.016f)
            assertTrue(next >= x && next <= 0.8f)
            x = next
        }
        assertEquals(0.8f, x, 0.001f)
    }

    @Test fun theFilterDoesNotDependOnTheFrameRate() {
        var coarse = 0f
        repeat(10) { coarse = IslandMeter.smooth(coarse, 1f, 0.032f) }       // 30 fps for 320 ms
        var fine = 0f
        repeat(20) { fine = IslandMeter.smooth(fine, 1f, 0.016f) }           // 60 fps for 320 ms
        assertEquals(coarse, fine, 0.001f)
    }

    @Test fun noTimePassedMeansNoChange() = assertEquals(0.3f, IslandMeter.smooth(0.3f, 1f, 0f), 0f)

    @Test fun heightsMapOntoTheBarRange() {
        assertEquals(IslandMeter.MIN_HEIGHT_DP, IslandMeter.heightDp(-1f), 0f)
        assertEquals(IslandMeter.MAX_HEIGHT_DP, IslandMeter.heightDp(2f), 0f)
        assertEquals((IslandMeter.MIN_HEIGHT_DP + IslandMeter.MAX_HEIGHT_DP) / 2f, IslandMeter.heightDp(0.5f), 0.001f)
    }
}

class IslandSpinnerTest {
    @Test fun theHeadIsWhiteAndTheTailIsGrey() {
        assertEquals(1f, IslandSpinner.spokeAlpha(3, 3), 0f)
        for (behind in 1 until IslandSpinner.SPOKES) {
            val spoke = (3 - behind + IslandSpinner.SPOKES) % IslandSpinner.SPOKES
            assertTrue(IslandSpinner.spokeAlpha(spoke, 3) < IslandSpinner.spokeAlpha((spoke + 1) % IslandSpinner.SPOKES, 3) || behind == IslandSpinner.SPOKES - 1)
        }
        assertTrue("the faintest spoke is still visible", IslandSpinner.spokeAlpha(4, 3) >= 0.2f)
    }
}
