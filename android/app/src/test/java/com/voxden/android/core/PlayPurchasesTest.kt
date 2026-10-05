package com.voxden.android.core

import com.android.billingclient.api.BillingClient
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PlayPurchasesTest {
    @Test fun thePriceReadsLikeTheWebCheckoutsWithPlaysOwnFigure() {
        assertEquals("₹349.00 / month", PlayPurchases.priceLine("₹349.00"))
        assertEquals("$8.00 / month", PlayPurchases.priceLine("$8.00"))
    }

    @Test fun theManagePageIsPlaysOwnAndNamesThePackage() {
        val url = PlayPurchases.manageUrl("com.voxden.android")
        assertEquals("https://play.google.com/store/account/subscriptions?package=com.voxden.android", url)
        assertTrue("opened through the same https-only check as every link", ProUpgrade.isSecureUrl(url))
    }

    @Test fun backingOutOfThePurchaseSheetSaysNothing() {
        assertNull(PlayPurchases.launchError(BillingClient.BillingResponseCode.USER_CANCELED))
    }

    @Test fun everyOtherFailureToStartSaysWhy() {
        val codes = listOf(
            BillingClient.BillingResponseCode.BILLING_UNAVAILABLE, BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED,
            BillingClient.BillingResponseCode.NETWORK_ERROR, BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE,
            BillingClient.BillingResponseCode.SERVICE_DISCONNECTED, BillingClient.BillingResponseCode.ITEM_UNAVAILABLE,
            BillingClient.BillingResponseCode.DEVELOPER_ERROR, BillingClient.BillingResponseCode.ERROR
        )
        for (code in codes) assertTrue("code $code has a message", !PlayPurchases.launchError(code).isNullOrBlank())
        assertEquals(PlayPurchases.UNAVAILABLE_NOTE, PlayPurchases.launchError(BillingClient.BillingResponseCode.BILLING_UNAVAILABLE))
    }

    @Test fun aSettledReportTurnsProOnAndASlowOneWaits() {
        assertEquals(PlayReport.PRO, PlayPurchases.reported(pending = false))
        assertEquals(PlayReport.PENDING, PlayPurchases.reported(pending = true))
    }

    @Test fun aRefusedReportIsTheServicesNoAndAnythingElseIsTriedAgain() {
        assertEquals(PlayReport.REFUSED, PlayPurchases.failed(ApiException(409, "That purchase belongs to another Voxden account.", "account")))
        assertEquals(PlayReport.REFUSED, PlayPurchases.failed(ApiException(400, "Google Play does not know that purchase.", "purchase")))
        assertEquals("a server error", PlayReport.LATER, PlayPurchases.failed(ApiException(502, "Google Play did not answer.", "provider")))
        assertEquals("not ready yet", PlayReport.LATER, PlayPurchases.failed(ApiException(503, "Payments are not open yet.", "unconfigured")))
        assertEquals("a rate limit", PlayReport.LATER, PlayPurchases.failed(ApiException(429, "Slow down.")))
        assertEquals("an expired sign-in is handled by signing out, not by a refusal", PlayReport.LATER, PlayPurchases.failed(ApiException(401, "Sign in again.")))
    }

    @Test fun theCloudHoursComeFromTheFirstOfferAndAreZeroWhenThereIsNone() {
        val offers = JSONObject("""{"options":[{"provider":"razorpay","region":"in","cloudHoursCap":15.0}]}""")
        assertEquals(15, AppController.cloudHoursOf(offers))
        assertEquals(0, AppController.cloudHoursOf(JSONObject("""{"options":[]}""")))
        assertEquals(0, AppController.cloudHoursOf(JSONObject("""{"unavailable":"country","options":[]}""")))
        assertEquals(0, AppController.cloudHoursOf(null))
    }
}
