package com.voxden.android.core

import java.util.Locale

/**
 * Dictated English written in the tone the person chose: the desktop app's Writing style (`applyStyleWithTone` in
 * src/style.js, with the few helpers it needs from src/cleanup.js and src/phonetics.js), ported to pure Kotlin.
 *
 * A tone changes capitals and punctuation, never words: the words on the page are the ones that were said. What
 * goes is sound, not speech: "um", "uh", "hmm" and the aside "you know" between commas. Everything else stays,
 * including URLs, e-mail addresses, numbers like 1,234.56, paths, @mentions, #tags, quoted and code text, key
 * chords, and the user's own dictionary terms.
 *
 * The desktop does this with regular expressions. Several of them are quadratic or exponential on long runs of
 * spaces, fillers or dots, and Java's engine overflows its stack on long repeated groups, so here every pattern is a
 * small scanner that gives the same answer in one pass. No regular expression is compiled, and nothing here is
 * recursive, so a 100,000-character dictation costs about the same per character as a short one. JavaScript's
 * `\s`, `\w`, `\b` and `\p{L}` are spelled out ([isJsSpace], [isAsciiWord], [isLetter]) because Java, ICU and
 * JavaScript each define them a little differently, and the result must not depend on the platform.
 */
object WritingStyle {
    /** A sample sentence for the settings preview. */
    const val PREVIEW_SAMPLE = "um, so I am sending the notes tonight, you know, once we are done. thanks for waiting"

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
     * [text] written in [tone]. For English ([appliesTo]) this is the desktop's `applyStyleWithTone`: fillers out,
     * capitals and the closing full stop as the tone says. For any other language only the spaces are tidied (runs
     * of spaces and tabs become one space, spaces around line breaks go), as the desktop does.
     *
     * The result is always trimmed (no leading or trailing whitespace or line break), so a dictation that was only
     * fillers, such as "um", comes back as "". The function is pure, never throws (on any internal error it returns
     * `text.trim()`), and is idempotent. [protectedTerms], the user's personal dictionary, keep their exact
     * spelling and case; any characters are fine in a term, and blank terms are ignored.
     */
    fun apply(
        text: String,
        tone: WritingTone,
        language: String = "en-US",
        protectedTerms: List<String> = emptyList()
    ): String {
        return try {
            trimEdges(if (appliesTo(language)) styled(text, tone, protectedTerms) else collapseSpaces(text))
        } catch (e: Exception) {
            trimEdges(text)
        } catch (e: StackOverflowError) {
            trimEdges(text)
        }
    }

    // -- The words the tone has opinions about ------------------------------------------------------------------

    /** Where a filler came out, until the capital after it has been checked (the desktop's GAP). */
    private const val GAP = '\uE300'

    /** "..." while fillers come out: one character, so a filler takes all of its ellipsis or none (DOTS). */
    private const val DOTS = '\uE301'
    private const val ELLIPSIS = '\u2026'
    private const val CURLY_APOSTROPHE = '\u2019'

    // Private-use characters that stand in for text set aside while the tone is applied. Structured tokens (URLs,
    // addresses, numbers) and kept text (quotes, paths, mentions, dictionary terms) use different pairs so one can
    // sit inside the other.
    private const val STRUCT_OPEN = '\uE000'
    private const val STRUCT_CLOSE = '\uE001'
    private const val KEEP_OPEN = '\uE200'
    private const val KEEP_CLOSE = '\uE201'

    /** Frequent English words (src/phonetics.js COMMON_WORDS): the first half of "an everyday word, not a name". */
    private val COMMON_WORDS: Set<String> = wordSet(
        """
        a about above after again against all also am an and any are around as ask at away back bad bag be
        because bed been before being best better between big bit both box boy bread break bring but buy by call
        came can car care case cat chair child city close cold come could country cup cut dad day dear did die
        different do dog done door down draw drink drive drop dry during each early eat egg eggs eight end
        enough even ever every eye eyes face fact fall family far fast father feel few field find fine fire
        first fish five floor fly follow food foot for form found four free friend from front full fun game get
        girl give glass go god going gold good got great green group grow had hair half hand happy hard has hat
        have he head hear heart help her here high him his hold home hope horse hot hour house how however
        hundred husband i idea if in into is it its job join jump just keep key kid kind king kitchen know lady
        land large last late later laugh law lay lead learn leave left leg less let letter life light like line
        list little live long look lose lot love low made main make man many may maybe me mean meat meet men
        might milk mind mine minute miss money month more morning most mother mouth move much music must my name
        near need never new news next nice night nine no north not note nothing now number of off often oh oil
        ok old on once one only open or order other our out over own page paper part party pass past pay people
        perhaps person phone pick picture piece place plan play please point poor possible power present press
        pretty problem public pull push put question quick quiet quite rain reach read ready real reason red
        remember rest return rich ride right ring rise river road rock room round run said salt same sat save
        saw say school sea season seat second see seem sell send sense sent serve service set seven several
        shall she ship shoe shop short should show side sight sign since sing single sir sister sit six size sky
        sleep small smile snow so some son song soon sorry sound south space speak special spend stand star
        start state stay step still stone stop store story street strong study such sudden sugar summer sun sure
        sweet swim table take talk tall taste teach team tell ten than thank that the their them then there
        these they thing think third this those though thought three through throw thus time to today together
        told tomorrow tonight too took top touch toward town tree trip trouble true try turn twice two under
        until up upon us use usual very view visit voice wait walk wall want war warm was wash watch water way
        we wear week well went were west what when where whether which while white who whole why wide wife will
        win wind window wine winter wish with within without woman women word work world would write wrong yard
        year yes yet you young your able across act actual add age ago agree air allow almost alone along
        already always amount animal answer appear apply area arm army art aside attack attempt author average
        avoid baby balance ball bank base basic bear beat beauty become begin behind believe below bench beside
        beyond bill bird blood blow blue board boat body bone book bore born borrow bother bottle bottom bowl
        branch brave breath bridge bright broad brother brown brush build burn bury business busy cake calm camp
        cancel candle cap capital captain card carry cart carve cast catch cause cell centre chain chance change
        charge chart chase cheap check cheer chest chief choice choose church circle claim class clean clear
        clerk clever climb cling clock cloth cloud club coast coat coffee coin collect colour column comfort
        common company compare complete concern condition connect consider contain continue control cook cool
        copy corn corner correct cost cotton count couple course court cover crack craft crash cream create
        cross crowd crown cry cure curious current curve custom damage dance danger dark date dead deal death
        debt decide deep defend degree delay deliver demand depend describe desert design desire desk destroy
        detail develop device dinner direct dirt discover discuss disease distance divide doctor double doubt
        dozen drag drama dream dress drift drum duck dust duty eager ear earn earth ease east easy edge educate
        effect effort either elect element else empty enemy energy engine enjoy enter entire equal error escape
        event exact examine example except exchange excite excuse exist expect expense experience explain
        express extend extra fail fair faith false fame farm fashion fat fault favour fear feather feed female
        fence fever fight figure file fill film final finger finish firm fit fix flag flame flash flat flesh
        float flood flour flow flower fold force forest forget forgive fork former forward frame fresh fruit
        fuel funny future gain garden gas gate gather general gentle gift glad goal goat govern grace grade
        grain grand grant grass grave gray greet grey grind ground guard guess guest guide guilt gun habit hail
        hall hammer handle hang happen harbour harm harvest haste hate health heat heaven heavy hedge height
        hell hello hide hill hire history hit hole holiday hollow holy honest honour hook horn hospital host
        hotel human humour hunt hurry hurt ice ill image imagine import improve inch include increase indeed
        industry influence inform injure ink inner insect inside instead interest introduce invent invite iron
        island issue item jar jaw jewel joint joke journey joy judge juice justice keen kick kill kiss knee
        knife knock knot labour lack lake lamp language latter laughter layer lazy leaf lean leap lease leather
        lecture legal lend length lesson level liberty library lie lift limb limit link lip liquid literature
        load loaf loan local lock lodge lonely loose lord loss loud lower loyal luck lunch lung machine mad
        magazine magic mail major manner mark market marriage mass master match material matter meal measure
        medicine medium member memory mention merchant mercy mere message metal method middle mild mile military
        mill million mineral minister minor mint mirror mission mistake mix model modern modest moment monkey
        moon moral motion motor mountain mouse mud murder muscle mystery nail narrow nation native nature navy
        neat neck needle neglect neighbour nerve nest net neutral noble noise none noon nor normal nose notice
        noun novel nurse nut oak obey object observe occasion occupy occur ocean odd offer office officer onion
        opinion oppose orange organ origin ought ounce outside oven owe owner pack pain paint pair palace pale
        palm pan panel parent park parliament partial particular partner path patient pattern pause peace peak
        pen pencil pepper perfect perform period permit pet photograph physical piano picnic pig pile pilot pin
        pink pipe pity plain plane plant plastic plate pleasant pleasure plenty plough pocket poem poet police
        policy polish political pool popular port portion position positive possess post pot potato pound pour
        powder practice praise pray prefer prepare presence prevent previous price pride priest prince principle
        print prison private prize probable proceed process produce profit program progress promise proof proper
        propose protect proud prove provide publish pump punish pupil purchase pure purple purpose pursue
        quality quantity quarter queen race radio rail raise range rank rapid rare rate rather raw ray react
        realize rear receive recent recognize record recover reduce refer reflect refuse regard region regret
        regular reject relate relief religion remain remark remedy remind remove rent repair repeat reply report
        represent republic reputation request require rescue research reserve resist resource respect respond
        responsible result retire reveal reverse review reward ribbon rid rifle risk rival roar roast rob rod
        roll roof root rope rose rough route row royal rub rubber rude rug ruin rule rush sack sad safe sail
        sake salary sale sand satisfy sauce scale scarce scatter scene scheme science score scrape scratch
        screen screw script seal search seed seek seize seldom select self senate senior sentence separate
        series serious servant settle severe sew shade shadow shake shame shape share sharp shed sheep sheet
        shelf shell shelter shift shine shirt shock shoot shore shoulder shout shower shut shy sick silence silk
        silver similar simple sin sink situation skill skin skirt slave slide slight slip slope slow smell smoke
        smooth snake soap social society soft soil soldier solid solve sorrow sort soul soup sour source spare
        spark speed spell spirit spite split spoil spoon sport spot spread spring square squeeze stable staff
        stage stain stair stamp standard steady steal steam steel stem stick stiff stir stock stomach storm
        stove straight strain strange stream strength stretch strike string strip stroke structure struggle
        stuff stupid subject submit substance succeed suffer sufficient suggest suit sum supper supply support
        suppose surface surprise surround suspect swear sweep swell swing sword symbol sympathy system tail tank
        tap task tax tea tear temper temple tend tender tent term terrible territory test text thick thief thin
        thread threat throat thumb thunder ticket tide tie tight timber tin tip tired title tobacco toe tone
        tongue tool tooth total tower track trade traffic train translate travel treasure treat tremble trial
        tribe trick troop tropical truck trust truth tube tune tunnel twist type ugly uncle unit universe unless
        unusual upper urge vain valley value variety various vast vegetable vehicle venture verse vessel victory
        village violent virtue visible vision volume vote voyage wage wagon waist wander warn waste wave wax
        weak wealth weapon weather weave wedding weed weekend weigh weight welcome wet wheat wheel whip whisper
        whistle wicked wild willing wing wipe wire wise wit witness wonder wood wool worry worse worship worth
        wound wrap wreck wrist
        """
    )

    /**
     * Everyday words the common-word list leaves out: speech, the verbs of a request, and the nouns of apps and
     * prompts (src/style.js EVERYDAY_EXTRA). With the list above, and their -s, -ed, -ing and -ly forms, they are
     * the words Very casual may put in lower case at the start of a sentence. Anything else could be a name.
     */
    private val EVERYDAY_EXTRA: Set<String> = wordSet(
        """
        okay ok yeah yep yup nope hey hi hmm wow oh ah alright anyway anyways yo bro dude bye thanks thank sorry
        please cool nice great awesome perfect fine done sure right wait listen suppose like just so then now
        here there gonna wanna gotta lemme gimme kinda sorta actually basically honestly literally really
        seriously obviously probably definitely apparently currently finally generally mostly usually exactly
        especially maybe perhaps also else instead otherwise meanwhile besides although unless whatever
        whichever whoever whenever wherever somehow someone something somewhere somebody anyone anything
        anywhere anybody everyone everything everywhere everybody nobody noone nothing nowhere neither therefore
        moreover furthermore hopefully unfortunately luckily initially recently previously manual main sometimes
        overall according till total complete full simple clear direct easy quick slow does doing having gave
        kept shown gone felt knew built ran paid said told thought brought bought analyze analyse implement
        commit merge deploy rebuild uninstall identify summarize summarise rewrite refactor debug verify confirm
        replace rename convert format render export release launch resume enable disable ensure exclude adjust
        decrease optimize simplify sketch schedule organize filter combine attach insert append zoom update
        create remove delete generate select click scroll paste copy upload download install restart reload
        refresh test fix build run open close hide show move change keep add give make use try check send share
        tell ask let user app file image video button screen feature version prompt shot camera character
        background color style mode icon logo menu setting option model engine audio mic microphone recording
        transcript dictionary account payment credit balance sheet section scene frame angle lighting shadow
        glow border layout theme font width height speed code bug error issue server client database data link
        website homepage dashboard sidebar header footer title label input output toggle slider checkbox
        dropdown popup dialog overlay notification chat email project task item stuff electricity subscription
        pricing category insight precious beautiful pretty cute yes no not
        """
    )

    /** Common words that are also names people and apps go by: at a sentence start they keep their capital. */
    private val NAME_WORDS: Set<String> = wordSet(
        """
        mark bill rose grace hope faith joy frank jack max summer ruby lily holly ivy iris violet victor earl
        guy ray dawn rich pat sue chase hunter mason taylor carter cook baker deep sunny apple windows word
        excel chrome edge slack teams notion signal discord cursor linear amazon python java swift rust jordan
        austin paris china india turkey jersey march april june august
        """
    )

    /**
     * Small words the speech engine capitalises mid-sentence as if a sentence had started there: "also Let's
     * update", "you Don't update". They go back to lower case, between lower-case words only.
     */
    private val FUNCTION_WORDS: Set<String> = wordSet(
        """
        a an the and or but so if then because as of to in on at by for from with into about like let is are was
        were be been being do does did have has had can could would should shall might must not it its this that
        these those there here you your we our they their he his she her him them us me my what which who where
        when why how also just now well yeah yes okay ok no please maybe actually even still too very really
        """
    )

    /** Names that are also modal verbs: "Will you check?" is a question, "Will is here" a person. */
    private val MODAL_NAMES: Set<String> = setOf("will", "may")

    /** What follows a modal verb when it is a verb (src/style.js AFTER_MODAL). */
    private val AFTER_MODAL_WORDS: Set<String> = setOf(
        "i", "you", "we", "they", "he", "she", "it", "this", "that", "there", "the", "a", "an", "my", "your", "our",
        "their", "his", "her", "its", "someone", "anyone", "everyone", "something", "anything", "not"
    )

    /** Short forms whose full stop does not end a sentence (src/cleanup.js ABBREVIATIONS). */
    private val ABBREVIATIONS: Set<String> = setOf(
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "approx", "inc", "ltd", "corp", "dept", "fig",
        "cf", "al", "misc"
    )

    /** Asides that stay. Next to one of these, one comma of "you know" belongs to the neighbour. */
    private val KEPT_ASIDES: Array<String> = arrayOf("like", "i mean", "kind of", "sort of")

    private fun wordSet(words: String): Set<String> = words.split(' ', '\n').filter { it.isNotEmpty() }.toHashSet()

    // -- The whole style ----------------------------------------------------------------------------------------

    /**
     * `applyStyleWithTone`: URLs, addresses and numbers are set aside first, then quotes, paths, mentions and
     * dictionary terms, the tone runs on what is left, and everything comes back in place.
     */
    private fun styled(text: String, tone: WritingTone, terms: List<String>): String {
        val structured = ArrayList<String>()
        val withoutStructure = protectStructured(text, structured)
        val result = withStyleTokens(withoutStructure, terms) { value ->
            finalizeStyle(stripFillers(jsTrim(value)), tone)
        }
        return restorePlaceholders(result, STRUCT_OPEN, STRUCT_CLOSE, structured)
    }

    private fun withStyleTokens(value: String, terms: List<String>, transform: (String) -> String): String {
        val kept = ArrayList<String>()
        var s = KeepScan(value, kept).run()
        for (term in orderedTerms(terms)) {
            if (!s.contains(term)) continue
            s = protectTerm(s, term, kept)
        }
        return restorePlaceholders(transform(s), KEEP_OPEN, KEEP_CLOSE, kept)
    }

    /** Capitals and punctuation for the tone, after filler removal. */
    private fun finalizeStyle(text: String, tone: WritingTone): String {
        val raw = lowerStrayCapitals(tidyAfterFillerRemoval(jsTrim(text)))
        if (raw.isEmpty()) return ""
        return when (tone) {
            WritingTone.FORMAL -> applyFormal(raw)
            WritingTone.VERY_CASUAL -> applyVeryCasual(raw)
            WritingTone.CASUAL -> applyCasual(raw)
        }
    }

    /** Capitals at every sentence start, the closing full stop added. */
    private fun applyFormal(text: String): String {
        val s = applyCasual(text)
        if (s.isEmpty()) return s
        val last = Character.codePointBefore(s, s.length)
        return if (isLetter(last) || isNumber(last) || last == STRUCT_CLOSE.code) "$s." else s
    }

    /** Capitals at every sentence start; the punctuation as the speech engine wrote it. */
    private fun applyCasual(text: String): String {
        val s = capitalizePronoun(collapseSpaces(text))
        return if (s.isEmpty()) "" else mapSentenceStarts(s, StartMode.CAPITALIZE)
    }

    /**
     * No capital at a sentence start, and no closing full stop on a line. "?", "!", an ellipsis and an
     * abbreviation's own stop stay.
     */
    private fun applyVeryCasual(text: String): String {
        val s = capitalizePronoun(collapseSpaces(text))
        if (s.isEmpty()) return ""
        return dropClosingStops(mapSentenceStarts(s, StartMode.LOWER))
    }

    // -- Setting text aside -------------------------------------------------------------------------------------

    /**
     * The URLs, e-mail addresses, domains and numbers with separators in [text], each replaced by a marker that
     * keeps its index in [tokens] (the desktop's `withStructuredTokens`). Trailing punctuation stays outside the
     * token: "see example.com." keeps its stop.
     */
    private fun protectStructured(text: String, tokens: MutableList<String>): String {
        val scan = StructuredScan(text)
        val n = text.length
        val out = StringBuilder(n + 16)
        var copied = 0
        var i = 0
        while (i < n) {
            var end = scan.url(i)
            if (end < 0) end = scan.email(i)
            if (end < 0) end = scan.domain(i)
            if (end < 0) end = scan.number(i)
            if (end < 0) {
                i++
                continue
            }
            var tokenEnd = end
            while (tokenEnd > i && isTrailingStop(text[tokenEnd - 1])) tokenEnd--
            out.append(text, copied, i)
            tokens.add(text.substring(i, tokenEnd))
            out.append(STRUCT_OPEN).append(tokens.size - 1).append(STRUCT_CLOSE).append(text, tokenEnd, end)
            copied = end
            i = end
        }
        out.append(text, copied, n)
        return out.toString()
    }

    private fun isTrailingStop(c: Char): Boolean = c == '.' || c == '!' || c == '?' || c == ',' || c == ';' || c == ':'

    /**
     * The four shapes the desktop sets aside as structured text, tried in this order at every position:
     * `(https?://|www.)\S+`, an e-mail address, a dotted domain with an optional path, and a number such as
     * 1,234.56. Each regular expression there rescans a whole run of word characters from every start inside it,
     * which is quadratic, so a failure here is remembered for the rest of its run: a start inside a run can only
     * succeed if the run's first start did.
     */
    private class StructuredScan(private val s: String) {
        private val n = s.length
        private var emailSkip = 0
        private var domainSkip = 0
        private val labelStarts = IntBuf()

        /** `(?:https?:\/\/|www\.)[^\s<>]+`, ASCII letters in either case. */
        fun url(i: Int): Int {
            val first = lowerAscii(s[i])
            val prefixEnd: Int
            if (first == 'h') {
                if (!hasAscii(i + 1, "ttp")) return -1
                var j = i + 4
                if (j < n && lowerAscii(s[j]) == 's') j++
                if (!s.startsWith("://", j)) return -1
                prefixEnd = j + 3
            } else if (first == 'w') {
                if (!hasAscii(i + 1, "ww.")) return -1
                prefixEnd = i + 4
            } else {
                return -1
            }
            var k = prefixEnd
            while (k < n && !isJsSpace(s[k]) && s[k] != '<' && s[k] != '>') k++
            return if (k > prefixEnd) k else -1
        }

        /** `[\w.+%-]+@[\w.-]+\.[a-z]{2,}`: the last dot of the domain that is followed by two letters wins. */
        fun email(i: Int): Int {
            if (i < emailSkip || !isLocalChar(s[i])) return -1
            var k = i
            while (k < n && isLocalChar(s[k])) k++
            emailSkip = k
            if (k >= n || s[k] != '@') return -1
            var d = k + 1
            while (d < n && isDomainChar(s[d])) d++
            var e = d - 1
            while (e >= k + 2) {
                if (s[e] == '.') {
                    var l = e + 1
                    while (l < d && isAsciiLetter(s[l])) l++
                    if (l - (e + 1) >= 2) return l
                }
                e--
            }
            return -1
        }

        /**
         * `\b(?:[\w-]+\.)+[a-z]{2,63}\b(?:[\/:?#][^\s<>]*)?`: labels joined by dots, the last label of two to 63
         * letters, then an optional path. The longest chain of labels that ends well wins.
         */
        fun domain(i: Int): Int {
            if (i < domainSkip || !isLabelChar(s[i]) || !isWordBoundary(i)) return -1
            labelStarts.clear()
            var p = i
            var runEnd = i
            while (true) {
                var e = p
                while (e < n && isLabelChar(s[e])) e++
                if (e == p || e >= n || s[e] != '.') {
                    runEnd = e
                    break
                }
                p = e + 1
                labelStarts.add(p)
            }
            var m = labelStarts.size
            while (m >= 1) {
                val start = labelStarts[m - 1]
                var q = start
                while (q < n && q - start <= 63 && isAsciiLetter(s[q])) q++
                val letters = q - start
                if (letters in 2..63 && (q >= n || !isAsciiWord(s[q]))) {
                    var end = q
                    if (q < n && (s[q] == '/' || s[q] == ':' || s[q] == '?' || s[q] == '#')) {
                        end = q + 1
                        while (end < n && !isJsSpace(s[end]) && s[end] != '<' && s[end] != '>') end++
                    }
                    return end
                }
                m--
            }
            // Every later start in this chain would try the same labels, and the last run has no dot to continue.
            domainSkip = runEnd
            return -1
        }

        /** `\b\d+(?:[,.]\d+)+\b`: 3.14, 1,234.56, 1.0.16. The longest run that ends at a boundary wins. */
        fun number(i: Int): Int {
            if (!isAsciiDigit(s[i]) || (i > 0 && isAsciiWord(s[i - 1]))) return -1
            var e = i
            while (e < n && isAsciiDigit(s[e])) e++
            var best = -1
            while (e + 1 < n && (s[e] == ',' || s[e] == '.') && isAsciiDigit(s[e + 1])) {
                var f = e + 1
                while (f < n && isAsciiDigit(s[f])) f++
                if (f >= n || !isAsciiWord(s[f])) best = f
                e = f
            }
            return best
        }

        private fun isWordBoundary(i: Int): Boolean {
            val before = i > 0 && isAsciiWord(s[i - 1])
            return before != isAsciiWord(s[i])
        }

        private fun hasAscii(at: Int, lower: String): Boolean {
            if (at + lower.length > n) return false
            for (t in lower.indices) if (lowerAscii(s[at + t]) != lower[t]) return false
            return true
        }

        private fun isLocalChar(c: Char): Boolean = isAsciiWord(c) || c == '.' || c == '+' || c == '%' || c == '-'

        private fun isDomainChar(c: Char): Boolean = isAsciiWord(c) || c == '.' || c == '-'

        private fun isLabelChar(c: Char): Boolean = isAsciiWord(c) || c == '-'
    }

    /**
     * Text the tone must not touch, replaced by a marker that keeps its index in the token list: code blocks, `code`,
     * "quotes", curly quotes, 'single quotes', paths, @mentions, #tags and key chords such as Ctrl+Shift+A. The
     * alternatives are tried in that order at every position, as in the desktop's one big pattern. A quote that
     * never closes on its line is remembered, so the other openers on that line are not scanned to the end again.
     */
    private class KeepScan(private val s: String, private val tokens: MutableList<String>) {
        private val n = s.length
        private var noFence = Int.MAX_VALUE
        private var curlyDoubleSkip = 0
        private var curlySingleSkip = 0

        fun run(): String {
            val out = StringBuilder(n + 16)
            var copied = 0
            var i = 0
            while (i < n) {
                val end = matchAt(i)
                if (end < 0) {
                    i++
                    continue
                }
                out.append(s, copied, i)
                tokens.add(s.substring(i, end))
                out.append(KEEP_OPEN).append(tokens.size - 1).append(KEEP_CLOSE)
                copied = end
                i = end
            }
            out.append(s, copied, n)
            return out.toString()
        }

        private fun matchAt(i: Int): Int {
            var end = fenced(i)
            if (end < 0) end = inlineCode(i)
            if (end < 0) end = doubleQuoted(i)
            if (end < 0) end = curlyDouble(i)
            if (end < 0) end = curlySingle(i)
            if (end < 0) end = singleQuoted(i)
            if (end < 0) end = path(i)
            if (end < 0) end = mention(i)
            if (end < 0) end = chord(i)
            return end
        }

        /** A fenced block: three backticks to the next three. */
        private fun fenced(i: Int): Int {
            if (!s.startsWith("```", i) || i + 3 >= noFence) return -1
            val close = s.indexOf("```", i + 3)
            if (close < 0) {
                noFence = i + 3
                return -1
            }
            return close + 3
        }

        /** `[^`\n]+` in backticks. */
        private fun inlineCode(i: Int): Int {
            if (s[i] != '`') return -1
            val j = stopAt(i + 1, '`')
            return if (j > i + 1 && j < n && s[j] == '`') j + 1 else -1
        }

        private fun doubleQuoted(i: Int): Int {
            if (s[i] != '"') return -1
            val j = stopAt(i + 1, '"')
            return if (j < n && s[j] == '"') j + 1 else -1
        }

        private fun curlyDouble(i: Int): Int {
            if (s[i] != '\u201C' || i < curlyDoubleSkip) return -1
            val j = stopAt(i + 1, '\u201D')
            if (j < n && s[j] == '\u201D') return j + 1
            curlyDoubleSkip = j
            return -1
        }

        private fun curlySingle(i: Int): Int {
            if (s[i] != '\u2018' || i < curlySingleSkip) return -1
            val j = stopAt(i + 1, '\u2019')
            if (j < n && s[j] == '\u2019') return j + 1
            curlySingleSkip = j
            return -1
        }

        /** 'quoted', but not the apostrophes inside words: neither quote may touch a word character. */
        private fun singleQuoted(i: Int): Int {
            if (s[i] != '\'' || (i > 0 && isAsciiWord(s[i - 1]))) return -1
            val j = stopAt(i + 1, '\'')
            if (j == i + 1 || j >= n || s[j] != '\'') return -1
            return if (j + 1 < n && isAsciiWord(s[j + 1])) -1 else j + 1
        }

        /** C:\dir, \\server\share or /unix/path, to the next whitespace. */
        private fun path(i: Int): Int {
            val c = s[i]
            val prefixEnd = when {
                isAsciiLetter(c) && i + 2 < n && s[i + 1] == ':' && s[i + 2] == '\\' -> i + 3
                c == '\\' && i + 1 < n && s[i + 1] == '\\' -> i + 2
                c == '/' -> i + 1
                else -> return -1
            }
            var k = prefixEnd
            while (k < n && !isJsSpace(s[k])) k++
            return if (k > prefixEnd) k else -1
        }

        private fun mention(i: Int): Int {
            if (s[i] != '@' && s[i] != '#') return -1
            var k = i + 1
            while (k < n && isAsciiWord(s[k])) k++
            return if (k > i + 1) k else -1
        }

        /** Ctrl, Alt, Shift, Win or Cmd, then one or more "+key". */
        private fun chord(i: Int): Int {
            if (i > 0 && isAsciiWord(s[i - 1])) return -1
            var j = i
            for (name in CHORD_MODIFIERS) {
                if (s.startsWith(name, i)) {
                    j = i + name.length
                    break
                }
            }
            if (j == i) return -1
            var groups = 0
            while (j < n && s[j] == '+') {
                var k = j + 1
                while (k < n && isAsciiWord(s[k])) k++
                if (k == j + 1) break
                j = k
                groups++
            }
            return if (groups > 0) j else -1
        }

        /** The index of the next [close] or line break at or after [from], or the end of the text. */
        private fun stopAt(from: Int, close: Char): Int {
            var j = from
            while (j < n && s[j] != close && s[j] != '\n') j++
            return j
        }
    }

    private val CHORD_MODIFIERS: Array<String> = arrayOf("Ctrl", "Alt", "Shift", "Win", "Cmd")

    /** The user's dictionary terms, longest first so "New York City" wins over "New York", blanks and repeats out. */
    private fun orderedTerms(terms: List<String>): List<String> {
        if (terms.isEmpty()) return terms
        return terms.filter { jsTrim(it).isNotEmpty() }.distinct().sortedByDescending { it.length }
    }

    /**
     * Every standalone occurrence of [term] replaced by a marker. A term is matched as plain text, so characters
     * such as + . ( or ) mean nothing special, and it must not touch a letter, digit or underscore on either side.
     */
    private fun protectTerm(s: String, term: String, tokens: MutableList<String>): String {
        val n = s.length
        var out: StringBuilder? = null
        var copied = 0
        var from = 0
        while (true) {
            val index = s.indexOf(term, from)
            if (index < 0) break
            val end = index + term.length
            if (termStandsAlone(s, index, end)) {
                if (out == null) out = StringBuilder(n + 16)
                out.append(s, copied, index)
                tokens.add(term)
                out.append(KEEP_OPEN).append(tokens.size - 1).append(KEEP_CLOSE)
                copied = end
                from = end
            } else {
                from = index + 1
            }
        }
        if (out == null) return s
        out.append(s, copied, n)
        return out.toString()
    }

    private fun termStandsAlone(s: String, start: Int, end: Int): Boolean {
        // A match may not begin or end inside a surrogate pair.
        if (start > 0 && Character.isLowSurrogate(s[start]) && Character.isHighSurrogate(s[start - 1])) return false
        if (end < s.length && Character.isHighSurrogate(s[end - 1]) && Character.isLowSurrogate(s[end])) return false
        if (start > 0 && isWordLike(Character.codePointBefore(s, start))) return false
        if (end < s.length && isWordLike(Character.codePointAt(s, end))) return false
        // Digits of a marker's index are not text: a term such as "0" must not eat the marker of the first token.
        if (start > 0 && end < s.length && s[start - 1] == KEEP_OPEN && s[end] == KEEP_CLOSE) return false
        return true
    }

    private fun isWordLike(cp: Int): Boolean = isLetter(cp) || isNumber(cp) || cp == '_'.code

    /**
     * Puts the text back where its markers are. A marker whose index has no text (only possible when the input
     * itself held these private-use characters) is left as it is rather than turned into garbage.
     */
    private fun restorePlaceholders(s: String, open: Char, close: Char, tokens: List<String>): String {
        var i = s.indexOf(open)
        if (i < 0) return s
        val n = s.length
        val out = StringBuilder(n)
        var copied = 0
        while (i >= 0) {
            var j = i + 1
            var index = 0L
            while (j < n && s[j] in '0'..'9') {
                if (index < 1_000_000_000L) index = index * 10 + (s[j] - '0')
                j++
            }
            if (j > i + 1 && j < n && s[j] == close) {
                if (index < tokens.size) {
                    out.append(s, copied, i).append(tokens[index.toInt()])
                    copied = j + 1
                }
                i = s.indexOf(open, j + 1)
            } else {
                i = s.indexOf(open, i + 1)
            }
        }
        out.append(s, copied, n)
        return out.toString()
    }

    // -- Fillers ------------------------------------------------------------------------------------------------

    /**
     * Filler removal does not depend on tone: "um" is not a word the speaker chose. Mirrors `stripFillers`.
     */
    private fun stripFillers(text: String): String {
        if (text.isEmpty()) return ""
        return tidyAfterFillerRemoval(removeFillers(text))
    }

    /**
     * Takes out "um", "uh", "hmm" and the aside "you know" together with the punctuation that belongs to them,
     * rather than leave "I was, , thinking" or a leading comma. A whole run goes at once ("um, you know, I think"),
     * so no comma is left stranded between two. Six passes, in the desktop's order; each one's comment gives the
     * pattern it stands for (MARK is one of , ; : - and the two dashes, RUN is fillers and asides joined by
     * punctuation, FILLER is um, uh or hmm).
     */
    private fun removeFillers(text: String): String {
        val ends = IntBuf()
        var s = collapseDots(text)
        s = dropMarkedRuns(s, ends)
        s = dropYouKnowAfterWord(s)
        s = dropSentenceStartRuns(s, ends, false)
        s = dropSentenceStartRuns(s, ends, true)
        s = dropRunsBeforeStop(s, ends)
        s = dropBareFillers(s)
        return restoreCapitalsAfterGaps(s).replace(DOTS.toString(), "...")
    }

    /** `\.{3,}` becomes one character, so a filler takes all of its ellipsis or none of it. */
    private fun collapseDots(s: String): String {
        val n = s.length
        val out = StringBuilder(n)
        var i = 0
        while (i < n) {
            if (s[i] == '.') {
                var j = i
                while (j < n && s[j] == '.') j++
                if (j - i >= 3) out.append(DOTS) else out.append(s, i, j)
                i = j
            } else {
                out.append(s[i])
                i++
            }
        }
        return out.toString()
    }

    /**
     * `\s*MARK\s*RUN(?:\s*MARK|(?<=[DOTS…]))\s*`: a run of fillers closed off by a comma or by its own ellipsis.
     * Goes, with its commas, unless it sits next to "like", "I mean", "kind of" or "sort of", which keep one comma.
     */
    private fun dropMarkedRuns(s: String, ends: IntBuf): String {
        val n = s.length
        val out = StringBuilder(n)
        var pos = 0
        var q = 0
        while (q < n) {
            if (!isMark(s[q])) {
                q++
                continue
            }
            runEnds(s, skipWs(s, q + 1), true, ends)
            var matchEnd = -1
            var t = ends.size
            while (t >= 1 && matchEnd < 0) {
                val e = ends[t - 1]
                val k = skipWs(s, e)
                if (k < n && isMark(s[k])) {
                    matchEnd = skipWs(s, k + 1)
                } else if (s[e - 1] == DOTS || s[e - 1] == ELLIPSIS) {
                    matchEnd = k
                }
                t--
            }
            if (matchEnd < 0) {
                q++
                continue
            }
            var start = q
            while (start > pos && isJsSpace(s[start - 1])) start--
            out.append(s, pos, start)
            if (keptAsideFollows(s, matchEnd) || keptAsidePrecedes(s, start)) {
                out.append(", ")
            } else {
                out.append(' ').append(GAP).append(' ')
            }
            pos = matchEnd
            q = matchEnd
        }
        out.append(s, pos, n)
        return out.toString()
    }

    /**
     * `(?<=[\p{L}\p{N}])[ \t]+You know\s*MARK\s*`: the engine opens a sentence at "You know," with no stop before
     * it ("when it You know, the mouse"), and the capital marks it off instead.
     */
    private fun dropYouKnowAfterWord(s: String): String {
        val n = s.length
        val out = StringBuilder(n)
        var pos = 0
        var i = 0
        while (i < n) {
            val c = s[i]
            if ((c == ' ' || c == '\t') && i > 0 && isLetterOrNumber(Character.codePointBefore(s, i))) {
                var j = i
                while (j < n && (s[j] == ' ' || s[j] == '\t')) j++
                if (s.startsWith("You know", j)) {
                    val k = skipWs(s, j + 8)
                    if (k < n && isMark(s[k])) {
                        out.append(s, pos, i).append(' ').append(GAP).append(' ')
                        pos = skipWs(s, k + 1)
                        i = pos
                        continue
                    }
                }
                i = j
                continue
            }
            i++
        }
        out.append(s, pos, n)
        return out.toString()
    }

    /**
     * `(^|[.!?]\s+|\n)RUN\s*MARK\s*` and, with [fillersOnly], `(^|[.!?]\s+|\n)FILLER_RUN\s*MARK?\s*`: at a sentence
     * start "you know" needs its comma to count as an aside ("You know, I think"); a sound goes with or without one.
     * What comes before the run (the start, the stop and its spaces, or the line break) stays.
     */
    private fun dropSentenceStartRuns(s: String, ends: IntBuf, fillersOnly: Boolean): String {
        val n = s.length
        val out = StringBuilder(n)
        var pos = 0
        var p = 0
        while (p < n) {
            var end = -1
            var keepEnd = p
            if (p == 0) end = sentenceRunEnd(s, 0, ends, fillersOnly)
            if (end < 0 && (s[p] == '.' || s[p] == '!' || s[p] == '?')) {
                val w = skipWs(s, p + 1)
                if (w > p + 1) {
                    end = sentenceRunEnd(s, w, ends, fillersOnly)
                    keepEnd = w
                }
            }
            if (end < 0 && s[p] == '\n') {
                end = sentenceRunEnd(s, p + 1, ends, fillersOnly)
                keepEnd = p + 1
            }
            if (end < 0) {
                p++
                continue
            }
            out.append(s, pos, keepEnd)
            pos = end
            p = end
        }
        out.append(s, pos, n)
        return out.toString()
    }

    /** Where the run that starts at [r] and the punctuation after it end, or -1 when there is no match. */
    private fun sentenceRunEnd(s: String, r: Int, ends: IntBuf, fillersOnly: Boolean): Int {
        val n = s.length
        runEnds(s, r, !fillersOnly, ends)
        if (ends.size == 0) return -1
        if (fillersOnly) {
            // The punctuation is optional here, so the whole chain of fillers goes.
            var k = skipWs(s, ends[ends.size - 1])
            if (k < n && isMark(s[k])) k++
            return skipWs(s, k)
        }
        var t = ends.size
        while (t >= 1) {
            val k = skipWs(s, ends[t - 1])
            if (k < n && isMark(s[k])) return skipWs(s, k + 1)
            t--
        }
        return -1
    }

    /**
     * `\s*MARK\s*RUN(?=\s*(?:[.!?]|$))`: a run of fillers, with the comma in front of it, at the end of a sentence.
     */
    private fun dropRunsBeforeStop(s: String, ends: IntBuf): String {
        val n = s.length
        val out = StringBuilder(n)
        var pos = 0
        var q = 0
        while (q < n) {
            if (!isMark(s[q])) {
                q++
                continue
            }
            runEnds(s, skipWs(s, q + 1), true, ends)
            var matchEnd = -1
            var t = ends.size
            while (t >= 1 && matchEnd < 0) {
                val e = ends[t - 1]
                val k = skipWs(s, e)
                if (k >= n || s[k] == '.' || s[k] == '!' || s[k] == '?') matchEnd = e
                t--
            }
            if (matchEnd < 0) {
                q++
                continue
            }
            var start = q
            while (start > pos && isJsSpace(s[start - 1])) start--
            out.append(s, pos, start)
            pos = matchEnd
            q = matchEnd
        }
        out.append(s, pos, n)
        return out.toString()
    }

    /** `[ \t]*FILLER(?:[ \t]*MARK)?`: any filler still left, with the comma after it. */
    private fun dropBareFillers(s: String): String {
        val n = s.length
        val out = StringBuilder(n)
        var pos = 0
        var i = 0
        while (i < n) {
            val c = s[i]
            if (c == 'u' || c == 'U' || c == 'h' || c == 'H') {
                val e = fillerEnd(s, i)
                if (e >= 0) {
                    var start = i
                    while (start > pos && (s[start - 1] == ' ' || s[start - 1] == '\t')) start--
                    var k = e
                    while (k < n && (s[k] == ' ' || s[k] == '\t')) k++
                    val matchEnd = if (k < n && isMark(s[k])) k + 1 else e
                    out.append(s, pos, start).append(' ').append(GAP).append(' ')
                    pos = matchEnd
                    i = matchEnd
                    continue
                }
            }
            i++
        }
        out.append(s, pos, n)
        return out.toString()
    }

    /**
     * The end of every item of the run that starts at [start]: `ITEM(?:\s*MARK?\s*ITEM)*`. The items and what
     * separates them are fixed by the text, so the desktop's backtracking over the separators (exponential in
     * the number of items) finds no alternatives; only how many items to keep is open, and the caller picks that.
     */
    private fun runEnds(s: String, start: Int, asides: Boolean, ends: IntBuf) {
        ends.clear()
        var e = itemEnd(s, start, asides)
        while (e >= 0) {
            ends.add(e)
            var k = skipWs(s, e)
            if (k < s.length && isMark(s[k])) k = skipWs(s, k + 1)
            e = itemEnd(s, k, asides)
        }
    }

    private fun itemEnd(s: String, at: Int, asides: Boolean): Int {
        if (at >= s.length) return -1
        val filler = fillerEnd(s, at)
        return if (filler >= 0 || !asides) filler else asideEnd(s, at)
    }

    /**
     * `(?<![\p{L}\p{N}_'’-])(?:[Uu](?:m+|h+m*)|[Hh]m+)(?![\p{L}\p{N}_'’-])[\uE301…]?`. Not in capitals (UM, UH
     * and HMM are acronyms) and not joined by a hyphen ("uh-huh" and "mm-hmm" are answers). A trailing ellipsis is
     * part of the filler.
     */
    private fun fillerEnd(s: String, at: Int): Int {
        val n = s.length
        if (at >= n || wordCharBefore(s, at)) return -1
        var t = at + 1
        when (s[at]) {
            'U', 'u' -> {
                if (t < n && s[t] == 'm') {
                    while (t < n && s[t] == 'm') t++
                } else if (t < n && s[t] == 'h') {
                    while (t < n && s[t] == 'h') t++
                    while (t < n && s[t] == 'm') t++
                } else {
                    return -1
                }
            }
            'H', 'h' -> {
                if (t < n && s[t] == 'm') {
                    while (t < n && s[t] == 'm') t++
                } else {
                    return -1
                }
            }
            else -> return -1
        }
        if (wordCharAt(s, t)) return -1
        if (t < n && (s[t] == DOTS || s[t] == ELLIPSIS)) t++
        return t
    }

    /**
     * `(?<![\p{L}\p{N}_'’-])[Yy]ou know(?![\p{L}\p{N}_'’-])`: "you know" is the one spoken aside that goes, and
     * only where punctuation marks it off: "I was, you know, thinking". Bare it is part of the sentence ("you know
     * I'm right") and stays.
     */
    private fun asideEnd(s: String, at: Int): Int {
        if (wordCharBefore(s, at)) return -1
        if (!s.startsWith("You know", at) && !s.startsWith("you know", at)) return -1
        val t = at + 8
        return if (wordCharAt(s, t)) -1 else t
    }

    /** `[\p{L}\p{N}_'’-]`: what makes "um" part of a longer word or a contraction. */
    private fun isFillerGuard(cp: Int): Boolean =
        isLetter(cp) || isNumber(cp) || cp == '_'.code || cp == '\''.code || cp == CURLY_APOSTROPHE.code || cp == '-'.code

    private fun wordCharBefore(s: String, at: Int): Boolean = at > 0 && isFillerGuard(Character.codePointBefore(s, at))

    private fun wordCharAt(s: String, at: Int): Boolean = at < s.length && isFillerGuard(Character.codePointAt(s, at))

    /** `^(?:like|I mean|kind of|sort of)\s*MARK` at [from]. */
    private fun keptAsideFollows(s: String, from: Int): Boolean {
        for (phrase in KEPT_ASIDES) {
            if (regionMatchesFolded(s, from, phrase)) {
                val k = skipWs(s, from + phrase.length)
                if (k < s.length && isMark(s[k])) return true
            }
        }
        return false
    }

    /** `MARK\s*(?:like|I mean|kind of|sort of)$` on the text before [end]. */
    private fun keptAsidePrecedes(s: String, end: Int): Boolean {
        for (phrase in KEPT_ASIDES) {
            if (!regionMatchesFolded(s, end - phrase.length, phrase)) continue
            var b = end - phrase.length
            while (b > 0 && isJsSpace(s[b - 1])) b--
            if (b > 0 && isMark(s[b - 1])) return true
        }
        return false
    }

    /** Case-insensitive the way a Unicode-aware JavaScript pattern is: K and the long s fold onto k and s too. */
    private fun regionMatchesFolded(s: String, at: Int, lowerPhrase: String): Boolean {
        if (at < 0 || at + lowerPhrase.length > s.length) return false
        for (t in lowerPhrase.indices) {
            val c = s[at + t]
            val lower = lowerPhrase[t]
            if (c == lower) continue
            if (lower !in 'a'..'z') return false
            val folds = c.code == lower.code - 32 ||
                (lower == 'k' && c == '\u212A') ||
                (lower == 's' && c == '\u017F')
            if (!folds) return false
        }
        return true
    }

    /**
     * The engine capitalises the word after a filler as if a sentence started there: "should be, you know, Add a
     * section". With the filler gone, an everyday word in the middle of a sentence goes back to lower case. Every
     * GAP that is left becomes a plain space.
     */
    private fun restoreCapitalsAfterGaps(text: String): String {
        val n = text.length
        val out = StringBuilder(n)
        var copied = 0
        var i = 0
        while (i < n) {
            if (text[i] != GAP) {
                i++
                continue
            }
            var j = i + 1
            while (j < n && (text[j] == GAP || isJsSpace(text[j]))) j++
            val end = capitalWordEnd(text, j)
            if (end < 0) {
                // Every other GAP in this run leads to the same place.
                i = j
                continue
            }
            var before = i
            while (before > 0 && (text[before - 1] == GAP || isJsSpace(text[before - 1]))) before--
            var lineStart = i
            while (lineStart > 0 && (text[lineStart - 1] == ' ' || text[lineStart - 1] == '\t')) lineStart--
            val startsSentence = before == 0 ||
                (lineStart > 0 && text[lineStart - 1] == '\n') ||
                endsSentenceBefore(text, before)
            val word = text.substring(j, end)
            if (!startsSentence && isEverydayWord(word) && word.lowercase(Locale.ROOT) !in MODAL_NAMES) {
                out.append(text, copied, i).append(' ').append(lowerFirst(word))
                copied = end
            }
            i = end
        }
        out.append(text, copied, n)
        return out.toString().replace(GAP, ' ')
    }

    /**
     * `\p{Lu}\p{Ll}*(?:['’]\p{Ll}+)?(?![\p{L}\p{N}_])` at [from]: a word written with only its first letter
     * capitalised, as the engine writes a sentence start. Returns its end, or -1.
     */
    private fun capitalWordEnd(s: String, from: Int): Int {
        val n = s.length
        if (from >= n) return -1
        val first = Character.codePointAt(s, from)
        if (!isUpper(first)) return -1
        val j = skipLower(s, from + Character.charCount(first))
        if (j < n && (s[j] == '\'' || s[j] == CURLY_APOSTROPHE)) {
            val m = skipLower(s, j + 1)
            // "Don't" ends after the t; when something word-like follows it, the match falls back to "Don".
            if (m > j + 1 && !isWordLikeAt(s, m)) return m
            return j
        }
        return if (isWordLikeAt(s, j)) -1 else j
    }

    private fun isWordLikeAt(s: String, at: Int): Boolean = at < s.length && isWordLike(Character.codePointAt(s, at))

    private fun skipLower(s: String, from: Int): Int {
        var i = from
        while (i < s.length) {
            val cp = Character.codePointAt(s, i)
            if (!isLower(cp)) break
            i += Character.charCount(cp)
        }
        return i
    }

    // -- Tidying ------------------------------------------------------------------------------------------------

    /**
     * Spaces and the punctuation filler removal leaves behind: no space before a stop or comma, no doubled commas,
     * no comma that opens a sentence or sits in front of a stop, and a space after a comma that has none.
     */
    private fun tidyAfterFillerRemoval(text: String): String {
        var s = collapseSpaces(text)
        s = closeUpBeforeStops(s)
        s = mergeRepeatedMarks(s)
        s = dropOpeningMarks(s)
        s = dropMarksBeforeStops(s)
        s = spaceAfterMarks(s)
        return jsTrim(s)
    }

    /** `\s+([,.;:!?])` becomes the punctuation alone. */
    private fun closeUpBeforeStops(s: String): String {
        val n = s.length
        val out = StringBuilder(n)
        var i = 0
        while (i < n) {
            if (isJsSpace(s[i])) {
                val e = skipWs(s, i)
                if (e >= n || !isStopOrComma(s[e])) out.append(s, i, e)
                i = e
            } else {
                out.append(s[i])
                i++
            }
        }
        return out.toString()
    }

    /** `([,;:])(?:\s*[,;:])+` becomes the first of them. */
    private fun mergeRepeatedMarks(s: String): String {
        val n = s.length
        val out = StringBuilder(n)
        var i = 0
        while (i < n) {
            val c = s[i]
            if (isSoftMark(c)) {
                var j = i + 1
                while (true) {
                    val k = skipWs(s, j)
                    if (k < n && isSoftMark(s[k])) j = k + 1 else break
                }
                out.append(c)
                i = j
            } else {
                out.append(c)
                i++
            }
        }
        return out.toString()
    }

    /** `(^|[.!?]\s+)[,;:]\s*` loses the comma that opens a sentence. */
    private fun dropOpeningMarks(s: String): String {
        val n = s.length
        val out = StringBuilder(n)
        var copied = 0
        var i = 0
        while (i < n) {
            if (i == 0 && isSoftMark(s[0])) {
                copied = skipWs(s, 1)
                i = copied
                continue
            }
            if (s[i] == '.' || s[i] == '!' || s[i] == '?') {
                val w = skipWs(s, i + 1)
                if (w > i + 1 && w < n && isSoftMark(s[w])) {
                    out.append(s, copied, w)
                    copied = skipWs(s, w + 1)
                    i = copied
                    continue
                }
            }
            i++
        }
        out.append(s, copied, n)
        return out.toString()
    }

    /** `[,;:]\s*([.!?])` loses the comma in front of a stop. */
    private fun dropMarksBeforeStops(s: String): String {
        val n = s.length
        val out = StringBuilder(n)
        var i = 0
        while (i < n) {
            val c = s[i]
            if (isSoftMark(c)) {
                val k = skipWs(s, i + 1)
                if (k < n && (s[k] == '.' || s[k] == '!' || s[k] == '?')) {
                    out.append(s[k])
                    i = k + 1
                    continue
                }
            }
            out.append(c)
            i++
        }
        return out.toString()
    }

    /** `([,;:])(?=[A-Za-z])` gets a space after it. */
    private fun spaceAfterMarks(s: String): String {
        val n = s.length
        val out = StringBuilder(n + 8)
        for (i in 0 until n) {
            out.append(s[i])
            if (isSoftMark(s[i]) && i + 1 < n && isAsciiLetter(s[i + 1])) out.append(' ')
        }
        return out.toString()
    }

    private fun isSoftMark(c: Char): Boolean = c == ',' || c == ';' || c == ':'

    private fun isStopOrComma(c: Char): Boolean = isSoftMark(c) || c == '.' || c == '!' || c == '?'

    /** `[ \t]+` to one space, `[ ]*\n[ ]*` to a line break, trimmed (the desktop's `collapseSpaces`). */
    private fun collapseSpaces(text: String): String {
        val once = StringBuilder(text.length)
        var i = 0
        while (i < text.length) {
            val c = text[i]
            if (c == ' ' || c == '\t') {
                while (i < text.length && (text[i] == ' ' || text[i] == '\t')) i++
                once.append(' ')
            } else {
                once.append(c)
                i++
            }
        }
        val out = StringBuilder(once.length)
        for (k in 0 until once.length) {
            val c = once[k]
            val besideBreak = (k > 0 && once[k - 1] == '\n') || (k + 1 < once.length && once[k + 1] == '\n')
            if (c == ' ' && besideBreak) continue
            out.append(c)
        }
        return jsTrim(out.toString())
    }

    // -- Capitals -----------------------------------------------------------------------------------------------

    /**
     * Small words the engine capitalises mid-sentence as if one had started there: "also Let's update", "you Don't
     * update". Only with a lower-case word on both sides: a capital beside it makes it part of a title or a name
     * ("turn on Do Not Disturb", "watching The Office").
     */
    private fun lowerStrayCapitals(text: String): String {
        val n = text.length
        var out: StringBuilder? = null
        var copied = 0
        var i = 0
        while (i < n) {
            val cp = Character.codePointAt(text, i)
            val next = i + Character.charCount(cp)
            if (!isUpper(cp) || !followsLowerWord(text, i)) {
                i = next
                continue
            }
            val j = skipLower(text, next)
            var end = j
            if (j < n && (text[j] == '\'' || text[j] == CURLY_APOSTROPHE)) {
                val m = skipLower(text, j + 1)
                if (m > j + 1) end = m
            }
            var k = end
            while (k < n && (text[k] == ' ' || text[k] == '\t')) k++
            if (k == end || k >= n || !isLower(Character.codePointAt(text, k))) {
                i = next
                continue
            }
            val word = text.substring(i, end)
            if (contractionBase(word) in FUNCTION_WORDS) {
                if (out == null) out = StringBuilder(n)
                out.append(text, copied, i).append(lowerFirst(word))
                copied = end
            }
            i = end
        }
        if (out == null) return text
        out.append(text, copied, n)
        return out.toString()
    }

    /** `(?<=\p{Ll}[,;:]?[ \t]+)` in front of [i]. */
    private fun followsLowerWord(text: String, i: Int): Boolean {
        var b = i
        while (b > 0 && (text[b - 1] == ' ' || text[b - 1] == '\t')) b--
        if (b == i) return false
        if (b > 0 && isSoftMark(text[b - 1])) b--
        return b > 0 && isLower(Character.codePointBefore(text, b))
    }

    /** The pronoun, on its own or in I'm/I'll, never the i of "i.e.". */
    private fun capitalizePronoun(text: String): String {
        val n = text.length
        var out: StringBuilder? = null
        for (i in 0 until n) {
            if (text[i] != 'i') continue
            if (i > 0) {
                val b = Character.codePointBefore(text, i)
                if (isWordLike(b) || b == '.'.code || b == '\''.code || b == CURLY_APOSTROPHE.code || b == '-'.code) continue
            }
            if (i + 1 < n) {
                val a = Character.codePointAt(text, i + 1)
                if (isWordLike(a) || a == '-'.code) continue
                if (a == '.'.code && i + 2 < n && isLetter(Character.codePointAt(text, i + 2))) continue
            }
            if (out == null) out = StringBuilder(text)
            out.setCharAt(i, 'I')
        }
        return out?.toString() ?: text
    }

    private enum class StartMode { CAPITALIZE, LOWER }

    /**
     * The first word of every sentence and of every line goes to the tone's change: capitalised, or for Very casual
     * lower-cased where it is an everyday word. After an ellipsis or a short form ("p.m.", "etc.") the engine's own
     * capital is what says a new sentence began. The desktop's one pattern is
     * `^(\s*)(WORD)|([.!?…]+[)"'”’]*)(\s+)(WORD)|(\n)([ \t]*)(WORD)` with WORD = `\p{L}[\p{L}\p{M}\p{N}'’_-]*`.
     */
    private fun mapSentenceStarts(text: String, mode: StartMode): String {
        val n = text.length
        val out = StringBuilder(n)
        var copied = 0
        var i = 0
        while (i < n) {
            if (i == 0) {
                val k = skipWs(text, 0)
                val we = sentenceWordEnd(text, k)
                if (we >= 0) {
                    out.append(text, copied, k).append(changeStart(text, k, we, mode))
                    copied = we
                    i = we
                    continue
                }
            }
            val c = text[i]
            if (isSentenceStop(c)) {
                var stopEnd = i
                while (stopEnd < n && isSentenceStop(text[stopEnd])) stopEnd++
                var closeEnd = stopEnd
                while (closeEnd < n && isCloser(text[closeEnd])) closeEnd++
                val gapEnd = skipWs(text, closeEnd)
                val we = if (gapEnd > closeEnd) sentenceWordEnd(text, gapEnd) else -1
                if (we < 0) {
                    // Any start further into this run sees the same text after it.
                    i = stopEnd
                    continue
                }
                if (hasLineBreak(text, closeEnd, gapEnd) ||
                    endsSentenceBefore(text, closeEnd) ||
                    isUpper(Character.codePointAt(text, gapEnd))
                ) {
                    out.append(text, copied, gapEnd).append(changeStart(text, gapEnd, we, mode))
                    copied = we
                }
                i = we
                continue
            }
            if (c == '\n') {
                var k = i + 1
                while (k < n && (text[k] == ' ' || text[k] == '\t')) k++
                val we = sentenceWordEnd(text, k)
                if (we >= 0) {
                    out.append(text, copied, k).append(changeStart(text, k, we, mode))
                    copied = we
                    i = we
                    continue
                }
            }
            i++
        }
        out.append(text, copied, n)
        return out.toString()
    }

    private fun isSentenceStop(c: Char): Boolean = c == '.' || c == '!' || c == '?' || c == ELLIPSIS

    private fun hasLineBreak(s: String, from: Int, to: Int): Boolean {
        for (i in from until to) if (s[i] == '\n') return true
        return false
    }

    /** `\p{L}[\p{L}\p{M}\p{N}'’_-]*` at [from]: the end of the word, or -1 when no word starts there. */
    private fun sentenceWordEnd(s: String, from: Int): Int {
        val n = s.length
        if (from >= n) return -1
        val first = Character.codePointAt(s, from)
        if (!isLetter(first)) return -1
        var j = from + Character.charCount(first)
        while (j < n) {
            val cp = Character.codePointAt(s, j)
            val inWord = isLetter(cp) || isMarkCp(cp) || isNumber(cp) ||
                cp == '\''.code || cp == CURLY_APOSTROPHE.code || cp == '_'.code || cp == '-'.code
            if (!inWord) break
            j += Character.charCount(cp)
        }
        return j
    }

    private fun changeStart(text: String, start: Int, end: Int, mode: StartMode): String {
        val word = text.substring(start, end)
        return when (mode) {
            StartMode.CAPITALIZE -> capitalizeWord(word)
            StartMode.LOWER -> lowerSentenceStart(word, text, end)
        }
    }

    /**
     * A word with a capital inside it was written that way on purpose (iPhone, eBay, macOS) and keeps its spelling
     * at the start of a sentence too.
     */
    private fun capitalizeWord(word: String): String {
        if (!isLower(Character.codePointAt(word, 0))) return word
        var i = 1
        while (i < word.length) {
            val cp = Character.codePointAt(word, i)
            if (isUpper(cp)) return word
            i += Character.charCount(cp)
        }
        // The first UTF-16 unit only, as the desktop does: a letter outside the BMP is left as it is.
        return word.substring(0, 1).uppercase(Locale.ROOT) + word.substring(1)
    }

    private fun lowerFirst(word: String): String = word.substring(0, 1).lowercase(Locale.ROOT) + word.substring(1)

    /**
     * Very casual writes every sentence in lower case, except where the first word is a name: only an everyday word
     * loses its capital, so Alex, NASA, iPhone and a dictionary spelling keep theirs. "Will" and "May" lose theirs
     * only when a verb follows ("Will you check?", not "Will is here").
     */
    private fun lowerSentenceStart(word: String, text: String, restStart: Int): String {
        if (!isEverydayWord(word)) return word
        if (word.lowercase(Locale.ROOT) in MODAL_NAMES && !isFollowedByModalObject(text, restStart)) return word
        return lowerFirst(word)
    }

    /** `^\s*(?:i|you|we|they|he|she|it|this|that|there|the|a|an|my|...|not)\b`, ASCII letters in either case. */
    private fun isFollowedByModalObject(text: String, from: Int): Boolean {
        val start = skipWs(text, from)
        var end = start
        while (end < text.length && isAsciiWord(text[end])) end++
        if (end == start || end - start > 10) return false
        val sb = StringBuilder(end - start)
        for (i in start until end) sb.append(lowerAscii(text[i]))
        return sb.toString() in AFTER_MODAL_WORDS
    }

    /**
     * An ordinary English word written with only its first letter capitalised. "I" is never one: it is always
     * written that way.
     */
    private fun isEverydayWord(word: String): Boolean {
        if (!hasCapitalizedShape(word)) return false
        if (word == "I" || word.startsWith("I'") || word.startsWith("I\u2019")) return false
        val base = contractionBase(word)
        if (base in NAME_WORDS) return false
        return isKnownForm(base)
    }

    /** `^\p{Lu}\p{Ll}*(?:['’]\p{Ll}+)?$`. */
    private fun hasCapitalizedShape(word: String): Boolean {
        val n = word.length
        if (n == 0) return false
        val first = Character.codePointAt(word, 0)
        if (!isUpper(first)) return false
        val i = skipLower(word, Character.charCount(first))
        if (i == n) return true
        if (word[i] != '\'' && word[i] != CURLY_APOSTROPHE) return false
        val end = skipLower(word, i + 1)
        return end == n && end > i + 1
    }

    /** "don't" -> "do", "can't" -> "can", "Alex's" -> "alex": the word a contraction is made from. */
    private fun contractionBase(word: String): String {
        val w = word.lowercase(Locale.ROOT).replace(CURLY_APOSTROPHE, '\'')
        if (w.endsWith("n't")) {
            return when (val stem = w.dropLast(3)) {
                "ca" -> "can"
                "wo" -> "will"
                "sha" -> "shall"
                else -> stem
            }
        }
        for (suffix in CONTRACTION_SUFFIXES) {
            if (w.endsWith(suffix)) return w.dropLast(suffix.length)
        }
        return w
    }

    private val CONTRACTION_SUFFIXES: Array<String> = arrayOf("'s", "'re", "'ll", "'ve", "'d", "'m")

    private fun isKnownWord(word: String): Boolean = word in COMMON_WORDS || word in EVERYDAY_EXTRA

    /** A stem of one or two letters proves nothing (Ted, Ned). */
    private fun isKnownStem(stem: String): Boolean = stem.length > 2 && isKnownWord(stem)

    /** The word or a regular form of it: users, fixes, tried, moving, stopped, mainly, easily. */
    private fun isKnownForm(w: String): Boolean {
        if (isKnownWord(w)) return true
        if ((w.endsWith("ies") || w.endsWith("ied")) && isKnownStem(w.dropLast(3) + "y")) return true
        if (w.endsWith("ily") && isKnownStem(w.dropLast(3) + "y")) return true
        if (w.endsWith("es") && isKnownStem(w.dropLast(2))) return true
        if (w.endsWith("s") && isKnownStem(w.dropLast(1))) return true
        if (w.endsWith("ed") && (isKnownStem(w.dropLast(2)) || isKnownStem(w.dropLast(1)) || isKnownStem(w.dropLast(3)))) {
            return true
        }
        if (w.endsWith("ing") &&
            (isKnownStem(w.dropLast(3)) || isKnownStem(w.dropLast(3) + "e") || isKnownStem(w.dropLast(4)))
        ) {
            return true
        }
        return w.endsWith("ly") && isKnownStem(w.dropLast(2))
    }

    // -- Sentence ends ------------------------------------------------------------------------------------------

    /**
     * Whether the text before [end] ends a sentence. An ellipsis is a pause the speaker talked through, and dotted
     * short forms (p.m., e.g., U.S., Ph.D.) and abbreviations (Mr., etc.) keep their sentence going. Reads
     * backwards from [end] only as far as the last word, so a long text costs nothing.
     */
    private fun endsSentenceBefore(s: String, end: Int): Boolean {
        var e = end
        while (e > 0 && isCloser(s[e - 1])) e--
        if (e == 0) return false
        val last = s[e - 1]
        if (last == ELLIPSIS) return false
        if (last == '.' && e >= 2 && s[e - 2] == '.') return false
        if (last == '!' || last == '?') return true
        if (last != '.') return false
        var w = e
        while (w > 0 && !isJsSpace(s[w - 1])) w--
        if (isDottedInitialism(s, w, e)) return false
        // The longest abbreviation is six letters; anything longer cannot be one, whatever its case.
        if (e - 1 - w > 8) return true
        return s.substring(w, e - 1).lowercase(Locale.ROOT) !in ABBREVIATIONS
    }

    private fun isCloser(c: Char): Boolean = c == ')' || c == '"' || c == '\'' || c == '\u201D' || c == CURLY_APOSTROPHE

    /** `^(?:\p{L}{1,3}\.){2,}$` on [from, to): p.m., e.g., U.S., Ph.D. */
    private fun isDottedInitialism(s: String, from: Int, to: Int): Boolean {
        var i = from
        var groups = 0
        while (i < to) {
            var letters = 0
            while (i < to && letters < 4) {
                val cp = Character.codePointAt(s, i)
                if (!isLetter(cp)) break
                i += Character.charCount(cp)
                letters++
            }
            if (letters == 0 || letters > 3 || i >= to || s[i] != '.') return false
            i++
            groups++
        }
        return groups >= 2
    }

    /**
     * `(\S+)\.(?=[ \t]*(?:\n|$))`: the full stop that ends a line goes, when it ends a sentence. "?", "!", an
     * ellipsis and an abbreviation's own stop stay.
     */
    private fun dropClosingStops(s: String): String {
        val n = s.length
        val out = StringBuilder(n)
        var copied = 0
        var i = 0
        while (i < n) {
            if (isJsSpace(s[i])) {
                i++
                continue
            }
            var e = i
            while (e < n && !isJsSpace(s[e])) e++
            if (e - i >= 2 && s[e - 1] == '.') {
                var k = e
                while (k < n && (s[k] == ' ' || s[k] == '\t')) k++
                if ((k >= n || s[k] == '\n') && endsSentenceBefore(s, e)) {
                    out.append(s, copied, e - 1)
                    copied = e
                }
            }
            i = e
        }
        out.append(s, copied, n)
        return out.toString()
    }

    // -- Characters, the way JavaScript counts them -------------------------------------------------------------

    /** JavaScript's `\s` and `trim()`: Java's `\s` and Kotlin's `isWhitespace` are different sets. */
    private fun isJsSpace(c: Char): Boolean = when (c) {
        ' ', '\t', '\n', '\r', '\u000B', '\u000C', '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F',
        '\u3000', '\uFEFF' -> true
        else -> c in '\u2000'..'\u200A'
    }

    private fun skipWs(s: String, from: Int): Int {
        var i = from
        while (i < s.length && isJsSpace(s[i])) i++
        return i
    }

    private fun jsTrim(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && isJsSpace(s[a])) a++
        while (b > a && isJsSpace(s[b - 1])) b--
        return if (a == 0 && b == s.length) s else s.substring(a, b)
    }

    /** The final trim: whitespace by JavaScript's count or Kotlin's, so `trim()` on the result changes nothing. */
    private fun trimEdges(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && (isJsSpace(s[a]) || s[a].isWhitespace())) a++
        while (b > a && (isJsSpace(s[b - 1]) || s[b - 1].isWhitespace())) b--
        return s.substring(a, b)
    }

    /** `,` `;` `:` and the two dashes and the hyphen: the marks that set a filler off. */
    private fun isMark(c: Char): Boolean = isSoftMark(c) || c == '\u2013' || c == '\u2014' || c == '-'

    private fun isAsciiLetter(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z'

    private fun isAsciiDigit(c: Char): Boolean = c in '0'..'9'

    /** JavaScript's `\w`: ASCII letters, digits and the underscore, whatever the platform's Unicode rules say. */
    private fun isAsciiWord(c: Char): Boolean = isAsciiLetter(c) || isAsciiDigit(c) || c == '_'

    private fun lowerAscii(c: Char): Char = if (c in 'A'..'Z') c + 32 else c

    /** `\p{L}`. */
    private fun isLetter(cp: Int): Boolean = Character.isLetter(cp)

    /** `\p{Lu}`. */
    private fun isUpper(cp: Int): Boolean = Character.getType(cp) == Character.UPPERCASE_LETTER.toInt()

    /** `\p{Ll}`. */
    private fun isLower(cp: Int): Boolean = Character.getType(cp) == Character.LOWERCASE_LETTER.toInt()

    /** `\p{N}`: decimal digits of any script, letter numbers such as Ⅷ, and other numbers such as ½. */
    private fun isNumber(cp: Int): Boolean {
        val type = Character.getType(cp)
        return type == Character.DECIMAL_DIGIT_NUMBER.toInt() ||
            type == Character.LETTER_NUMBER.toInt() ||
            type == Character.OTHER_NUMBER.toInt()
    }

    /** `\p{M}`: combining marks. */
    private fun isMarkCp(cp: Int): Boolean {
        val type = Character.getType(cp)
        return type == Character.NON_SPACING_MARK.toInt() ||
            type == Character.COMBINING_SPACING_MARK.toInt() ||
            type == Character.ENCLOSING_MARK.toInt()
    }

    private fun isLetterOrNumber(cp: Int): Boolean = isLetter(cp) || isNumber(cp)

    /** A growable list of ints, so a run of fillers is not boxed one number at a time. */
    private class IntBuf {
        private var data = IntArray(16)
        var size = 0
            private set

        fun add(value: Int) {
            if (size == data.size) data = data.copyOf(size * 2)
            data[size++] = value
        }

        operator fun get(index: Int): Int = data[index]

        fun clear() {
            size = 0
        }
    }
}
