package com.voxden.android.core

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.android.billingclient.api.queryProductDetails
import com.android.billingclient.api.queryPurchasesAsync
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume

/** What Play will sell: the monthly Pro plan and the price Play itself shows for this buyer's country. */
class ProProduct(val details: ProductDetails, val offerToken: String, val price: String)

/** How the account service took a purchase report. */
enum class PlayReport { PRO, PENDING, REFUSED, LATER }

/**
 * The rules of buying Pro on Google Play, free of Play's classes so they are unit tested on the JVM. The purchase
 * is Play's own sheet; the app then reports the purchase token to the account service, which asks Google what it is
 * worth, acknowledges it, and switches Pro on (the app never acknowledges: the service does, so a purchase that is
 * paid for and reported is never lost to a closed app).
 */
object PlayPurchases {
    /** The price Play shows, worded like the web checkout's: `₹349.00 / month`. */
    fun priceLine(formattedPrice: String): String = "$formattedPrice / month"

    /** Google Play's page for this app's subscriptions, where a subscription is managed or cancelled. */
    fun manageUrl(packageName: String = com.voxden.android.BuildConfig.APPLICATION_ID): String =
        "https://play.google.com/store/account/subscriptions?package=$packageName"

    const val PENDING_NOTE = "Google Play is still confirming your payment. Pro switches on here by itself once it clears."
    const val PAYMENT_PENDING_NOTE = "Google Play is waiting for your payment to clear. Pro switches on here by itself once it does."
    const val LATER_NOTE = "You've paid, but Voxden couldn't reach its server to finish. Open Voxden again in a minute and Pro switches on. " +
        "You won't be charged twice."
    const val UNAVAILABLE_NOTE = "Google Play isn't available on this phone, so Pro can't be bought here."
    const val ALREADY_SUBSCRIBED = "This account already has a subscription. If you just paid, it can take a few minutes to show up here."

    /** Play's own words for a purchase that did not start, or null when the user simply backed out. */
    fun launchError(responseCode: Int): String? = when (responseCode) {
        BillingClient.BillingResponseCode.USER_CANCELED -> null
        BillingClient.BillingResponseCode.BILLING_UNAVAILABLE, BillingClient.BillingResponseCode.FEATURE_NOT_SUPPORTED -> UNAVAILABLE_NOTE
        BillingClient.BillingResponseCode.NETWORK_ERROR, BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE,
        BillingClient.BillingResponseCode.SERVICE_DISCONNECTED -> "Google Play isn't reachable right now. Try again in a minute."
        BillingClient.BillingResponseCode.ITEM_UNAVAILABLE -> "Voxden Pro isn't available on Google Play yet."
        else -> "Google Play couldn't start the purchase. Try again in a minute."
    }

    /** What a purchase report that the service answered means: Pro is on, or the payment is still settling. */
    fun reported(pending: Boolean): PlayReport = if (pending) PlayReport.PENDING else PlayReport.PRO

    /** What a refused or failed report means. A 4xx is the service saying no; anything else is worth trying again. */
    fun failed(error: ApiException): PlayReport = if (error.status in 400..499 && error.status != 401 && error.status != 429) PlayReport.REFUSED else PlayReport.LATER
}

/**
 * The Play Billing client, for the release (Play) build only. Every call is a no-op answer (null, empty, false)
 * when Play is not there, as on an emulator without the Play Store or a phone with the service disabled.
 */
class PlayBilling(context: Context, private val onPurchases: (BillingResult, List<Purchase>?) -> Unit) {
    private val client: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, purchases -> onPurchases(result, purchases) }
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()
    private val connecting = Mutex()

    private suspend fun connect(): Boolean = connecting.withLock {
        if (client.isReady) return true
        suspendCancellableCoroutine { continuation ->
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    if (continuation.isActive) continuation.resume(result.responseCode == BillingClient.BillingResponseCode.OK)
                }
                override fun onBillingServiceDisconnected() {}
            })
        }
    }

    /** The monthly plan for [productId], priced for this buyer by Play, or null when Play does not offer it. */
    suspend fun product(productId: String): ProProduct? {
        if (!connect()) return null
        val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(
            QueryProductDetailsParams.Product.newBuilder().setProductId(productId).setProductType(BillingClient.ProductType.SUBS).build()
        )).build()
        val details = client.queryProductDetails(params).productDetailsList?.firstOrNull() ?: return null
        val offers = details.subscriptionOfferDetails.orEmpty()
        // The plain base plan, not an introductory offer; the recurring price is its last phase.
        val offer = offers.firstOrNull { it.offerId == null } ?: offers.firstOrNull() ?: return null
        val price = offer.pricingPhases.pricingPhaseList.lastOrNull()?.formattedPrice ?: return null
        return ProProduct(details, offer.offerToken, price)
    }

    /** Opens Play's purchase sheet. The result of the purchase arrives later at [onPurchases]. */
    fun launch(activity: Activity, product: ProProduct, accountId: String): BillingResult {
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(
                BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product.details).setOfferToken(product.offerToken).build()
            ))
            .setObfuscatedAccountId(accountId)
            .build()
        return client.launchBillingFlow(activity, params)
    }

    /** The subscriptions Play says this Google account holds now. */
    suspend fun owned(): List<Purchase> {
        if (!connect()) return emptyList()
        val result = client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build())
        return if (result.billingResult.responseCode == BillingClient.BillingResponseCode.OK) result.purchasesList else emptyList()
    }
}
