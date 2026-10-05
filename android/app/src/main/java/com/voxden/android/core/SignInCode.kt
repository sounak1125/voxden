package com.voxden.android.core

import org.json.JSONObject

/**
 * The "enter the code we emailed you" step outlives the app being closed. Copying the code means leaving Voxden for
 * the mail app, and Android may clear a background app while the user is away; without this they came back to the
 * email box, and the code they had just copied was no longer the one to enter.
 *
 * The account service accepts a code for 10 minutes. The step is offered again for a little less than that, so
 * it never asks for a code the service has already dropped.
 */
object SignInCode {
    const val STEP_MILLIS = 9 * 60_000L

    /** Where a code went and when it was sent. */
    data class Pending(val email: String, val sentAt: Long)

    /** Whether a code sent at [sentAt] is still worth asking for at [now]. A clock set back counts as expired. */
    fun stillOpen(sentAt: Long, now: Long): Boolean = sentAt > 0L && now >= sentAt && now - sentAt < STEP_MILLIS

    /**
     * The code step saved in [saved] (the app's saved data), or null when there is none worth showing: it was too long
     * ago, it is damaged, or the phone is signed in already.
     */
    fun restore(saved: JSONObject, now: Long): Pending? {
        if (saved.optJSONObject("account") != null) return null
        val entry = saved.optJSONObject("pendingCode") ?: return null
        val email = entry.optString("email").trim().takeUnless { it.isEmpty() || it == "null" } ?: return null
        val sentAt = entry.optLong("sentAt", 0L)
        return if (stillOpen(sentAt, now)) Pending(email, sentAt) else null
    }
}
