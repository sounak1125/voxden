package com.voxden.android.core

import com.voxden.android.flowbar.ErrorKind
import com.voxden.android.flowbar.classifyError
import com.voxden.android.ui.shortError
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

    @Test fun onlyAPlainHttpsAddressIsOpened() {
        assertTrue(ProUpgrade.isSecureUrl("https://rzp.io/i/abc123"))
        assertTrue(ProUpgrade.isSecureUrl("https://rzp.io/i/abc123?x=1#y"))
        assertFalse(ProUpgrade.isSecureUrl("http://rzp.io/i/abc123"))
        assertFalse(ProUpgrade.isSecureUrl("HTTPS://rzp.io/i/abc123"))
        assertFalse(ProUpgrade.isSecureUrl("intent://rzp.io/#Intent;scheme=https;end"))
        assertFalse(ProUpgrade.isSecureUrl("javascript:alert(1)"))
        assertFalse(ProUpgrade.isSecureUrl("https://"))
        assertFalse(ProUpgrade.isSecureUrl(""))
        assertFalse(ProUpgrade.isSecureUrl("https://rzp.io/i/abc 123"))
        assertFalse(ProUpgrade.isSecureUrl("https://rzp.io/i/abc\n123"))
    }

    @Test fun anAddressWithNoRealHostOrWithAUserNameInFrontIsNotOpened() {
        assertFalse("no host", ProUpgrade.isSecureUrl("https:///x"))
        assertFalse("no host", ProUpgrade.isSecureUrl("https://?x=1"))
        assertFalse("looks like rzp.io but goes to evil.com", ProUpgrade.isSecureUrl("https://rzp.io@evil.com/"))
        assertFalse("user name and password", ProUpgrade.isSecureUrl("https://user:pass@rzp.io/"))
    }

    @Test fun anAbsurdlyLongAddressIsNotOpened() {
        assertTrue(ProUpgrade.isSecureUrl("https://rzp.io/" + "a".repeat(2000)))
        assertFalse(ProUpgrade.isSecureUrl("https://rzp.io/" + "a".repeat(2100)))
    }

    @Test fun checkoutErrorsAreSpelledOutFromTheServiceCode() {
        assertEquals("Voxden Pro isn't sold in your country yet.", ProUpgrade.checkoutError("country", "x"))
        assertEquals("That plan isn't offered in your region.", ProUpgrade.checkoutError("region", "x"))
        assertEquals("Payments aren't open yet. Please try again soon.", ProUpgrade.checkoutError("unconfigured", "x"))
        assertEquals(ProUpgrade.ALREADY_SUBSCRIBED, ProUpgrade.checkoutError("subscription", "x"))
        assertEquals("The payment provider isn't answering. Try again in a minute.", ProUpgrade.checkoutError("provider", "x"))
    }

    @Test fun anUnknownOrMissingCodeKeepsTheServicesOwnMessage() {
        assertEquals("Sign in again.", ProUpgrade.checkoutError(null, "Sign in again."))
        assertEquals("Only monthly subscriptions are available.", ProUpgrade.checkoutError("plan", "Only monthly subscriptions are available."))
    }

    @Test fun theWaitNotesTellThePersonNotToPayTwice() {
        assertTrue(ProUpgrade.WAIT_TIMED_OUT.contains("don't pay again"))
        assertTrue(ProUpgrade.WAIT_STOPPED.contains("don't pay again"))
    }

    @Test fun noPaymentMessageIsRelabelledByTheErrorClassifiers() {
        // classifyError and shortError sort messages by the words in them; none of these should match a rule.
        val messages = listOf("country", "region", "unconfigured", "subscription", "provider").map { ProUpgrade.checkoutError(it, "") } +
            listOf(
                "The payment page address wasn't secure, so it wasn't opened.", "Voxden only opens secure links.",
                "Couldn't open the payment page. Check that a web browser is installed.",
                ProUpgrade.WAIT_TIMED_OUT, ProUpgrade.WAIT_STOPPED
            )
        for (message in messages) {
            assertEquals(message, ErrorKind.OTHER, classifyError(message))
            assertEquals(message, "Couldn't finish", shortError(message))
        }
    }

    @Test fun theOfferLineShowsThePriceAndTheMostHoursWhenKnown() {
        assertEquals("₹349 / month · up to 15 h of Voxden Cloud a month", ProUpgrade.offerLine(ProOffer("₹349 / month", "in", 15)))
        assertEquals("\$8 / month", ProUpgrade.offerLine(ProOffer("\$8 / month", "global", 0)))
    }

    @Test fun anUpgradeIsWaitingOnlyOnceAPaymentPageWasOpened() {
        assertFalse(Upgrade().waiting)
        assertFalse(Upgrade(offer = ProOffer("₹349 / month")).waiting)
        assertTrue(Upgrade(waitingSince = 5L).waiting)
    }
}

/** `GET /billing/options`, as the account service answers it (server/app.js billingOptions). */
class ParseOfferTest {
    private fun parse(text: String) = AppController.parseOffer(JSONObject(text))

    private val india = """{"provider":"razorpay","region":"in","label":"Razorpay","plans":[{"id":"monthly","label":"₹349 / month"}],
        "cloudHoursCap":15,"cloudCreditsCap":900,"welcomeCreditsCap":1200}"""
    private val global = """{"provider":"razorpay","region":"global","label":"Razorpay","plans":[{"id":"monthly","label":"${'$'}8 / month"}],
        "cloudHoursCap":15,"cloudCreditsCap":900,"welcomeCreditsCap":1200}"""

    @Test fun aPlacedAccountGetsItsRegionsMonthlyPlan() {
        val (offer, blocked) = parse("""{"region":"in","options":[$india]}""")
        assertEquals(ProOffer("₹349 / month", "in", 15), offer)
        assertNull(blocked)
    }

    @Test fun theDollarPlanIsReadTheSameWay() {
        val (offer, blocked) = parse("""{"region":"global","options":[$global]}""")
        assertEquals(ProOffer("\$8 / month", "global", 15), offer)
        assertNull(blocked)
    }

    @Test fun aClosedCountryIsToldSo() {
        val (offer, blocked) = parse("""{"region":"global","unavailable":"country","options":[]}""")
        assertNull(offer)
        assertEquals(OfferBlock.COUNTRY, blocked)
    }

    @Test fun noOptionsMeansPaymentsAreNotOpen() {
        assertEquals(OfferBlock.NOT_OPEN, parse("""{"region":"in","options":[]}""").second)
        assertEquals(OfferBlock.NOT_OPEN, parse("""{"region":"in"}""").second)
    }

    @Test fun anOptionWithoutAMonthlyPlanOrFromAnotherProviderIsSkipped() {
        val yearly = """{"provider":"razorpay","region":"in","plans":[{"id":"yearly","label":"₹3,490 / year"}],"cloudHoursCap":15}"""
        val other = """{"provider":"stripe","region":"in","plans":[{"id":"monthly","label":"$5 / month"}],"cloudHoursCap":15}"""
        assertEquals(OfferBlock.NOT_OPEN, parse("""{"region":"in","options":[$yearly,$other]}""").second)
        assertEquals(ProOffer("₹349 / month", "in", 15), parse("""{"region":"in","options":[$other,$yearly,$india]}""").first)
    }

    @Test fun anAccountTheServiceCouldNotPlaceIsNotOfferedAGuessedPrice() {
        val (offer, blocked) = parse("""{"options":[$india,$global]}""")
        assertNull(offer)
        assertEquals(OfferBlock.NOT_OPEN, blocked)
    }

    @Test fun anUnplacedAccountWithOnlyOneRegionOnOfferIsOfferedIt() {
        assertEquals(ProOffer("₹349 / month", "in", 15), parse("""{"options":[$india]}""").first)
    }

    @Test fun aMissingHoursFigureIsLeftOutRatherThanInvented() {
        val noHours = """{"provider":"razorpay","region":"in","plans":[{"id":"monthly","label":"₹349 / month"}]}"""
        assertEquals(ProOffer("₹349 / month", "in", 0), parse("""{"region":"in","options":[$noHours]}""").first)
    }
}
