package com.voxden.android.core

import java.net.URI

/** What the account service sells as Pro to this account, from `GET /billing/options`. */
data class ProOffer(
    /** The price as the service words it, for example `₹349 / month` or `$8 / month`. */
    val label: String,
    /** The region the price is for (`in` or `global`); sent back with the checkout so the price shown is the price charged. */
    val region: String? = null,
    /** Hours of Voxden Cloud a month Pro includes, at most; 0 when the service did not say. */
    val cloudHours: Int = 0
)

/** Why Pro cannot be bought here right now. */
enum class OfferBlock {
    /** The service does not sell Pro in this account's country yet. */
    COUNTRY,
    /** The service has no payment option open, or cannot tell which one is for this account. */
    NOT_OPEN
}

/** The Pro purchase in progress: the offer once loaded, and the wait that follows opening the payment page. */
data class Upgrade(
    val offer: ProOffer? = null,
    val blocked: OfferBlock? = null,
    /** The price could not be fetched; nothing is bought until it can be shown. */
    val offerFailed: Boolean = false,
    /** When the payment page was opened (epoch milliseconds); 0 when no payment is being waited for. */
    val waitingSince: Long = 0L,
    /** A line for the upgrade panel: the wait ended without Pro, or the account is subscribed already. */
    val note: String? = null
) {
    val waiting: Boolean get() = waitingSince > 0L
}

/**
 * The rules of buying Pro, free of Android types so they are unit tested on the JVM.
 *
 * The purchase is a hosted Razorpay page: the app asks the account service for its address, opens it in the
 * browser, then polls the account until the service has seen the payment and switched Pro on. The service
 * records nothing when a payment page is created, only when the payment is confirmed, so the app is careful
 * not to offer a second payment while the first may still be on its way.
 */
object ProUpgrade {
    /** How often the account is checked while a payment is being waited for. */
    const val POLL_MILLIS = 10_000L
    /** How long to wait for a payment to show up before saying so. */
    const val WAIT_LIMIT_MILLIS = 20 * 60_000L
    private const val MAX_URL_LENGTH = 2048

    const val WAIT_TIMED_OUT = "We haven't seen the payment yet. If you paid, don't pay again: it can take a few minutes to show up here."
    const val WAIT_STOPPED = "Stopped waiting. If you paid, Pro still switches on here by itself, so don't pay again."
    const val ALREADY_SUBSCRIBED = "This account already has a subscription that isn't active yet. If you just paid, it can take a few " +
        "minutes. Otherwise manage it in Plans & billing in the Voxden desktop app."

    /** Whether a payment started at [since] is still worth waiting for at [now]. */
    fun stillWaiting(since: Long, now: Long): Boolean = since > 0L && now >= since && now - since < WAIT_LIMIT_MILLIS

    /**
     * The payment page must be a plain `https` address: a real host, no user name in front of it, no spaces,
     * and not absurdly long. Anything else is not opened.
     */
    fun isSecureUrl(url: String): Boolean {
        if (url.length > MAX_URL_LENGTH || !url.startsWith("https://") || url.any { it.isWhitespace() }) return false
        val parsed = try { URI(url) } catch (_: Exception) { return false }
        return parsed.scheme == "https" && !parsed.host.isNullOrBlank() && parsed.userInfo == null
    }

    /** The message for a failed checkout call, from the service's error [code] when it sent one. */
    fun checkoutError(code: String?, serviceMessage: String): String = when (code) {
        "country" -> "Voxden Pro isn't sold in your country yet."
        "region" -> "That plan isn't offered in your region."
        "unconfigured" -> "Payments aren't open yet. Please try again soon."
        "subscription" -> ALREADY_SUBSCRIBED
        "provider" -> "The payment provider isn't answering. Try again in a minute."
        else -> serviceMessage
    }

    /** `₹349 / month · up to 15 h of Voxden Cloud a month`, or just the price when the hours are not known. */
    fun offerLine(offer: ProOffer): String =
        if (offer.cloudHours > 0) "${offer.label} · up to ${offer.cloudHours} h of Voxden Cloud a month" else offer.label
}
