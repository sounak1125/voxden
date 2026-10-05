package com.voxden.android.core

/**
 * The part of the writing style the app calls on every dictation. It is deliberately small: [WritingStyle] holds the
 * rules and builds about 2,000 words of lists the first time anything in it is touched, which must not happen for
 * someone who has the style off. Nothing here touches [WritingStyle] until the style is on and a dictation is styled.
 */
object DictationStyle {
    /**
     * Whether the style applies to dictation in [language] (a BCP-47 tag such as "en-US", "en" or "hi-IN"): English
     * only, as on the desktop, which accepts "en" and "en-" followed by anything, in any letter case.
     */
    fun appliesTo(language: String): Boolean {
        if (language.length < 2) return false
        if (language[0] != 'e' && language[0] != 'E') return false
        if (language[1] != 'n' && language[1] != 'N') return false
        return language.length == 2 || language[2] == '-'
    }

    /**
     * The text of a dictation as it is delivered: [spoken] as it came with the style off, or written in the tone chosen
     * for the kind of app it is going into ([packageName], which is null when the app is not known: the voice keyboard
     * and Voxden's own Dictate bar, both of which use Other). The words in [dictionary] keep their spelling.
     * Fails open: if the rules ever throw, the dictation is delivered as it came rather than lost.
     */
    fun forDictation(
        spoken: String,
        settings: WritingStyleSettings,
        packageName: String?,
        language: String,
        dictionary: List<String>
    ): String {
        if (!settings.enabled) return spoken
        return try {
            WritingStyle.apply(spoken, settings.toneFor(WritingContexts.classify(packageName)), language, dictionary)
        } catch (e: Exception) {
            spoken
        } catch (e: StackOverflowError) {
            spoken
        }
    }

    /**
     * Whether styling [spoken] into [styled] left nothing worth delivering: nothing at all, or only punctuation
     * where there were words. The desktop keeps the stop behind a filler it removes, so a dictation of just "Um."
     * comes back as ".", which would be typed into the field as a stray full stop. Text that was only punctuation or
     * an emoji to begin with is not emptied by the style, so it is delivered as it came. With the style off the two
     * strings are the same, so this is exactly "is it blank".
     */
    fun leavesNothing(spoken: String, styled: String): Boolean =
        styled.isBlank() || (styled.none { it.isLetterOrDigit() } && spoken.any { it.isLetterOrDigit() })
}
