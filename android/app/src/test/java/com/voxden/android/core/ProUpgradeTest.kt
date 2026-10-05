package com.voxden.android.core

import com.voxden.android.flowbar.ErrorKind
import com.voxden.android.flowbar.classifyError
import com.voxden.android.ui.shortError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProUpgradeTest {
    @Test fun aPaymentIsWaitedForTwentyMinutes() {
        val start = 1_000_000L
        assertTrue(ProUpgrade.stillWaiting(start, start))
        assertTrue(ProUpgrade.stillWaiting(start, start + ProUpgrade.WAIT_LIMIT_MILLIS - 1))
        assertFalse(ProUpgrade.stillWaiting(start, start + ProUpgrade.WAIT_LIMIT_MILLIS))
        assertFalse("no payment was started", ProUpgrade.stillWaiting(0L, start))
        assertFalse("a clock that went backwards", ProUpgrade.stillWaiting(start, start - 1))
    }

    @Test fun theAccountIsCheckedMoreOftenThanOncePerMinuteButNotInATightLoop() {
        assertTrue(ProUpgrade.POLL_MILLIS in 5_000L..30_000L)
        assertTrue(ProUpgrade.WAIT_LIMIT_MILLIS >= 10 * 60_000L)
    }

    @Test fun onlyAnHttpsAddressWithoutSpacesIsOpened() {
        assertTrue(ProUpgrade.isSecureUrl("https://rzp.io/i/abc123"))
        assertFalse(ProUpgrade.isSecureUrl("http://rzp.io/i/abc123"))
        assertFalse(ProUpgrade.isSecureUrl("HTTPS://rzp.io/i/abc123"))
        assertFalse(ProUpgrade.isSecureUrl("intent://rzp.io/#Intent;scheme=https;end"))
        assertFalse(ProUpgrade.isSecureUrl("javascript:alert(1)"))
        assertFalse(ProUpgrade.isSecureUrl("https://"))
        assertFalse(ProUpgrade.isSecureUrl(""))
        assertFalse(ProUpgrade.isSecureUrl("https://rzp.io/i/abc 123"))
        assertFalse(ProUpgrade.isSecureUrl("https://rzp.io/i/abc\n123"))
    }

    @Test fun checkoutErrorsAreSpelledOutFromTheServiceCode() {
        assertEquals("Voxden Pro isn't sold in your country yet.", ProUpgrade.checkoutError("country", "x"))
        assertEquals("That plan isn't offered in your region.", ProUpgrade.checkoutError("region", "x"))
        assertEquals("Payments aren't open yet. Please try again soon.", ProUpgrade.checkoutError("unconfigured", "x"))
        assertEquals("This account already has a Pro subscription. Checking it now.", ProUpgrade.checkoutError("subscription", "x"))
        assertEquals("The payment provider isn't answering. Try again in a minute.", ProUpgrade.checkoutError("provider", "x"))
    }

    @Test fun anUnknownOrMissingCodeKeepsTheServicesOwnMessage() {
        assertEquals("Sign in again.", ProUpgrade.checkoutError(null, "Sign in again."))
        assertEquals("Only monthly subscriptions are available.", ProUpgrade.checkoutError("plan", "Only monthly subscriptions are available."))
    }

    @Test fun noPaymentMessageIsRelabelledByTheErrorClassifiers() {
        // classifyError and shortError sort messages by the words in them; none of these should match a rule.
        val messages = listOf("country", "region", "unconfigured", "subscription", "provider").map { ProUpgrade.checkoutError(it, "") } +
            listOf("The payment page address wasn't secure, so it wasn't opened.", "Voxden only opens secure links.")
        for (message in messages) {
            assertEquals(message, ErrorKind.OTHER, classifyError(message))
            assertEquals(message, "Couldn't finish", shortError(message))
        }
    }

    @Test fun theOfferLineShowsThePriceAndTheHoursWhenKnown() {
        assertEquals("₹349 / month · 15 h of Voxden Cloud a month", ProUpgrade.offerLine(ProOffer("₹349 / month", "in", 15)))
        assertEquals("\$8 / month", ProUpgrade.offerLine(ProOffer("\$8 / month", "global", 0)))
    }

    @Test fun anUpgradeIsWaitingOnlyOnceAPaymentPageWasOpened() {
        assertFalse(Upgrade().waiting)
        assertFalse(Upgrade(offer = ProOffer("₹349 / month")).waiting)
        assertTrue(Upgrade(waitingSince = 5L).waiting)
    }
}
