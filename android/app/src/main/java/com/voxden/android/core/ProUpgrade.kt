package com.voxden.android.core

/** What the account service sells as Pro to this account, from `GET /billing/options`. */
data class ProOffer(
    /** The price as the service words it, for example `₹349 / month` or `$8 / month`. */
    val label: String,
    /** The region the price is for (`in` or `global`); sent back with the checkout so the price shown is the price charged. */
    val region: String? = null,
    /** Hours of Voxden Cloud a month Pro includes; 0 when the service did not say. */
    val cloudHours: Int = 0
)

/** Why Pro cannot be bought here right now. */
enum class OfferBlock {
    /** The service does not sell Pro in this account's country yet. */
    COUNTRY,
    /** The service has no payment option open. */
    NOT_OPEN
}

/** The Pro purchase in progress: the offer once loaded, and the wait that follows opening the payment page. */
data class Upgrade(
    val offer: ProOffer? = null,
    val blocked: OfferBlock? = null,
    /** When the payment page was opened (epoch milliseconds); 0 when no payment is being waited for. */
    val waitingSince: Long = 0L,
    /** A line for the upgrade panel: the wait ran out, or the account turned out to be subscribed already. */
    val note: String? = null
) {
    val waiting: Boolean get() = waitingSince > 0L
}

/**
 * The rules of buying Pro, free of Android types so they are unit tested on the JVM.
 *
 * The purchase is a hosted Razorpay page (UPI, cards and net banking in India; international cards
 * elsewhere): the app asks the account service for its address, opens it in the browser, then polls the
 * account until the service has seen the payment and switched Pro on. Nothing here depends on how the
 * payment is taken, so Google Play Billing can replace the checkout call later without touching the screens.
 */
object ProUpgrade {
    /** How often the account is checked while a payment is being waited for. */
    const val POLL_MILLIS = 10_000L
    /** How long to wait for a payment to show up before saying so. */
    const val WAIT_LIMIT_MILLIS = 20 * 60_000L

    /** Whether a payment started at [since] is still worth waiting for at [now]. */
    fun stillWaiting(since: Long, now: Long): Boolean = since > 0L && now >= since && now - since < WAIT_LIMIT_MILLIS

    /** The payment page must be an `https` address with no spaces in it; anything else is not opened. */
    fun isSecureUrl(url: String): Boolean =
        url.length > HTTPS.length && url.startsWith(HTTPS) && url.none { it.isWhitespace() }

    /** The message for a failed checkout call, from the service's error [code] when it sent one. */
    fun checkoutError(code: String?, serviceMessage: String): String = when (code) {
        "country" -> "Voxden Pro isn't sold in your country yet."
        "region" -> "That plan isn't offered in your region."
        "unconfigured" -> "Payments aren't open yet. Please try again soon."
        "subscription" -> "This account already has a Pro subscription. Checking it now."
        "provider" -> "The payment provider isn't answering. Try again in a minute."
        else -> serviceMessage
    }

    /** `₹349 / month · 15 h of Voxden Cloud a month`, or just the price when the hours are not known. */
    fun offerLine(offer: ProOffer): String =
        if (offer.cloudHours > 0) "${offer.label} · ${offer.cloudHours} h of Voxden Cloud a month" else offer.label

    private const val HTTPS = "https://"
}
