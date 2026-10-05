package com.voxden.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The writing style against the desktop's. Every expected string in the parity tests was produced by running
 * `applyStyleWithTone` from src/style.js (Node) on the input, once per tone, and pasted here; none was typed by hand.
 * The other tests are the guarantees the Android side relies on: English only, always trimmed, idempotent, dictionary
 * terms untouched, and no input that throws or takes long.
 */
class WritingStyleTest {
    /** One input and what the desktop gives for it in each tone. */
    private class Vector(
        val input: String,
        val formal: String,
        val casual: String,
        val veryCasual: String,
        val terms: List<String> = emptyList()
    )

    private fun same(input: String, output: String, terms: List<String> = emptyList()) =
        Vector(input, output, output, output, terms)

    private fun expectedFor(vector: Vector, tone: WritingTone): String = when (tone) {
        WritingTone.FORMAL -> vector.formal
        WritingTone.CASUAL -> vector.casual
        WritingTone.VERY_CASUAL -> vector.veryCasual
    }

    private fun check(vectors: List<Vector>) {
        for (vector in vectors) {
            for (tone in WritingTone.entries) {
                assertEquals(
                    "$tone: \"${vector.input}\"",
                    expectedFor(vector, tone),
                    WritingStyle.apply(vector.input, tone, "en-US", vector.terms)
                )
            }
        }
    }

    private fun assertTrimmed(message: String, text: String) {
        assertEquals(message, text.trim(), text)
        // Kotlin's trim leaves a byte order mark, JavaScript's does not; neither may be at an edge.
        assertFalse(message, text.startsWith("\uFEFF") || text.endsWith("\uFEFF"))
    }

    private fun millis(block: () -> Unit): Long {
        val start = System.nanoTime()
        block()
        return (System.nanoTime() - start) / 1_000_000
    }

    // -- Parity with the desktop --------------------------------------------------------------------------------

    /** The desktop test suite: styleCases and the first toneExamples. */
    private val desktopStyleCases = listOf(
        Vector(
            "Hey yeah I do not wanna go",
            "Hey yeah I do not wanna go.",
            "Hey yeah I do not wanna go",
            "hey yeah I do not wanna go"
        ),
        Vector("Hello there.", "Hello there.", "Hello there.", "hello there"),
        Vector(
            "Hello, I am going to send the notes when we are done. Thank you.",
            "Hello, I am going to send the notes when we are done. Thank you.",
            "Hello, I am going to send the notes when we are done. Thank you.",
            "hello, I am going to send the notes when we are done. thank you"
        ),
    )

    /** The desktop test suite: toneExamples (scripts/test-style.js). */
    private val desktopToneExamples = listOf(
        Vector(
            "Could you please send the notes when you are ready?",
            "Could you please send the notes when you are ready?",
            "Could you please send the notes when you are ready?",
            "could you please send the notes when you are ready?"
        ),
        Vector(
            "um, so I am sending the notes tonight, you know, once we are done. thanks for waiting",
            "So I am sending the notes tonight once we are done. Thanks for waiting.",
            "So I am sending the notes tonight once we are done. Thanks for waiting",
            "so I am sending the notes tonight once we are done. thanks for waiting"
        ),
        Vector(
            "Please let me know if you want to join. I cannot stay.",
            "Please let me know if you want to join. I cannot stay.",
            "Please let me know if you want to join. I cannot stay.",
            "please let me know if you want to join. I cannot stay"
        ),
        Vector(
            "Hey, I\u2019m gonna call Alex on Monday. Thanks!",
            "Hey, I\u2019m gonna call Alex on Monday. Thanks!",
            "Hey, I\u2019m gonna call Alex on Monday. Thanks!",
            "hey, I\u2019m gonna call Alex on Monday. thanks!"
        ),
    )

    /** The desktop test suite: pipelineCases, here given to applyStyleWithTone directly (no cleanup step first). */
    private val desktopFillerCases = listOf(
        Vector(
            "um you know I think we should go",
            "You know I think we should go.",
            "You know I think we should go",
            "you know I think we should go"
        ),
        Vector(
            "um, you know, I think we should go",
            "I think we should go.",
            "I think we should go",
            "I think we should go"
        ),
        Vector(
            "I was, you know, thinking we should leave",
            "I was thinking we should leave.",
            "I was thinking we should leave",
            "I was thinking we should leave"
        ),
        Vector("Um, I think we should go", "I think we should go.", "I think we should go", "I think we should go"),
        Vector("UM hey there.", "UM hey there.", "UM hey there.", "UM hey there"),
        Vector("um, you know, I don't wanna go", "I don't wanna go.", "I don't wanna go", "I don't wanna go"),
        Vector(
            "Do you know the answer?",
            "Do you know the answer?",
            "Do you know the answer?",
            "do you know the answer?"
        ),
        Vector("I like this design.", "I like this design.", "I like this design.", "I like this design"),
        Vector(
            "What kind of music do you like?",
            "What kind of music do you like?",
            "What kind of music do you like?",
            "what kind of music do you like?"
        ),
        Vector("It was, like, huge.", "It was, like, huge.", "It was, like, huge.", "it was, like, huge"),
        Vector(
            "We should, I mean, probably leave",
            "We should, I mean, probably leave.",
            "We should, I mean, probably leave",
            "we should, I mean, probably leave"
        ),
        Vector(
            "this thing, I mean, like, can you help",
            "This thing, I mean, like, can you help.",
            "This thing, I mean, like, can you help",
            "this thing, I mean, like, can you help"
        ),
        Vector(
            "we are, you know, like, thinking",
            "We are, like, thinking.",
            "We are, like, thinking",
            "we are, like, thinking"
        ),
        Vector(
            "So, I was thinking we should go.",
            "So, I was thinking we should go.",
            "So, I was thinking we should go.",
            "so, I was thinking we should go"
        ),
        Vector(
            "So far, I am enjoying this.",
            "So far, I am enjoying this.",
            "So far, I am enjoying this.",
            "so far, I am enjoying this"
        ),
        Vector(
            "So long as it holds, we are fine.",
            "So long as it holds, we are fine.",
            "So long as it holds, we are fine.",
            "so long as it holds, we are fine"
        ),
        Vector(
            "um yeah hello hello world",
            "Yeah hello hello world.",
            "Yeah hello hello world",
            "yeah hello hello world"
        ),
        Vector(
            "yeah yeah yeah I am going",
            "Yeah yeah yeah I am going.",
            "Yeah yeah yeah I am going",
            "yeah yeah yeah I am going"
        ),
        Vector(
            "I went to the ER last night.",
            "I went to the ER last night.",
            "I went to the ER last night.",
            "I went to the ER last night"
        ),
        Vector("To err is human.", "To err is human.", "To err is human.", "to err is human"),
        Vector(
            "Did you get it? Uh-huh.",
            "Did you get it? Uh-huh.",
            "Did you get it? Uh-huh.",
            "did you get it? Uh-huh"
        ),
        Vector(
            "It should be, you know, Add a section here.",
            "It should be add a section here.",
            "It should be add a section here.",
            "it should be add a section here"
        ),
        Vector(
            "I need to again, uh... Add some credit.",
            "I need to again add some credit.",
            "I need to again add some credit.",
            "I need to again add some credit"
        ),
        Vector(
            "also Let's update the github",
            "Also let's update the github.",
            "Also let's update the github",
            "also let's update the github"
        ),
        Vector(
            "turn on Do Not Disturb now",
            "Turn on Do Not Disturb now.",
            "Turn on Do Not Disturb now",
            "turn on Do Not Disturb now"
        ),
        Vector(
            "Let us meet at 3 p.m. tomorrow.",
            "Let us meet at 3 p.m. tomorrow.",
            "Let us meet at 3 p.m. tomorrow.",
            "let us meet at 3 p.m. tomorrow"
        ),
        Vector(
            "a soft smile. and a natural look.",
            "A soft smile. And a natural look.",
            "A soft smile. And a natural look.",
            "a soft smile. and a natural look"
        ),
    )

    /** The desktop test suite: the assertions at the end of scripts/test-style.js. */
    private val desktopToneAsserts = listOf(
        Vector(
            "Analyze it. Moving on. Alex said yes. Will you check? Will is here. NASA called. Users are here.",
            "Analyze it. Moving on. Alex said yes. Will you check? Will is here. NASA called. Users are here.",
            "Analyze it. Moving on. Alex said yes. Will you check? Will is here. NASA called. Users are here.",
            "analyze it. moving on. Alex said yes. will you check? Will is here. NASA called. users are here"
        ),
        Vector(
            "Alex uses iPhone and NASA on Monday. Visit https://Example.com/Case?Id=2 or Test@Example.com, version 1.0.16. Say \"I am gonna go\" or `I am ready`. Open C:\\Users\\Alex\\Notes.txt",
            "Alex uses iPhone and NASA on Monday. Visit https://Example.com/Case?Id=2 or Test@Example.com, version 1.0.16. Say \"I am gonna go\" or `I am ready`. Open C:\\Users\\Alex\\Notes.txt",
            "Alex uses iPhone and NASA on Monday. Visit https://Example.com/Case?Id=2 or Test@Example.com, version 1.0.16. Say \"I am gonna go\" or `I am ready`. Open C:\\Users\\Alex\\Notes.txt",
            "Alex uses iPhone and NASA on Monday. visit https://Example.com/Case?Id=2 or Test@Example.com, version 1.0.16. say \"I am gonna go\" or `I am ready`. open C:\\Users\\Alex\\Notes.txt"
        ),
        Vector(
            "Hello from He Is We and Hi Team.",
            "Hello from He Is We and Hi Team.",
            "Hello from He Is We and Hi Team.",
            "hello from He Is We and Hi Team",
            terms = listOf("He Is We", "Hi Team")
        ),
        Vector(
            "First line.\n\nSecond line?",
            "First line.\n\nSecond line?",
            "First line.\n\nSecond line?",
            "first line\n\nsecond line?"
        ),
        Vector("I'd already finished.", "I'd already finished.", "I'd already finished.", "I'd already finished"),
        Vector("It's been a long day.", "It's been a long day.", "It's been a long day.", "it's been a long day"),
        Vector(
            "I like this kind of music.",
            "I like this kind of music.",
            "I like this kind of music.",
            "I like this kind of music"
        ),
        Vector(
            "Thanks to Alex, we finished.",
            "Thanks to Alex, we finished.",
            "Thanks to Alex, we finished.",
            "thanks to Alex, we finished"
        ),
        Vector("Really?!", "Really?!", "Really?!", "really?!"),
        Vector("Wait...", "Wait...", "Wait...", "wait..."),
        Vector("I am going to London.", "I am going to London.", "I am going to London.", "I am going to London"),
        Vector("I am going to work.", "I am going to work.", "I am going to work.", "I am going to work"),
        Vector("iPhone is here.", "iPhone is here.", "iPhone is here.", "iPhone is here"),
        Vector("eBay is here.", "eBay is here.", "eBay is here.", "eBay is here"),
        Vector("Will is here.", "Will is here.", "Will is here.", "Will is here"),
        Vector("NASA is here.", "NASA is here.", "NASA is here.", "NASA is here"),
        Vector(
            "I am. You are too. That is where we are.",
            "I am. You are too. That is where we are.",
            "I am. You are too. That is where we are.",
            "I am. you are too. that is where we are"
        ),
        Vector(
            "I have a car. Let us through.",
            "I have a car. Let us through.",
            "I have a car. Let us through.",
            "I have a car. let us through"
        ),
        Vector(
            "Can you swim? I asked if you could send it.",
            "Can you swim? I asked if you could send it.",
            "Can you swim? I asked if you could send it.",
            "can you swim? I asked if you could send it"
        ),
        Vector(
            "Bill's here. O'Reilly won't join. He'll call.",
            "Bill's here. O'Reilly won't join. He'll call.",
            "Bill's here. O'Reilly won't join. He'll call.",
            "Bill's here. O'Reilly won't join. he'll call"
        ),
        Vector("Thanks", "Thanks.", "Thanks", "thanks"),
        Vector("Hello World.", "Hello World.", "Hello World.", "hello World"),
    )

    private val fillers = listOf(
        Vector("uh, hello there", "Hello there.", "Hello there", "hello there"),
        Vector("so um yeah that works", "So yeah that works.", "So yeah that works", "so yeah that works"),
        same("Um, uh, hmm", ""),
        Vector(
            "hmm... let me think about it",
            "Let me think about it.",
            "Let me think about it",
            "let me think about it"
        ),
        Vector("uhh umm hm okay", "Okay.", "Okay", "okay"),
        Vector(
            "it was like really good",
            "It was like really good.",
            "It was like really good",
            "it was like really good"
        ),
        Vector("I, like, do not know", "I, like, do not know.", "I, like, do not know", "I, like, do not know"),
        Vector("you know what I mean", "You know what I mean.", "You know what I mean", "you know what I mean"),
        Vector("well, you know, it works", "Well it works.", "Well it works", "well it works"),
        Vector(
            "we went there, uh, yesterday, um, and left",
            "We went there yesterday and left.",
            "We went there yesterday and left",
            "we went there yesterday and left"
        ),
        Vector(
            "uh-huh and mm-hmm are answers",
            "Uh-huh and mm-hmm are answers.",
            "Uh-huh and mm-hmm are answers",
            "uh-huh and mm-hmm are answers"
        ),
        Vector(
            "he hummed a tune and the hum went on",
            "He hummed a tune and the hum went on.",
            "He hummed a tune and the hum went on",
            "he hummed a tune and the hum went on"
        ),
        Vector("I was thinking, um...", "I was thinking.", "I was thinking", "I was thinking"),
        Vector(
            "ok, so, um, the plan is simple",
            "Ok, so the plan is simple.",
            "Ok, so the plan is simple",
            "ok, so the plan is simple"
        ),
    )

    private val dashesAndSemicolons = listOf(
        Vector("I was - um - thinking", "I was thinking.", "I was thinking", "I was thinking"),
        Vector("okay \u2013 uh \u2013 sure", "Okay sure.", "Okay sure", "okay sure"),
        Vector("yes \u2014 you know \u2014 maybe", "Yes maybe.", "Yes maybe", "yes maybe"),
        Vector("um - okay then", "Okay then.", "Okay then", "okay then"),
        Vector("so - uh - yeah", "So yeah.", "So yeah", "so yeah"),
        Vector("fine; um; ok", "Fine ok.", "Fine ok", "fine ok"),
        Vector("well: uh: then", "Well then.", "Well then", "well then"),
        Vector("a - b", "A - b.", "A - b", "a - b"),
        Vector("um-um okay", "Um-um okay.", "Um-um okay", "um-um okay"),
        Vector("x -um- y", "X -um- y.", "X -um- y", "x -um- y"),
        Vector("right -- uh -- okay", "Right - - okay.", "Right - - okay", "right - - okay"),
    )

    /** A filler that was followed by its own stop leaves the stop behind, on the desktop too. */
    private val strayStops = listOf(
        same("Um.", "."),
        same("uh?", "?"),
        same("hmm!", "!"),
        same("uh... hmm.", "."),
        Vector("Um, okay.", "Okay.", "Okay.", "okay"),
    )

    private val pronounI = listOf(
        Vector(
            "i think i am here and i will go",
            "I think I am here and I will go.",
            "I think I am here and I will go",
            "I think I am here and I will go"
        ),
        Vector(
            "i'm sure i'll do it and i'd like that",
            "I'm sure I'll do it and I'd like that.",
            "I'm sure I'll do it and I'd like that",
            "I'm sure I'll do it and I'd like that"
        ),
        Vector(
            "i.e. maybe, e.g. later",
            "I.e. maybe, e.g. later.",
            "I.e. maybe, e.g. later",
            "i.e. maybe, e.g. later"
        ),
        Vector("he said i should go", "He said I should go.", "He said I should go", "he said I should go"),
        Vector("i", "I.", "I", "I"),
        Vector(
            "my iPhone is new and the i-phone is old",
            "My iPhone is new and the i-phone is old.",
            "My iPhone is new and the i-phone is old",
            "my iPhone is new and the i-phone is old"
        ),
        Vector(
            "alice and i are friends",
            "Alice and I are friends.",
            "Alice and I are friends",
            "alice and I are friends"
        ),
    )

    private val spacing = listOf(
        Vector("  hello  ", "Hello.", "Hello", "hello"),
        Vector("\thello\tworld\t", "Hello world.", "Hello world", "hello world"),
        Vector("hello     world", "Hello world.", "Hello world", "hello world"),
        Vector(" hello \n world ", "Hello\nWorld.", "Hello\nWorld", "hello\nworld"),
        Vector("\n\nhello\n\n", "Hello.", "Hello", "hello"),
        Vector(
            "line one  \n   line two\t\n\nline three",
            "Line one\nLine two\n\nLine three.",
            "Line one\nLine two\n\nLine three",
            "line one\nline two\n\nline three"
        ),
        Vector("hello\u00A0world", "Hello\u00A0world.", "Hello\u00A0world", "hello\u00A0world"),
    )

    private val punctuation = listOf(
        Vector("Hello, world!", "Hello, world!", "Hello, world!", "hello, world!"),
        Vector("wait... what", "Wait... what.", "Wait... what", "wait... what"),
        Vector("what?! really", "What?! Really.", "What?! Really", "what?! really"),
        Vector("(see the note) and go", "(see the note) and go.", "(see the note) and go", "(see the note) and go"),
        Vector("a; b: c", "A; b: c.", "A; b: c", "a; b: c"),
        Vector("done .", "Done.", "Done.", "done"),
        Vector("ok , fine", "Ok, fine.", "Ok, fine", "ok, fine"),
        Vector("yes ,, no", "Yes, no.", "Yes, no", "yes, no"),
        Vector(", leading comma", "Leading comma.", "Leading comma", "leading comma"),
        Vector("trailing comma,", "Trailing comma,", "Trailing comma,", "trailing comma,"),
        Vector("hello.world is sloppy", "hello.world is sloppy.", "hello.world is sloppy", "hello.world is sloppy"),
        Vector(
            "stop. start again. and again",
            "Stop. Start again. And again.",
            "Stop. Start again. And again",
            "stop. start again. and again"
        ),
    )

    private val questions = listOf(
        Vector("what time is it", "What time is it.", "What time is it", "what time is it"),
        Vector("what time is it?", "What time is it?", "What time is it?", "what time is it?"),
        Vector(
            "can you help? i need it",
            "Can you help? I need it.",
            "Can you help? I need it",
            "can you help? I need it"
        ),
        Vector("is it?", "Is it?", "Is it?", "is it?"),
        Vector(
            "Will you check this? Will is going.",
            "Will you check this? Will is going.",
            "Will you check this? Will is going.",
            "will you check this? Will is going"
        ),
    )

    private val capitals = listOf(
        Vector("HELLO WORLD", "HELLO WORLD.", "HELLO WORLD", "HELLO WORLD"),
        Vector("NASA is great", "NASA is great.", "NASA is great", "NASA is great"),
        Vector("I AM HERE", "I AM HERE.", "I AM HERE", "I AM HERE"),
        Vector(
            "ok. THIS IS LOUD. fine",
            "Ok. THIS IS LOUD. Fine.",
            "Ok. THIS IS LOUD. Fine",
            "ok. THIS IS LOUD. fine"
        ),
        Vector(
            "Alex and Maria met at the Eiffel Tower",
            "Alex and Maria met at the Eiffel Tower.",
            "Alex and Maria met at the Eiffel Tower",
            "Alex and Maria met at the Eiffel Tower"
        ),
        Vector(
            "eBay and iPhone and macOS",
            "eBay and iPhone and macOS.",
            "eBay and iPhone and macOS",
            "eBay and iPhone and macOS"
        ),
        Vector(
            "The Office is on. watching The Office now",
            "The Office is on. Watching The Office now.",
            "The Office is on. Watching The Office now",
            "the Office is on. watching The Office now"
        ),
    )

    private val numbers = listOf(
        Vector("call me at 3.14 sharp", "Call me at 3.14 sharp.", "Call me at 3.14 sharp", "call me at 3.14 sharp"),
        Vector(
            "I have 3 cats and 1,234.56 dollars",
            "I have 3 cats and 1,234.56 dollars.",
            "I have 3 cats and 1,234.56 dollars",
            "I have 3 cats and 1,234.56 dollars"
        ),
        Vector("version 1.0.16 is out", "Version 1.0.16 is out.", "Version 1.0.16 is out", "version 1.0.16 is out"),
        Vector("it costs 5.", "It costs 5.", "It costs 5.", "it costs 5"),
        Vector("2024", "2024.", "2024", "2024"),
        Vector("room 101, floor 2", "Room 101, floor 2.", "Room 101, floor 2", "room 101, floor 2"),
    )

    private val links = listOf(
        Vector(
            "go to https://Example.com/Case?Id=2 now",
            "Go to https://Example.com/Case?Id=2 now.",
            "Go to https://Example.com/Case?Id=2 now",
            "go to https://Example.com/Case?Id=2 now"
        ),
        Vector("see www.example.org.", "See www.example.org.", "See www.example.org.", "see www.example.org"),
        Vector(
            "visit example.com/a/b, then leave",
            "Visit example.com/a/b, then leave.",
            "Visit example.com/a/b, then leave",
            "visit example.com/a/b, then leave"
        ),
        Vector(
            "http://localhost:8080/x is up",
            "http://localhost:8080/x is up.",
            "http://localhost:8080/x is up",
            "http://localhost:8080/x is up"
        ),
        Vector(
            "mail Test@Example.com, please",
            "Mail Test@Example.com, please.",
            "Mail Test@Example.com, please",
            "mail Test@Example.com, please"
        ),
        Vector(
            "Foo.Bar@baz.co.uk is mine.",
            "Foo.Bar@baz.co.uk is mine.",
            "Foo.Bar@baz.co.uk is mine.",
            "Foo.Bar@baz.co.uk is mine"
        ),
        Vector(
            "um, mail me at a.b@c.org, you know, tonight",
            "Mail me at a.b@c.org tonight.",
            "Mail me at a.b@c.org tonight",
            "mail me at a.b@c.org tonight"
        ),
    )

    private val paths = listOf(
        Vector(
            "open C:\\Users\\Alex\\Notes.txt",
            "Open C:\\Users\\Alex\\Notes.txt",
            "Open C:\\Users\\Alex\\Notes.txt",
            "open C:\\Users\\Alex\\Notes.txt"
        ),
        Vector(
            "it is at /usr/local/bin/Tool please",
            "It is at /usr/local/bin/Tool please.",
            "It is at /usr/local/bin/Tool please",
            "it is at /usr/local/bin/Tool please"
        ),
        Vector(
            "copy \\\\server\\share\\File.txt over",
            "Copy \\\\server\\share\\File.txt over.",
            "Copy \\\\server\\share\\File.txt over",
            "copy \\\\server\\share\\File.txt over"
        ),
        Vector(
            "and/or is not a path but a joke",
            "And/or is not a path but a joke.",
            "And/or is not a path but a joke",
            "and/or is not a path but a joke"
        ),
    )

    private val mentionsAndTags = listOf(
        Vector("ping @Bob about it", "Ping @Bob about it.", "Ping @Bob about it", "ping @Bob about it"),
        Vector("hey @alice_smith, ok", "Hey @alice_smith, ok.", "Hey @alice_smith, ok", "hey @alice_smith, ok"),
        Vector(
            "use the #Launch2024 tag",
            "Use the #Launch2024 tag.",
            "Use the #Launch2024 tag",
            "use the #Launch2024 tag"
        ),
        same("#first thing @Dana", "#first thing @Dana"),
    )

    private val quotedAndCode = listOf(
        Vector(
            "he said \"I am gonna go\" and left",
            "He said \"I am gonna go\" and left.",
            "He said \"I am gonna go\" and left",
            "he said \"I am gonna go\" and left"
        ),
        Vector(
            "say \u201CHello There\u201D ok",
            "Say \u201CHello There\u201D ok.",
            "Say \u201CHello There\u201D ok",
            "say \u201CHello There\u201D ok"
        ),
        Vector(
            "it's fine and 'single quoted' text stays",
            "It's fine and 'single quoted' text stays.",
            "It's fine and 'single quoted' text stays",
            "it's fine and 'single quoted' text stays"
        ),
        Vector(
            "\u2018Quoted Here\u2019 is fine",
            "\u2018Quoted Here\u2019 is fine.",
            "\u2018Quoted Here\u2019 is fine",
            "\u2018Quoted Here\u2019 is fine"
        ),
        Vector("run `npm install` now", "Run `npm install` now.", "Run `npm install` now", "run `npm install` now"),
        same("```\ncode Block here\n```", "```\ncode Block here\n```"),
        Vector(
            "press Ctrl+Shift+A to open",
            "Press Ctrl+Shift+A to open.",
            "Press Ctrl+Shift+A to open",
            "press Ctrl+Shift+A to open"
        ),
        Vector("Alt+F4 quits", "Alt+F4 quits.", "Alt+F4 quits", "Alt+F4 quits"),
        Vector(
            "camelCase and snake_case words",
            "camelCase and snake_case words.",
            "camelCase and snake_case words",
            "camelCase and snake_case words"
        ),
        Vector("foo.bar() returns 3", "foo.bar() returns 3.", "foo.bar() returns 3", "foo.bar() returns 3"),
    )

    private val emojiAndLists = listOf(
        Vector(
            "great \uD83D\uDE00 job",
            "Great \uD83D\uDE00 job.",
            "Great \uD83D\uDE00 job",
            "great \uD83D\uDE00 job"
        ),
        Vector(
            "I love it \uD83C\uDDEE\uD83C\uDDF3 yes",
            "I love it \uD83C\uDDEE\uD83C\uDDF3 yes.",
            "I love it \uD83C\uDDEE\uD83C\uDDF3 yes",
            "I love it \uD83C\uDDEE\uD83C\uDDF3 yes"
        ),
        same("\uD83D\uDE00", "\uD83D\uDE00"),
        Vector(
            "1. first\n2. second\n3. third",
            "1. First\n2. Second\n3. Third.",
            "1. First\n2. Second\n3. Third",
            "1. first\n2. second\n3. third"
        ),
        Vector("- one\n- two", "- one\n- two.", "- one\n- two", "- one\n- two"),
        Vector(
            "first, second, and third",
            "First, second, and third.",
            "First, second, and third",
            "first, second, and third"
        ),
        Vector(
            "buy milk\nbuy eggs\nbuy bread",
            "Buy milk\nBuy eggs\nBuy bread.",
            "Buy milk\nBuy eggs\nBuy bread",
            "buy milk\nbuy eggs\nbuy bread"
        ),
        Vector(
            "Bullets:\n  * alpha\n  * beta",
            "Bullets:\n* alpha\n* beta.",
            "Bullets:\n* alpha\n* beta",
            "Bullets:\n* alpha\n* beta"
        ),
    )

    private val dictionaryTerms = listOf(
        Vector(
            "I use C++ at work",
            "I use C++ at work.",
            "I use C++ at work",
            "I use C++ at work",
            terms = listOf("C++")
        ),
        Vector("C++ is fun", "C++ is fun.", "C++ is fun", "C++ is fun", terms = listOf("C++")),
        Vector(
            "a.b(c) is odd and a.b(c) again",
            "a.b(c) is odd and a.b(c) again.",
            "a.b(c) is odd and a.b(c) again",
            "a.b(c) is odd and a.b(c) again",
            terms = listOf("a.b(c)")
        ),
        Vector(
            "hello from he is we and hi team",
            "Hello from he is we and hi team.",
            "Hello from he is we and hi team",
            "hello from he is we and hi team",
            terms = listOf("He Is We", "Hi Team")
        ),
        Vector(
            "Hello from He Is We and Hi Team.",
            "Hello from He Is We and Hi Team.",
            "Hello from He Is We and Hi Team.",
            "hello from He Is We and Hi Team",
            terms = listOf("He Is We", "Hi Team")
        ),
        same(
            "um, Alex called Maria about the iPhone",
            "Alex called Maria about the iPhone",
            terms = listOf("Alex", "iPhone", "")
        ),
        Vector(
            "nasa said hi to NASA",
            "Nasa said hi to NASA",
            "Nasa said hi to NASA",
            "nasa said hi to NASA",
            terms = listOf("NASA")
        ),
        Vector(
            "New York City and New York are different",
            "New York City and New York are different.",
            "New York City and New York are different",
            "New York City and New York are different",
            terms = listOf("New York", "New York City")
        ),
        same(
            "x+y=z and [brackets] and \$1 and ^start\$ and a|b",
            "x+y=z and [brackets] and \$1 and ^start\$ and a|b",
            terms = listOf("x+y=z", "[brackets]", "\$1", "^start\$", "a|b")
        ),
        same("Test tests Test", "Test tests Test", terms = listOf("Test")),
    )

    private val dictionaryAndEmpty = listOf(
        Vector(
            "plain text stays",
            "Plain text stays.",
            "Plain text stays",
            "plain text stays",
            terms = listOf("", " ")
        ),
        Vector("Will is a name", "Will is a name.", "Will is a name", "Will is a name", terms = listOf("Will")),
        Vector(
            "testing test_1 and Test",
            "Testing test_1 and Test",
            "Testing test_1 and Test",
            "testing test_1 and Test",
            terms = listOf("Test")
        ),
        Vector(
            "Testing 2 tests, test2 and Test2",
            "Testing 2 tests, test2 and Test2.",
            "Testing 2 tests, test2 and Test2",
            "testing 2 tests, test2 and Test2",
            terms = listOf("Test", "test")
        ),
    )

    private val caseTerms = listOf(
        Vector("iphone is here", "iphone is here.", "iphone is here", "iphone is here", terms = listOf("iphone")),
        Vector(
            "say mcdonald's is open",
            "Say mcdonald's is open.",
            "Say mcdonald's is open",
            "say mcdonald's is open",
            terms = listOf("mcdonald's")
        ),
        Vector("C++ rocks", "C++ rocks.", "C++ rocks", "C++ rocks", terms = listOf("C++")),
        Vector(
            "I like C++ a lot, you know",
            "I like C++ a lot.",
            "I like C++ a lot",
            "I like C++ a lot",
            terms = listOf("C++")
        ),
        Vector("a.b(c) is fine", "a.b(c) is fine.", "a.b(c) is fine", "a.b(c) is fine", terms = listOf("a.b(c)")),
        Vector("Hello a.b(c).", "Hello a.b(c).", "Hello a.b(c).", "hello a.b(c)", terms = listOf("a.b(c)")),
        Vector(
            "(c) counts, c counts",
            "(c) counts, c counts.",
            "(c) counts, c counts",
            "(c) counts, c counts",
            terms = listOf("(c)")
        ),
        Vector(
            "The \$HOME folder and the ^ sign",
            "The \$HOME folder and the ^ sign.",
            "The \$HOME folder and the ^ sign",
            "the \$HOME folder and the ^ sign",
            terms = listOf("\$HOME", "^")
        ),
        Vector(
            "wait... \\d+ is not a number",
            "Wait... \\d+ is not a number.",
            "Wait... \\d+ is not a number",
            "wait... \\d+ is not a number",
            terms = listOf("\\d+")
        ),
    )

    private val everyVector: List<Vector> =
        desktopStyleCases +
            desktopToneExamples +
            desktopFillerCases +
            desktopToneAsserts +
            fillers +
            dashesAndSemicolons +
            strayStops +
            pronounI +
            spacing +
            punctuation +
            questions +
            capitals +
            numbers +
            links +
            paths +
            mentionsAndTags +
            quotedAndCode +
            emojiAndLists +
            dictionaryTerms +
            dictionaryAndEmpty

    @Test fun theDesktopStyleExamplesMatch() {
        check(desktopStyleCases + desktopToneExamples + desktopToneAsserts)
    }

    @Test fun theDesktopFillerExamplesMatch() {
        check(desktopFillerCases)
    }

    @Test fun theDesktopTestExpectationsHold() {
        val cases = listOf(
            Vector(
                "Could you please send the notes when you are ready?",
                "Could you please send the notes when you are ready?",
                "Could you please send the notes when you are ready?",
                "could you please send the notes when you are ready?"
            ),
            Vector(
                "um, so I am sending the notes tonight, you know, once we are done. thanks for waiting",
                "So I am sending the notes tonight once we are done. Thanks for waiting.",
                "So I am sending the notes tonight once we are done. Thanks for waiting",
                "so I am sending the notes tonight once we are done. thanks for waiting"
            ),
            Vector(
                "Please let me know if you want to join. I cannot stay.",
                "Please let me know if you want to join. I cannot stay.",
                "Please let me know if you want to join. I cannot stay.",
                "please let me know if you want to join. I cannot stay"
            ),
            Vector(
                "Hey, I\u2019m gonna call Alex on Monday. Thanks!",
                "Hey, I\u2019m gonna call Alex on Monday. Thanks!",
                "Hey, I\u2019m gonna call Alex on Monday. Thanks!",
                "hey, I\u2019m gonna call Alex on Monday. thanks!"
            ),
            Vector(
                "Hello, I am going to send the notes when we are done. Thank you.",
                "Hello, I am going to send the notes when we are done. Thank you.",
                "Hello, I am going to send the notes when we are done. Thank you.",
                "hello, I am going to send the notes when we are done. thank you"
            ),
            Vector(
                "Analyze it. Moving on. Alex said yes. Will you check? Will is here. NASA called. Users are here.",
                "Analyze it. Moving on. Alex said yes. Will you check? Will is here. NASA called. Users are here.",
                "Analyze it. Moving on. Alex said yes. Will you check? Will is here. NASA called. Users are here.",
                "analyze it. moving on. Alex said yes. will you check? Will is here. NASA called. users are here"
            ),
        )
        check(cases)
    }

    @Test fun fillersComeOutWithTheirCommas() {
        check(fillers + dashesAndSemicolons + strayStops)
    }

    @Test fun theIPronounIsCapitalised() {
        check(pronounI)
    }

    @Test fun spacesAreTidiedAroundWordsAndLines() {
        check(spacing)
    }

    @Test fun punctuationIsKeptAsSpoken() {
        check(punctuation + questions)
    }

    @Test fun namesAndAcronymsKeepTheirCapitals() {
        check(capitals)
    }

    @Test fun numbersLinksAndAddressesAreLeftAlone() {
        check(numbers + links)
    }

    @Test fun pathsMentionsTagsQuotesAndCodeAreLeftAlone() {
        check(paths + mentionsAndTags + quotedAndCode)
    }

    @Test fun emojiAndListsKeepTheirShape() {
        check(emojiAndLists)
    }

    @Test fun dictionaryTermsKeepTheirSpelling() {
        check(dictionaryTerms + dictionaryAndEmpty + caseTerms)
    }

    @Test fun aLongDictationReadsTheSameAsItsParts() {
        // The desktop styles this sentence 1200 times over (a 100,000 character dictation) to the sentence's own
        // result, one after another, so the expected text is the one-sentence result repeated.
        val unit = "Um, so I am sending the notes tonight, you know, once we are done. thanks for waiting. "
        val count = 1200
        val text = unit.repeat(count)
        assertTrue("the dictation is at least 100,000 characters", text.length >= 100_000)
        val formal = "So I am sending the notes tonight once we are done. Thanks for waiting."
        val casual = "So I am sending the notes tonight once we are done. Thanks for waiting."
        val veryCasual = "so I am sending the notes tonight once we are done. thanks for waiting"
        var result = ""
        val took = millis { result = WritingStyle.apply(text, WritingTone.FORMAL) }
        assertEquals("formal", (formal + " ").repeat(count - 1) + formal, result)
        assertTrue("formal took $took ms", took < 2000)
        assertEquals(
            "casual",
            (casual + " ").repeat(count - 1) + casual,
            WritingStyle.apply(text, WritingTone.CASUAL)
        )
        assertEquals(
            "very casual",
            (veryCasual + ". ").repeat(count - 1) + veryCasual,
            WritingStyle.apply(text, WritingTone.VERY_CASUAL)
        )
    }

    // -- Language -----------------------------------------------------------------------------------------------

    @Test fun onlyEnglishTagsApplyTheStyle() {
        for (tag in listOf("en", "en-US", "en-IN", "en-GB", "EN-us", "EN", "En-gb")) {
            assertTrue(tag, WritingStyle.appliesTo(tag))
            val spoken = "um, hello there"
            assertEquals("$tag formal", "Hello there.", WritingStyle.apply(spoken, WritingTone.FORMAL, tag))
            assertEquals("$tag casual", "Hello there", WritingStyle.apply(spoken, WritingTone.CASUAL, tag))
            assertEquals("$tag very casual", "hello there", WritingStyle.apply(spoken, WritingTone.VERY_CASUAL, tag))
        }
        val others = listOf("hi-IN", "ja-JP", "zh-CN", "ko-KR", "ar-SA", "fr-FR", "de", "pt-BR", "", "e", "english", "enx")
        for (tag in others) {
            assertFalse(tag, WritingStyle.appliesTo(tag))
        }
    }

    @Test fun theDefaultLanguageIsEnglish() {
        assertEquals("default", "Hello there.", WritingStyle.apply("um, hello there", WritingTone.FORMAL))
    }

    private class Plain(val language: String, val input: String, val output: String)

    private val nonEnglish = listOf(
        Plain(
            "hi-IN",
            "  \u0928\u092E\u0938\u094D\u0924\u0947   \u0926\u094B\u0938\u094D\u0924 \n  \u0920\u0940\u0915  ",
            "\u0928\u092E\u0938\u094D\u0924\u0947 \u0926\u094B\u0938\u094D\u0924\n\u0920\u0940\u0915"
        ),
        Plain(
            "hi-IN",
            "um \u0939\u093E\u0901,   uh   \u0920\u0940\u0915 \u0939\u0948.   ",
            "um \u0939\u093E\u0901, uh \u0920\u0940\u0915 \u0939\u0948."
        ),
        Plain(
            "ja-JP",
            "\u3053\u3093\u306B\u3061\u306F   \u4E16\u754C\u3002 \t ",
            "\u3053\u3093\u306B\u3061\u306F \u4E16\u754C\u3002"
        ),
        Plain(
            "ja-JP",
            " \u3042\u306E\u30FC   \u3048\u3068 \n\n \u306F\u3044 ",
            "\u3042\u306E\u30FC \u3048\u3068\n\n\u306F\u3044"
        ),
        Plain("zh-CN", "\u4F60\u597D   \u4E16\u754C \n\n \u518D\u89C1  ", "\u4F60\u597D \u4E16\u754C\n\n\u518D\u89C1"),
        Plain(
            "ko-KR",
            "\uC548\uB155\uD558\uC138\uC694   \uC138\uACC4 \n",
            "\uC548\uB155\uD558\uC138\uC694 \uC138\uACC4"
        ),
        Plain(
            "ar-SA",
            "  \u0645\u0631\u062D\u0628\u0627   \u0628\u0627\u0644\u0639\u0627\u0644\u0645  ",
            "\u0645\u0631\u062D\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645"
        ),
        Plain("fr-FR", "  Bonjour   le   monde, um, uh  \n  \u00E7a va  ", "Bonjour le monde, um, uh\n\u00E7a va"),
        Plain("fr-FR", "euh, um, uh... je ne sais pas.   i think \tso", "euh, um, uh... je ne sais pas. i think so"),
        Plain("de-DE", "Er ist hier.", "Er ist hier."),
        Plain("fr-FR", "hello   WORLD, you know   what i mean", "hello WORLD, you know what i mean"),
    )

    @Test fun aNonEnglishLanguageOnlyCollapsesSpaces() {
        // The desktop leaves other languages alone apart from spaces: no filler removal, no capitals, no full stop,
        // whatever the tone. "um" and "uh" are ordinary text in French or Hindi.
        for (plain in nonEnglish) {
            for (tone in WritingTone.entries) {
                assertEquals(
                    "${plain.language} $tone: \"${plain.input}\"",
                    plain.output,
                    WritingStyle.apply(plain.input, tone, plain.language)
                )
            }
        }
    }

    // -- What the result looks like -----------------------------------------------------------------------------

    @Test fun blankInputGivesAnEmptyString() {
        for (language in listOf("en-US", "hi-IN")) {
            for (tone in WritingTone.entries) {
                for (input in listOf("", " ", "\n", "\t \n ", "\u00A0", "\u2003\u3000", "\uFEFF", "\r\n\r\n")) {
                    assertEquals("$language $tone \"$input\"", "", WritingStyle.apply(input, tone, language))
                }
            }
        }
    }

    @Test fun aDictationOfOnlyFillersComesBackEmpty() {
        // The desktop removes every filler and has nothing left to write, so the result is blank. The caller should
        // treat "" as "nothing was said".
        for (input in listOf("um", "Um,", "uh", "hmm", "Hmm...", "um, uh", "Um, uh, hmm", "uhh umm hm", "  um  \n")) {
            for (tone in WritingTone.entries) {
                assertEquals("$tone \"$input\"", "", WritingStyle.apply(input, tone))
            }
        }
    }

    @Test fun aFillerWithItsOwnStopLeavesTheStop() {
        // Not blank: "Um." is a filler and the full stop the engine put after it, and the desktop keeps the stop.
        for (tone in WritingTone.entries) {
            assertEquals("$tone um.", ".", WritingStyle.apply("Um.", tone))
            assertEquals("$tone uh?", "?", WritingStyle.apply("uh?", tone))
        }
    }

    @Test fun theResultNeverHasLeadingOrTrailingWhitespace() {
        val awkward = listOf(
            "  hello  ", "\n\nhello\n\n", "hello \t", "\u00A0hello\u00A0", "\uFEFF hello \uFEFF", "\u001Fhello\u001F",
            "hello, ", "hello,\n", ", hello", "um, hello, um", "hello . ", "hello\n\n\n", "\u2003um\u2003", "x\u3000"
        )
        for (tone in WritingTone.entries) {
            for (input in awkward + everyVector.map { it.input }) {
                assertTrimmed("$tone \"$input\"", WritingStyle.apply(input, tone))
                assertTrimmed("$tone hi-IN \"$input\"", WritingStyle.apply(input, tone, "hi-IN"))
            }
            // A term with spaces around it is replaced whole, and what comes back is trimmed as well.
            assertTrimmed("$tone padded term", WritingStyle.apply(" padded ", tone, "en-US", listOf(" padded ")))
        }
    }

    @Test fun stylingTwiceChangesNothing() {
        for (tone in WritingTone.entries) {
            for (vector in everyVector) {
                val once = WritingStyle.apply(vector.input, tone, "en-US", vector.terms)
                assertEquals("$tone \"${vector.input}\"", once, WritingStyle.apply(once, tone, "en-US", vector.terms))
            }
        }
    }

    @Test fun stylingTwiceChangesNothingForOddInputEither() {
        // The desktop's own single pass is not final on inputs like these (it leaves four dots where a filler and its
        // stop met, or a "you know" that only showed up once the line before it had gone). The style is applied until
        // it settles, so the second call has nothing left to do.
        val odd = listOf(
            "I think... um. Let me check.", "Hey... Hmm. Okay.", "so, um, yeah... uh. anyway",
            "Well... hmm. I do not know", "again\n turn. May; a-b\n you know -\t",
            "think \u2013 Okay,\thm Wait\u2026,\r\nHey... Hmm.\n\n", "um... um... um. um",
            "you know,\nyou know,\nyou know -", ". , ...Ctrl+\u2026.", "Okay, uh, so, yeah.", "A.\n\nB..", "x \u2026 , y"
        )
        for (tone in WritingTone.entries) {
            for (input in odd) {
                val once = WritingStyle.apply(input, tone)
                assertEquals("$tone \"$input\"", once, WritingStyle.apply(once, tone))
            }
        }
    }

    @Test fun aFillerAndItsStopAfterAnEllipsisLeavesThreeDots() {
        // The desktop's first pass gives "I think.... Let me check." (four dots); styling that again gives three.
        // Android returns the settled text, so the dictation is written once, correctly.
        val spoken = "I think... um. Let me check."
        assertEquals("formal", "I think... Let me check.", WritingStyle.apply(spoken, WritingTone.FORMAL))
        assertEquals("casual", "I think... Let me check.", WritingStyle.apply(spoken, WritingTone.CASUAL))
        assertEquals("very casual", "I think... let me check", WritingStyle.apply(spoken, WritingTone.VERY_CASUAL))
    }

    // -- The dictionary -----------------------------------------------------------------------------------------

    @Test fun protectedTermsKeepTheirCaseInEveryTone() {
        val terms = listOf(
            "C++", "a.b(c)", "iPhone", "mcdonald's", "NASA", "x+y=z", "(c)", "\$HOME", "^", "\\d+", "[a]", "a|b"
        )
        val inputs = listOf(
            "C++ rocks", "i like C++ a lot, you know", "a.b(c) is fine", "um, a.b(c)", "iPhone is here",
            "say mcdonald's is open", "nasa and NASA", "x+y=z and [a] and a|b", "the \$HOME folder", "a (c) b",
            "price ^ up", "\\d+ is text"
        )
        for (tone in WritingTone.entries) {
            for (input in inputs) {
                val result = WritingStyle.apply(input, tone, "en-US", terms)
                for (term in terms) {
                    if (input.contains(term)) assertTrue("$tone: \"$result\" keeps $term", result.contains(term))
                }
            }
        }
    }

    @Test fun anEmptyOrBlankTermIsHarmless() {
        for (tone in WritingTone.entries) {
            for (vector in everyVector) {
                val without = WritingStyle.apply(vector.input, tone, "en-US", vector.terms)
                val with = WritingStyle.apply(vector.input, tone, "en-US", vector.terms + listOf("", " ", "\t\n"))
                assertEquals("$tone \"${vector.input}\"", without, with)
            }
        }
    }

    @Test fun aHundredTermsAreFine() {
        val terms = (1..100).map { "term$it" }
        val input = "um, say term7 and term42 and term100, you know, and term1 or term10 or Term2."
        val expected = listOf(
            "Say term7 and term42 and term100 and term1 or term10 or Term2.",
            "Say term7 and term42 and term100 and term1 or term10 or Term2.",
            "say term7 and term42 and term100 and term1 or term10 or Term2"
        )
        for ((index, tone) in WritingTone.entries.withIndex()) {
            assertEquals(tone.name, expected[index], WritingStyle.apply(input, tone, "en-US", terms))
        }
    }

    @Test fun aDigitOnlyTermDoesNotDamageOtherProtectedText() {
        // Not a desktop parity case: there, a term such as "0" also matches the number inside the marker that stands
        // in for the first quoted text, and the quote comes back as garbage. Here it is left alone.
        val terms = listOf("0", "1")
        val quoted = "say \"hi there\" and 0 again"
        val formal = WritingStyle.apply(quoted, WritingTone.FORMAL, "en-US", terms)
        val casual = WritingStyle.apply(quoted, WritingTone.CASUAL, "en-US", terms)
        assertEquals("formal", "Say \"hi there\" and 0 again.", formal)
        assertEquals("casual", "Say \"hi there\" and 0 again", casual)
        assertEquals("very casual", quoted, WritingStyle.apply(quoted, WritingTone.VERY_CASUAL, "en-US", terms))
        // Formal adds its full stop after a letter or digit, not after a closing backtick.
        val code = "say `1 + 0` and `0`"
        assertEquals("code", "Say `1 + 0` and `0`", WritingStyle.apply(code, WritingTone.FORMAL, "en-US", terms))
    }

    @Test fun lookalikesOfTheInternalMarkersAreLeftAlone() {
        // The style sets text aside behind private-use characters. If the input itself holds that pattern with no text
        // behind it, the desktop writes the word "undefined" in its place; here it stays as it was.
        assertEquals("formal", "A \uE0005\uE001 b.", WritingStyle.apply("a \uE0005\uE001 b", WritingTone.FORMAL))
        assertEquals("casual", "A \uE2007\uE201 b", WritingStyle.apply("a \uE2007\uE201 b", WritingTone.CASUAL))
    }

    // -- The preview --------------------------------------------------------------------------------------------

    @Test fun thePreviewSampleReadsDifferentlyInEachTone() {
        assertEquals(
            "sample",
            "um, so I am sending the notes tonight, you know, once we are done. thanks for waiting",
            WritingStyle.PREVIEW_SAMPLE
        )
        assertEquals(
            "formal",
            "So I am sending the notes tonight once we are done. Thanks for waiting.",
            WritingStyle.apply(WritingStyle.PREVIEW_SAMPLE, WritingTone.FORMAL)
        )
        assertEquals(
            "casual",
            "So I am sending the notes tonight once we are done. Thanks for waiting",
            WritingStyle.apply(WritingStyle.PREVIEW_SAMPLE, WritingTone.CASUAL)
        )
        assertEquals(
            "very casual",
            "so I am sending the notes tonight once we are done. thanks for waiting",
            WritingStyle.apply(WritingStyle.PREVIEW_SAMPLE, WritingTone.VERY_CASUAL)
        )
        val results = WritingTone.entries.map { WritingStyle.apply(WritingStyle.PREVIEW_SAMPLE, it) }
        assertTrue("three different texts", results.toSet().size == 3)
    }

    // -- It never throws, and never takes long ------------------------------------------------------------------

    @Test fun anEmptyStringGivesAnEmptyString() {
        for (tone in WritingTone.entries) {
            assertEquals(tone.name, "", WritingStyle.apply("", tone))
            assertEquals("$tone hi-IN", "", WritingStyle.apply("", tone, "hi-IN"))
        }
    }

    @Test fun awkwardInputNeitherThrowsNorLeavesSpaceAtTheEdges() {
        val awkward = listOf(
            // lone and swapped surrogates
            "\uD83D", "\uDE00", "\uDE00\uD83D", "a\uD83Db", "\uD83D\uDE00\uD83D", "um \uD83D, \uDE00 you know", "\uD83D.", ".\uDE00",
            // punctuation, line breaks and control characters
            ".,;:!?", "?!?!?!", "...", "\u2026", "\n\n\n", "\r\n\r\n", "\u0000", "\uFFFF", "\u0301", "-", "--", ",", " , ",
            // the start of every kind of protected text, left open
            "' '", "\"", "`", "```", "``` ```", "\u201C", "\u2018x", "http://", "www.", "a@", "@", "#", "/", "\\\\", "C:\\",
            "Ctrl+", "Ctrl+a+",
            // the private-use characters the style uses internally
            "\uE000\uE001", "\uE0000\uE001", "\uE200\uE201", "\uE2009\uE201", "\uE300", "\uE301um\uE301", "um\uE301"
        )
        val terms = listOf("a", "\uD83D", ".", "x")
        for (tone in WritingTone.entries) {
            for (input in awkward) {
                val result = WritingStyle.apply(input, tone, "en-US", terms)
                assertTrimmed("$tone ${input.length} chars", result)
                assertEquals("$tone again", result, WritingStyle.apply(result, tone, "en-US", terms))
            }
        }
    }

    @Test fun aStringOfOnlyPunctuationOrOnlyNewlinesComesBackTidy() {
        for (tone in WritingTone.entries) {
            assertEquals("$tone newlines", "", WritingStyle.apply("\n".repeat(50), tone))
            assertEquals("$tone newlines and spaces", "", WritingStyle.apply(" \n ".repeat(50), tone))
            val stops = WritingStyle.apply(".!?,;:".repeat(30), tone)
            assertTrimmed("$tone punctuation", stops)
            assertTrue("$tone punctuation stays punctuation", stops.all { it in ".!?,;:" })
        }
    }

    @Test fun aHundredThousandCharactersOfAnyShapeFinishQuickly() {
        // Each of these is a unit the desktop's patterns take quadratic or exponential time on when it is repeated to
        // 100,000 characters. Fillers, separators, dots, quotes, paths, links and sentence starts, all in long runs.
        val shapes = listOf(
            "a", "word ", "um ", "um, ", "um\n", "um.\n", "um, um\n", "um, you know, ", "uh... ", "u" + "h".repeat(50),
            "a-", "a.", "1.", "a@", "a@b.c.", ".", "!", ",", ", ", ". ", "\n", " ", "\t", "\u00A0", "\u2026", "...", "- ",
            "`", "```", "\"", "\u201C", "\u2018", "'", "/", "@", "#a ", "Ctrl+", "http://", "www.", "https://a ",
            "Hello. ", "I ", "i ", "Will ", "Don't ", "Mr. ", "p.m. ", "A", "\u00C9", "\uD83D\uDE00", "\uD83D", "\uDE00",
            "x, um ", "You know, ", ", you know,", "\n,", ".\n, ", ",;:.!?-"
        )
        for (shape in shapes) {
            val text = shape.repeat((100_000 + shape.length - 1) / shape.length)
            for (tone in WritingTone.entries) {
                var result = ""
                val took = millis { result = WritingStyle.apply(text, tone) }
                assertTrue("\"${shape.take(12)}\" x ${text.length} in $tone took $took ms", took < 2000)
                assertTrimmed("\"${shape.take(12)}\" in $tone", result)
            }
        }
    }

    @Test fun aFewHundredCharactersTakeAFewMilliseconds() {
        val text = ("Um, so I am sending the notes tonight, you know, once we are done. thanks for waiting " +
            "https://Example.com/a?b=1 or Test@Example.com, version 1.0.16 and 1,234.56. ").repeat(4).take(500)
        for (tone in WritingTone.entries) {
            repeat(200) { WritingStyle.apply(text, tone) }
            val runs = 100
            val took = millis { repeat(runs) { WritingStyle.apply(text, tone) } }
            assertTrue("$tone: $runs calls on ${text.length} characters took $took ms", took < runs * 5)
        }
    }
}
