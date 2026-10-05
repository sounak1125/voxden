package com.voxden.android.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** How the writing style setting comes back from saved data (SecureStore writes it as `writingStyle`). */
class WritingStyleSettingsTest {
    private fun restore(text: String) = AppController.restoreState(JSONObject(text)).writingStyle

    @Test fun theDefaultsAreTheDesktopsTonesAndTheStyleIsOff() {
        val style = WritingStyleSettings()
        assertFalse(style.enabled)
        assertEquals(WritingTone.VERY_CASUAL, style.toneFor(WritingContext.PERSONAL))
        assertEquals(WritingTone.CASUAL, style.toneFor(WritingContext.WORK))
        assertEquals(WritingTone.FORMAL, style.toneFor(WritingContext.EMAIL))
        assertEquals(WritingTone.CASUAL, style.toneFor(WritingContext.OTHER))
    }

    @Test fun changingOneContextLeavesTheOthersAlone() {
        val style = WritingStyleSettings().withTone(WritingContext.WORK, WritingTone.FORMAL)
        assertEquals(WritingTone.FORMAL, style.toneFor(WritingContext.WORK))
        assertEquals(WritingTone.VERY_CASUAL, style.toneFor(WritingContext.PERSONAL))
        assertEquals(WritingTone.FORMAL, style.toneFor(WritingContext.EMAIL))
        assertEquals(WritingTone.CASUAL, style.toneFor(WritingContext.OTHER))
        for (context in WritingContext.values()) {
            assertEquals(WritingTone.VERY_CASUAL, WritingStyleSettings().withTone(context, WritingTone.VERY_CASUAL).toneFor(context))
        }
    }

    @Test fun anInstallFromBeforeTheStyleExistedHasItOff() {
        assertEquals(WritingStyleSettings(), restore("""{"language":"en-US","saveHistory":true}"""))
    }

    @Test fun nothingSavedAtAllHasItOff() {
        assertEquals(WritingStyleSettings(), restore("{}"))
    }

    @Test fun aSavedChoiceComesBack() {
        val saved = """{"writingStyle":{"enabled":true,"personal":"FORMAL","work":"VERY_CASUAL","email":"CASUAL","other":"FORMAL"}}"""
        assertEquals(WritingStyleSettings(true, WritingTone.FORMAL, WritingTone.VERY_CASUAL, WritingTone.CASUAL, WritingTone.FORMAL), restore(saved))
    }

    @Test fun anUnknownToneKeepsThatContextsDefaultAndSpoilsNothingElse() {
        val style = restore("""{"writingStyle":{"enabled":true,"personal":"shouty","work":"FORMAL","email":"","other":42}}""")
        assertTrue(style.enabled)
        assertEquals("unknown value", WritingTone.VERY_CASUAL, style.personal)
        assertEquals("valid value", WritingTone.FORMAL, style.work)
        assertEquals("empty value", WritingTone.FORMAL, style.email)
        assertEquals("wrong type", WritingTone.CASUAL, style.other)
    }

    @Test fun aMissingContextKeepsItsDefault() {
        val style = restore("""{"writingStyle":{"enabled":true,"email":"VERY_CASUAL"}}""")
        assertEquals(WritingTone.VERY_CASUAL, style.email)
        assertEquals(WritingTone.VERY_CASUAL, style.personal)
        assertEquals(WritingTone.CASUAL, style.work)
        assertEquals(WritingTone.CASUAL, style.other)
    }

    @Test fun aDamagedEntryDoesNotTurnTheStyleOn() {
        assertEquals(WritingStyleSettings(), restore("""{"writingStyle":"on"}"""))
        assertEquals(WritingStyleSettings(), restore("""{"writingStyle":{"enabled":"maybe"}}"""))
    }

    @Test fun theOtherSettingsAreUntouchedByTheStyle() {
        val state = AppController.restoreState(JSONObject("""{"language":"hi-IN","saveHistory":false,"writingStyle":{"enabled":true,"email":"CASUAL"}}"""))
        assertEquals("hi-IN", state.language)
        assertFalse(state.saveHistory)
        assertTrue(state.writingStyle.enabled)
        assertEquals(WritingTone.CASUAL, state.writingStyle.email)
    }
}

class WritingContextsTest {
    @Test fun chatAppsArePersonal() {
        for (app in listOf("com.whatsapp", "org.telegram.messenger", "com.discord", "org.thoughtcrime.securesms", "com.google.android.apps.messaging")) {
            assertEquals(app, WritingContext.PERSONAL, WritingContexts.classify(app))
        }
    }

    @Test fun workToolsAreWork() {
        for (app in listOf("com.Slack", "com.microsoft.teams", "us.zoom.videomeetings", "com.google.android.apps.dynamite")) {
            assertEquals(app, WritingContext.WORK, WritingContexts.classify(app))
        }
    }

    @Test fun mailAppsAreEmail() {
        for (app in listOf("com.google.android.gm", "com.microsoft.office.outlook", "ch.protonmail.android", "com.fsck.k9")) {
            assertEquals(app, WritingContext.EMAIL, WritingContexts.classify(app))
        }
    }

    @Test fun anythingElseOrUnknownIsOther() {
        assertEquals(WritingContext.OTHER, WritingContexts.classify(null))
        assertEquals(WritingContext.OTHER, WritingContexts.classify(""))
        assertEquals(WritingContext.OTHER, WritingContexts.classify("com.android.chrome"))
        assertEquals(WritingContext.OTHER, WritingContexts.classify("com.voxden.android.beta"))
    }

    @Test fun matchingIgnoresCaseAndSpacesButNeedsTheWholeName() {
        assertEquals(WritingContext.PERSONAL, WritingContexts.classify("  COM.WhatsApp "))
        assertEquals("a prefix is not the app", WritingContext.OTHER, WritingContexts.classify("com.whatsapp.fake.clone"))
        assertEquals("a suffix is not the app", WritingContext.OTHER, WritingContexts.classify("evil.com.whatsapp"))
    }

    @Test fun everyListedAppIsInExactlyOneContext() {
        // classify checks email, then work, then personal: a name in two lists would silently take the first.
        assertEquals(emptySet<String>(), WritingContexts.personal intersect WritingContexts.work)
        assertEquals(emptySet<String>(), WritingContexts.personal intersect WritingContexts.email)
        assertEquals(emptySet<String>(), WritingContexts.work intersect WritingContexts.email)
        // The lists are matched against a lower-cased name, so an entry with a capital could never match.
        for (name in WritingContexts.personal + WritingContexts.work + WritingContexts.email) {
            assertEquals(name, name.lowercase(), name)
            assertEquals(name, name.trim(), name)
        }
        for (name in WritingContexts.personal) assertEquals(name, WritingContext.PERSONAL, WritingContexts.classify(name))
        for (name in WritingContexts.work) assertEquals(name, WritingContext.WORK, WritingContexts.classify(name))
        for (name in WritingContexts.email) assertEquals(name, WritingContext.EMAIL, WritingContexts.classify(name))
    }

    @Test fun browsersAreOther() {
        for (browser in listOf("com.android.chrome", "org.mozilla.firefox", "com.sec.android.app.sbrowser", "com.microsoft.emmx", "com.brave.browser")) {
            assertEquals(browser, WritingContext.OTHER, WritingContexts.classify(browser))
        }
    }

    @Test fun spotChecks() {
        val samples = listOf(
            "com.whatsapp", "com.slack", "com.google.android.gm", "com.microsoft.teams", "com.linkedin.android",
            "com.google.android.apps.dynamite", "com.google.android.apps.meetings", "com.google.android.apps.messaging"
        )
        val expected = listOf(
            WritingContext.PERSONAL, WritingContext.WORK, WritingContext.EMAIL, WritingContext.WORK, WritingContext.WORK,
            WritingContext.WORK, WritingContext.WORK, WritingContext.PERSONAL
        )
        for ((app, context) in samples.zip(expected)) assertEquals(app, context, WritingContexts.classify(app))
    }
}
