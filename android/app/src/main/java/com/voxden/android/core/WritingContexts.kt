package com.voxden.android.core

/**
 * Decides which writing context a dictation belongs to from the app it is typed into, so the writing style can be
 * casual in WhatsApp and formal in Gmail. The desktop app does the same from the program's name (and, for browsers,
 * the page title); Android has the package name only, so this is a table of well-known apps. Anything not listed,
 * and any dictation whose app is not known (the voice keyboard, Voxden's own Dictate bar), is [WritingContext.OTHER].
 *
 * Package names are matched whole and ignoring case (the lists are lower case). A listed name that is wrong only
 * means that app is treated as Other, which is the safe default. Browsers are Other too: the desktop looks at the page
 * title to tell Gmail from a news site, and Android has no title to look at.
 */
object WritingContexts {
    internal val personal = setOf(
        "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "org.telegram.messenger.web", "com.discord",
        "org.thoughtcrime.securesms", "com.instagram.android", "com.instagram.lite", "com.instagram.barcelona",
        "com.facebook.orca", "com.facebook.katana", "com.facebook.lite", "com.facebook.mlite", "com.snapchat.android",
        "com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms", "com.android.messaging",
        "com.reddit.frontpage", "com.viber.voip", "jp.naver.line.android", "com.tencent.mm", "com.skype.raider",
        "com.twitter.android", "com.zhiliaoapp.musically", "org.thunderdog.challegram", "com.kakao.talk", "com.imo.android.imoim"
    )
    internal val work = setOf(
        "com.slack", "com.microsoft.teams", "us.zoom.videomeetings", "com.google.android.apps.meetings",
        "com.google.android.apps.tachyon", "com.google.android.apps.dynamite", "com.notion.id", "notion.id",
        "com.linkedin.android", "com.atlassian.android.jira.core", "com.asana.app", "com.cisco.webex.meetings",
        "com.trello", "com.figma.mirror", "com.mattermost.rn", "com.monday.monday"
    )
    internal val email = setOf(
        "com.google.android.gm", "com.google.android.gm.lite", "com.microsoft.office.outlook", "com.microsoft.outlooklite",
        "com.yahoo.mobile.client.android.mail", "ch.protonmail.android", "com.fsck.k9", "net.thunderbird.android",
        "com.samsung.android.email.provider", "com.android.email", "eu.faircode.email", "me.bluemail.mail", "com.my.mail",
        "com.readdle.spark", "com.zoho.mail", "de.tutao.tutanota", "ru.mail.mailapp"
    )

    fun classify(packageName: String?): WritingContext {
        val name = packageName?.trim()?.lowercase() ?: return WritingContext.OTHER
        return when (name) {
            in email -> WritingContext.EMAIL
            in work -> WritingContext.WORK
            in personal -> WritingContext.PERSONAL
            else -> WritingContext.OTHER
        }
    }
}
