# Voxden Vocabulary Pack

A domain vocabulary + correction dictionary for Voxden's local Whisper pipeline.
Hand this whole file to a coding agent, or copy §7 straight into `data/dictionary.json`.

---

## 1. How Voxden actually uses vocabulary

Grounded in this repo, not guesswork:

| Fact | Where |
|---|---|
| Engine is `faster-whisper`, model `medium` (env `VOXDEN_MODEL`), CPU int8, `multilingual: True`, `beam_size: 1`, `condition_on_previous_text: False` | `sidecar/transcribe.py` |
| Transcript pipeline is `cleanup(raw)` **then** `applyDictionary(cleaned, phrases)` | `src/main.js:502-503` |
| Dictionary file is `data/dictionary.json`, shape `{ "phrases": [ { "from": "...", "to": "..." } ] }` | `src/dictionary.js` `load` / `save` |
| Replacement is a case-insensitive global regex with `\b` on both ends, applied **longest `from` first** | `src/dictionary.js` `applyDictionary` |
| Whisper's `initial_prompt` is built from the **`to` side** of the dictionary, de-duplicated case-insensitively, **capped at 64 terms**, joined with `, ` | `src/dictionary.js` `promptFrom` |
| Frequent words from history only join the prompt after 2500 words of history (`Personalized` profile) | `src/dictionary.js` `UNDERSTANDING_PROFILES` |

**The one thing to understand:** every dictionary entry fixes text after the fact, but only the **first 64 unique `to` values** also get fed to Whisper as an acoustic hint. So ordering inside `phrases` is a real setting, not cosmetic. Put your highest-value proper nouns at the top of the array.

Corollary worth knowing: ten `from` variants that all point at `"Seedance"` consume **one** of those 64 slots, because `promptFrom` de-dupes on `to`. Variants are cheap. Add lots.

### What NOT to do

Do not stuff general English into this file. Whisper `medium` already has all of it. The `initial_prompt` window is roughly 224 tokens (half of Whisper's 448-token text context — that comes from Whisper's decoder design, I have not measured it in your build), and padding it with ordinary words both wastes slots and pushes the decoder toward inserting prompt words that were never spoken. A vocabulary file earns its keep on **out-of-distribution proper nouns only**: product names, your project names, jargon, acronyms.

---

## 2. Hard rules for editing the dictionary

Each rule exists because of a specific behaviour in `src/dictionary.js`.

1. **`from` and `to` must start and end with an alphanumeric character.** The matcher wraps both ends in `\b`. A `from` of `"c."` or `"-ish"` will never fire.
2. **Never put a dollar sign in a `to` value.** `String.replace` treats dollar-prefixed sequences as substitution patterns and will mangle the output.
3. **Matching is case-insensitive; output takes the exact casing of `to`.** One entry `"sea dance"` → `"Seedance"` already handles `Sea dance`, `SEA DANCE` and `sea Dance`. Never write casing variants as separate rows.
4. **Never map a common English word on its own.** There is no context gating in this app. `"get"` → `"git"` will rewrite every "get" you ever dictate. Encode the context into a multi-word `from` instead (see §5) — longest-first sorting makes that safe.
5. **Avoid these words inside `from`: period, comma, full stop, question mark, exclamation mark, new line, new paragraph, newline, scratch that.** `cleanup()` runs first and has already turned them into punctuation, so the phrase can never match. (`src/cleanup.js` `applyVoiceCommands`)
6. **Assume the text is already sentence-capitalized and space-tidied** when your rule runs. Don't write `from` values that depend on double spaces or a lowercase sentence start.
7. **One canonical spelling per concept.** If `"Seedance"` and `"SeeDance"` both appear as `to` values they eat two of the 64 prompt slots and fight each other.
8. **Longest `from` wins.** `"sea dance 2.5"` → `"Seedance 2.5"` is applied before `"sea dance"` → `"Seedance"`, so both can coexist safely. Position in the file does not affect matching — only prompt priority.

---

## 3. Tier 1 — the prompt-bias 64

These sit **first** in the array in §7, in this exact order, and they are precisely the 64 unique `to` values that reach Whisper's `initial_prompt`. Verified: `promptFrom` on the §7 seed returns these 64 and nothing else.

Selection is biased toward what you actually dictate — your own stack and project names — not toward every model that exists. Anything demoted to §4 still gets corrected in text; it just does not get an acoustic hint.

### AI video and image models (23)

| Canonical (`to`) | What Whisper writes (`from` candidates) |
|---|---|
| Seedance | sea dance, see dance, C dance, seed dance, cedance, sea dancer, sedan's |
| Seedance 2.5 | sea dance 2.5, see dance 2.5, C dance 2.5, sea dance two point five, see dance to point five |
| Higgsfield | Higgs field, hicks field, higgs feild, big field, hicksfield, his field, hex field |
| Nano Banana | nano bandana, nine o banana, nanobanana |
| Nano Banana Pro | nano bandana pro, N B P |
| Seedream | sea dream, see dream, C dream, seed dream |
| Jimeng | jimming, gee meng, ji meng, jamming, jemeng |
| Kling | klink, klingon (see §5 for "cling") |
| Veo | vio, vayo, vayoh |
| ComfyUI | comfy you I, comfy U I, comfy why |
| ControlNet | control net, controlled net |
| LoRA | lower a, l o r a (see §5 for "Laura") |
| VAE | V A E, vee ay ee |
| CFG | see if G, C F G |
| img2img | image to image, img to img |
| inpaint | in paint, empaint |
| outpaint | out paint |
| upscaler | up scaler, upscale er |
| keyframe | key frame |
| Soul ID | sole ID, soul I D, sol ID |
| Soul Character | sole character, soul karakter |
| SDXL | SD XL, esdexel |
| Stable Diffusion | stable fusion |

### Your projects (12)

| Canonical (`to`) | `from` candidates |
|---|---|
| Voxden | vox den, box den, folks den, walks den, fox den, voxton |
| Jarvis | java's, drive us (see §6 for "service") |
| MoGfx | mo GFX, mow G F X, mogul FX, moe graphics |
| RefBoard | ref board, rev board, red board |
| DeskPets | desk pets, disk pets, desk bets |
| Margo | margot, marco (see §5 for "mango") |
| Sakhi | sucky, saki, socky, soggy, sakhee |
| SeqSort | sec sort, seek sort, sex sort, sequel sort |
| CineGrade | cine grade, cinnagrade, sin a grade, scene grade |
| Thakumar Jhuli | thakur mar jhuli, taku mar julie, thak mar jhuli, thakumar julie |
| Sounak | so knock, sunak, sonic, sownak |
| Dobby Ads | dobby adds, dobie ads |

### Dev and tooling (18)

| Canonical (`to`) | `from` candidates |
|---|---|
| Claude Code | cloud code, clod code, claud code, closed code, clawed code |
| Anthropic | entropic, anthropik |
| faster-whisper | faster whisper, fast whisper |
| CUDA | kuda, cooter, coup da |
| PyTorch | pie torch, py torch |
| ONNX | O N N X, onyx runtime |
| Vite | veet, vight, veete |
| Tailwind | tail wind, tailwynd |
| Supabase | super base, soup a base, supa base |
| SQLite | sequel light, SQL light, ess Q light |
| npm | N P M, enpeeem |
| TypeScript | type script, typed script |
| GitHub | git hub, get hub |
| localhost | local host |
| webhook | web hook |
| regex | reg ex, rejects pattern |
| Ollama | oh llama, o lama, alarma, olama |
| JSON | jay son (see §5 for "Jason") |

### Motion, cinematography and script (11)

| Canonical (`to`) | `from` candidates |
|---|---|
| After Effects | after effect, after fx |
| ExtendScript | extend script, extended script |
| MOGRT | mogurt, mo gurt, mogert |
| Premiere Pro | premier pro |
| DaVinci Resolve | da vinci resolve, the vinci resolve |
| ProRes | pro res, pro rez |
| ARRI Alexa | ari alexa, aria alexa, our re alexa |
| anamorphic | anna morphic, anamorfic |
| gimbal | gimble, jimble, gymbal |
| bokeh | bokay (see §5 for "bouquet") |
| Devanagari | deva nagari, developer gary, devanagri |

That is the acoustic-hint budget, fully spent. Everything below still corrects text — it just does not reach Whisper's prompt.

---

## 4. Tier 2 — text-correction only

Append these after Tier 1. They fire on every transcript but consume no prompt slots. Several are models you use rarely; promote any of them into §3 the moment that changes, and demote something else to keep the count at 64.

| Canonical (`to`) | `from` candidates |
|---|---|
| Seedance 2 | sea dance 2, see dance two, C dance 2, sea dance too |
| Sora | saura, sorer, surah |
| Runway | run way, runway M L |
| Hailuo | high loo, hi luo, hailou |
| MiniMax | mini max, many max |
| Luma | looma, lumen |
| Pika | peaka, pica, pika labs |
| Hunyuan | hun yuan, hoon you an |
| Wan 2.2 | wan 2.2, one 2.2, juan 2.2, wand 2.2 |
| Midjourney | mid journey, mid-journey |
| Flux | fluke model, flex model |
| i2v | I to V, i 2 v |
| t2v | T to V, t 2 v |
| Opus | opis |
| Electron | electro |
| Expo | ex po |
| npx | N P X |
| React Native | react native |
| MCP | M C P |
| VRAM | V RAM, vee ram |
| LUT | loot file, L U T |
| FPV | F P V |
| speed ramp | speed-ramp, speedramp |
| rack focus | wrack focus |
| dolly zoom | dolly-zoom |
| b-roll | be roll, bee roll |
| YAML | yamal, ya mal |
| SSML | S S M L |
| diarization | diarisation, diary zation |
| VAD | V A D |
| WAV | wave file |
| 16 kHz | sixteen kilohertz, sixteen K hertz |
| lip sync | lipsync, lip-sync, lip synch |
| ElevenLabs | eleven labs, 11 labs |
| Coqui | coke we, koki, kokey |
| Piper TTS | piper T T S, pipe or TTS |
| Vosk | vosque, bosk, mosque model |
| ScriptUI | script you I, script U I |
| UXP | U X P |
| precomp | pre comp |
| track matte | track mat, track mate |
| rotoscope | roto scope, rotor scope |
| graph editor | graph editer |
| render queue | render q, render cue |
| chiaroscuro | kiaroscuro, chiaro scuro |
| depth of field | death of field |
| f-stop | F stop, eff stop |
| 35mm | thirty five mil, thirty-five millimeter |
| Rec.709 | rec 709, wreck 709, rec seven o nine |
| S-Log | S log, ess log |
| 4K | four K, for K |
| 8K | eight K, ate K |
| 9:16 | nine by sixteen, 9 by 16 |
| 16:9 | sixteen by nine, 16 by 9 |
| fps | frames per second, F P S |
| Bengali | bangali, bengoli |
| kahani | kahaani |
| rakshasa | rock shasa, rakshas |
| byangoma | bang goma, byan goma |
| PCOS | P C O S (see §5 for "peacocks") |
| Blender | blendar |
| Figma | fig ma |
| DaVinci | da vinci |

---

## 5. Context-gated entries

These canonical terms sound exactly like common English words. Voxden has **no context gating**, so the only safe way to encode them is a multi-word `from`. Longest-first sorting means these fire before any shorter rule.

| Risk word | Safe multi-word entries (`from` → `to`) |
|---|---|
| get / git | get commit → git commit · get push → git push · get pull → git pull · get status → git status · get branch → git branch · get merge → git merge · get rebase → git rebase · get clone → git clone · get ignore → gitignore |
| Laura / LoRA | Laura training → LoRA training · train a Laura → train a LoRA · Laura file → LoRA file · Laura weights → LoRA weights · Laura model → LoRA model |
| Jason / JSON | Jason file → JSON file · Jason format → JSON format · Jason payload → JSON payload · Jason schema → JSON schema · parse Jason → parse JSON · Jason object → JSON object |
| cling / Kling | cling AI → Kling AI · cling 2.5 → Kling 2.5 · cling video → Kling video · cling model → Kling model |
| owner / oner | owner shot → oner shot · single owner → single oner |
| timber / timbre | voice timber → voice timbre · timber reference → timbre reference |
| bouquet / bokeh | bouquet blur → bokeh blur · bouquet background → bokeh background · shallow bouquet → shallow bokeh · creamy bouquet → creamy bokeh |
| mango / Margo | mango app → Margo app · mango editor → Margo editor · open mango → open Margo |
| peacocks / PCOS | peacocks app → PCOS app · peacocks symptoms → PCOS symptoms · peacocks tracker → PCOS tracker |
| sep / CEP | sep panel → CEP panel · sep extension → CEP extension |
| weed / Vite | weed dev → Vite dev · weed config → Vite config · weed build → Vite build |
| comp | leave alone — "comp" is too common to map safely |

If you later add real context gating to `applyDictionary` (a trigger-word window around the match), these can collapse back into single-word rules. Until then, keep them multi-word.

---

## 6. Never add these

Entries that will actively damage normal dictation. Listed so nobody "helpfully" adds them later.

| Tempting entry | Why it is poison |
|---|---|
| `English` → `Hinglish` | Rewrites every legitimate use of "English". Say Hinglish clearly, or fix it by hand. |
| `service` → `Jarvis` | "service" is a normal word you use constantly. |
| `to` / `too` / `two` → `2` | Breaks every sentence. Leave numbers to Whisper. |
| `sonnet` → `Sonnet` | Case-only difference, and the matcher is case-insensitive — it changes nothing except stealing a prompt slot. |
| `see` → `C` | Catastrophic. |
| `wan` → `Wan` | Case-only mapping, and "wan" appears in ordinary text. |
| any single-letter `from` | `\b` plus one letter matches constantly. |
| whole sentences | `extractPhrasePairs` already caps learned pairs at 8 words; hand-written long phrases almost never match verbatim. |

---

## 7. Seed `data/dictionary.json`

Paste-ready. Order matters — Tier 1 first, for the reason in §1. The file does not exist in this repo yet; creating it is safe (`load()` falls back to an empty list, `save()` rewrites it wholesale).

```json
{
  "phrases": [
    { "from": "sea dance", "to": "Seedance" },
    { "from": "see dance", "to": "Seedance" },
    { "from": "C dance", "to": "Seedance" },
    { "from": "seed dance", "to": "Seedance" },
    { "from": "cedance", "to": "Seedance" },
    { "from": "sea dancer", "to": "Seedance" },
    { "from": "sea dance 2.5", "to": "Seedance 2.5" },
    { "from": "see dance 2.5", "to": "Seedance 2.5" },
    { "from": "C dance 2.5", "to": "Seedance 2.5" },
    { "from": "sea dance two point five", "to": "Seedance 2.5" },
    { "from": "see dance to point five", "to": "Seedance 2.5" },
    { "from": "Higgs field", "to": "Higgsfield" },
    { "from": "hicks field", "to": "Higgsfield" },
    { "from": "big field", "to": "Higgsfield" },
    { "from": "hex field", "to": "Higgsfield" },
    { "from": "his field", "to": "Higgsfield" },
    { "from": "nano bandana", "to": "Nano Banana" },
    { "from": "nine o banana", "to": "Nano Banana" },
    { "from": "nanobanana", "to": "Nano Banana" },
    { "from": "nano bandana pro", "to": "Nano Banana Pro" },
    { "from": "sea dream", "to": "Seedream" },
    { "from": "see dream", "to": "Seedream" },
    { "from": "C dream", "to": "Seedream" },
    { "from": "jimming", "to": "Jimeng" },
    { "from": "gee meng", "to": "Jimeng" },
    { "from": "ji meng", "to": "Jimeng" },
    { "from": "klink", "to": "Kling" },
    { "from": "vayo", "to": "Veo" },
    { "from": "comfy you I", "to": "ComfyUI" },
    { "from": "comfy U I", "to": "ComfyUI" },
    { "from": "comfy why", "to": "ComfyUI" },
    { "from": "control net", "to": "ControlNet" },
    { "from": "controlled net", "to": "ControlNet" },
    { "from": "lower a", "to": "LoRA" },
    { "from": "V A E", "to": "VAE" },
    { "from": "see if G", "to": "CFG" },
    { "from": "C F G", "to": "CFG" },
    { "from": "image to image", "to": "img2img" },
    { "from": "img to img", "to": "img2img" },
    { "from": "in paint", "to": "inpaint" },
    { "from": "out paint", "to": "outpaint" },
    { "from": "up scaler", "to": "upscaler" },
    { "from": "key frame", "to": "keyframe" },
    { "from": "sole ID", "to": "Soul ID" },
    { "from": "soul I D", "to": "Soul ID" },
    { "from": "sole character", "to": "Soul Character" },
    { "from": "SD XL", "to": "SDXL" },
    { "from": "stable fusion", "to": "Stable Diffusion" },
    { "from": "vox den", "to": "Voxden" },
    { "from": "box den", "to": "Voxden" },
    { "from": "folks den", "to": "Voxden" },
    { "from": "walks den", "to": "Voxden" },
    { "from": "fox den", "to": "Voxden" },
    { "from": "voxton", "to": "Voxden" },
    { "from": "java's", "to": "Jarvis" },
    { "from": "mo GFX", "to": "MoGfx" },
    { "from": "mow G F X", "to": "MoGfx" },
    { "from": "mogul FX", "to": "MoGfx" },
    { "from": "moe graphics", "to": "MoGfx" },
    { "from": "ref board", "to": "RefBoard" },
    { "from": "rev board", "to": "RefBoard" },
    { "from": "red board", "to": "RefBoard" },
    { "from": "desk pets", "to": "DeskPets" },
    { "from": "disk pets", "to": "DeskPets" },
    { "from": "desk bets", "to": "DeskPets" },
    { "from": "margot", "to": "Margo" },
    { "from": "sucky", "to": "Sakhi" },
    { "from": "sec sort", "to": "SeqSort" },
    { "from": "seek sort", "to": "SeqSort" },
    { "from": "sex sort", "to": "SeqSort" },
    { "from": "sequel sort", "to": "SeqSort" },
    { "from": "cine grade", "to": "CineGrade" },
    { "from": "cinnagrade", "to": "CineGrade" },
    { "from": "scene grade", "to": "CineGrade" },
    { "from": "thakur mar jhuli", "to": "Thakumar Jhuli" },
    { "from": "taku mar julie", "to": "Thakumar Jhuli" },
    { "from": "thakumar julie", "to": "Thakumar Jhuli" },
    { "from": "so knock", "to": "Sounak" },
    { "from": "sunak", "to": "Sounak" },
    { "from": "sownak", "to": "Sounak" },
    { "from": "dobby adds", "to": "Dobby Ads" },
    { "from": "dobie ads", "to": "Dobby Ads" },
    { "from": "cloud code", "to": "Claude Code" },
    { "from": "clod code", "to": "Claude Code" },
    { "from": "claud code", "to": "Claude Code" },
    { "from": "clawed code", "to": "Claude Code" },
    { "from": "entropic", "to": "Anthropic" },
    { "from": "faster whisper", "to": "faster-whisper" },
    { "from": "kuda", "to": "CUDA" },
    { "from": "cooter", "to": "CUDA" },
    { "from": "pie torch", "to": "PyTorch" },
    { "from": "O N N X", "to": "ONNX" },
    { "from": "veet", "to": "Vite" },
    { "from": "tail wind", "to": "Tailwind" },
    { "from": "super base", "to": "Supabase" },
    { "from": "soup a base", "to": "Supabase" },
    { "from": "sequel light", "to": "SQLite" },
    { "from": "SQL light", "to": "SQLite" },
    { "from": "N P M", "to": "npm" },
    { "from": "type script", "to": "TypeScript" },
    { "from": "git hub", "to": "GitHub" },
    { "from": "get hub", "to": "GitHub" },
    { "from": "local host", "to": "localhost" },
    { "from": "web hook", "to": "webhook" },
    { "from": "reg ex", "to": "regex" },
    { "from": "oh llama", "to": "Ollama" },
    { "from": "o lama", "to": "Ollama" },
    { "from": "jay son", "to": "JSON" },
    { "from": "after fx", "to": "After Effects" },
    { "from": "after effect", "to": "After Effects" },
    { "from": "extend script", "to": "ExtendScript" },
    { "from": "mogurt", "to": "MOGRT" },
    { "from": "mo gurt", "to": "MOGRT" },
    { "from": "premier pro", "to": "Premiere Pro" },
    { "from": "da vinci resolve", "to": "DaVinci Resolve" },
    { "from": "pro res", "to": "ProRes" },
    { "from": "ari alexa", "to": "ARRI Alexa" },
    { "from": "aria alexa", "to": "ARRI Alexa" },
    { "from": "anna morphic", "to": "anamorphic" },
    { "from": "gimble", "to": "gimbal" },
    { "from": "jimble", "to": "gimbal" },
    { "from": "bokay", "to": "bokeh" },
    { "from": "deva nagari", "to": "Devanagari" },
    { "from": "developer gary", "to": "Devanagari" },
    { "from": "sea dance 2", "to": "Seedance 2" },
    { "from": "see dance two", "to": "Seedance 2" },
    { "from": "C dance 2", "to": "Seedance 2" },
    { "from": "cling AI", "to": "Kling AI" },
    { "from": "cling 2.5", "to": "Kling 2.5" },
    { "from": "cling video", "to": "Kling video" },
    { "from": "cling model", "to": "Kling model" },
    { "from": "vio model", "to": "Veo model" },
    { "from": "run way ML", "to": "Runway ML" },
    { "from": "high loo", "to": "Hailuo" },
    { "from": "hi luo", "to": "Hailuo" },
    { "from": "mini max", "to": "MiniMax" },
    { "from": "hun yuan", "to": "Hunyuan" },
    { "from": "hoon you an", "to": "Hunyuan" },
    { "from": "mid journey", "to": "Midjourney" },
    { "from": "Laura training", "to": "LoRA training" },
    { "from": "train a Laura", "to": "train a LoRA" },
    { "from": "Laura file", "to": "LoRA file" },
    { "from": "Laura weights", "to": "LoRA weights" },
    { "from": "Laura model", "to": "LoRA model" },
    { "from": "lower a model", "to": "LoRA model" },
    { "from": "mango app", "to": "Margo app" },
    { "from": "mango editor", "to": "Margo editor" },
    { "from": "open mango", "to": "open Margo" },
    { "from": "sucky app", "to": "Sakhi app" },
    { "from": "soggy app", "to": "Sakhi app" },
    { "from": "onyx runtime", "to": "ONNX runtime" },
    { "from": "weed dev", "to": "Vite dev" },
    { "from": "weed config", "to": "Vite config" },
    { "from": "get commit", "to": "git commit" },
    { "from": "get push", "to": "git push" },
    { "from": "get pull", "to": "git pull" },
    { "from": "get status", "to": "git status" },
    { "from": "get branch", "to": "git branch" },
    { "from": "get merge", "to": "git merge" },
    { "from": "get rebase", "to": "git rebase" },
    { "from": "get clone", "to": "git clone" },
    { "from": "get ignore", "to": "gitignore" },
    { "from": "rejects pattern", "to": "regex pattern" },
    { "from": "Jason file", "to": "JSON file" },
    { "from": "Jason format", "to": "JSON format" },
    { "from": "Jason payload", "to": "JSON payload" },
    { "from": "Jason schema", "to": "JSON schema" },
    { "from": "parse Jason", "to": "parse JSON" },
    { "from": "Jason object", "to": "JSON object" },
    { "from": "sep panel", "to": "CEP panel" },
    { "from": "sep extension", "to": "CEP extension" },
    { "from": "bouquet blur", "to": "bokeh blur" },
    { "from": "bouquet background", "to": "bokeh background" },
    { "from": "shallow bouquet", "to": "shallow bokeh" },
    { "from": "creamy bouquet", "to": "creamy bokeh" },
    { "from": "owner shot", "to": "oner shot" },
    { "from": "single owner", "to": "single oner" },
    { "from": "voice timber", "to": "voice timbre" },
    { "from": "timber reference", "to": "timbre reference" },
    { "from": "be roll", "to": "b-roll" },
    { "from": "yamal", "to": "YAML" },
    { "from": "diarisation", "to": "diarization" },
    { "from": "eleven labs", "to": "ElevenLabs" },
    { "from": "coke we", "to": "Coqui" },
    { "from": "vosque", "to": "Vosk" },
    { "from": "script you I", "to": "ScriptUI" },
    { "from": "pre comp", "to": "precomp" },
    { "from": "track mat", "to": "track matte" },
    { "from": "roto scope", "to": "rotoscope" },
    { "from": "kiaroscuro", "to": "chiaroscuro" },
    { "from": "death of field", "to": "depth of field" },
    { "from": "thirty five mil", "to": "35mm" },
    { "from": "rec 709", "to": "Rec.709" },
    { "from": "wreck 709", "to": "Rec.709" },
    { "from": "four K", "to": "4K" },
    { "from": "nine by sixteen", "to": "9:16" },
    { "from": "sixteen by nine", "to": "16:9" },
    { "from": "frames per second", "to": "fps" },
    { "from": "rock shasa", "to": "rakshasa" },
    { "from": "bang goma", "to": "byangoma" },
    { "from": "peacocks app", "to": "PCOS app" },
    { "from": "peacocks symptoms", "to": "PCOS symptoms" },
    { "from": "peacocks tracker", "to": "PCOS tracker" },
    { "from": "saura", "to": "Sora" },
    { "from": "fluke model", "to": "Flux model" },
    { "from": "peaka", "to": "Pika" },
    { "from": "looma", "to": "Luma" },
    { "from": "run way", "to": "Runway" },
    { "from": "wan 2.2", "to": "Wan 2.2" },
    { "from": "P C O S", "to": "PCOS" }
  ]
}
```

---

## 8. Tests

Save as `scripts/test-vocabulary.js` and run `node scripts/test-vocabulary.js`. It drives the real matcher, so it catches ordering and word-boundary mistakes.

```js
'use strict';
const assert = require('assert');
const path = require('path');
const dict = require('../src/dictionary');

const { phrases } = dict.load(path.join(__dirname, '..', 'data', 'dictionary.json'));

const cases = [
  ['I made this in sea dance 2.5',   'I made this in Seedance 2.5'],
  ['open C dance and Higgs field',   'open Seedance and Higgsfield'],
  ['run it through comfy you I',     'run it through ComfyUI'],
  ['train a Laura on her face',      'train a LoRA on her face'],
  ['get commit and get push',        'git commit and git push'],
  ['export a Jason file',            'export a JSON file'],
  ['shoot it as an owner shot',      'shoot it as an oner shot'],
  ['render the mogurt in after fx',  'render the MOGRT in After Effects'],
  // note: no capitalization here — cleanup() does that, and it runs before this
  // guards: these must NOT change
  ['I will get the file later',      'I will get the file later'],
  ['Laura called me this morning',   'Laura called me this morning'],
  ['she brought a bouquet of roses', 'she brought a bouquet of roses'],
  ['the owner of the studio',        'the owner of the studio'],
];

let fail = 0;
for (const [input, expected] of cases) {
  const got = dict.applyDictionary(input, phrases);
  if (got !== expected) {
    fail++;
    console.error('FAIL  ' + input + '\n  got: ' + got + '\n  exp: ' + expected);
  }
}

const prompt = dict.promptFrom(phrases, []);
const terms = prompt ? prompt.split(', ') : [];
console.log('prompt terms: ' + terms.length + '/64');
assert.ok(terms.length <= 64, 'prompt must stay within 64 terms');
for (const must of ['Seedance', 'Seedance 2.5', 'Higgsfield', 'Voxden', 'After Effects', 'MOGRT']) {
  assert.ok(terms.includes(must), must + ' must reach the Whisper prompt');
}

console.log(fail ? fail + ' failing case(s)' : 'all vocabulary cases pass');
process.exit(fail ? 1 : 0);
```

Note the guard cases. `bouquet of roses` and `the owner of the studio` survive precisely because §5 keeps those rules multi-word. If someone ever shortens them, this test fails — which is the point.

---

## 9. Maintenance loop

1. Dictate normally. When a term comes out wrong, fix it inline in the history panel — `dict.learn` (`src/main.js:862`) captures the pair automatically.
2. Every week or so, open `data/dictionary.json` and promote genuinely important new terms into the Tier 1 block at the top, so they reach the Whisper prompt.
3. Keep unique `to` values in the Tier 1 block under 64. The test in §8 prints the count.
4. When you drop a project or a model, delete its rows. Dead entries still eat prompt slots.

---

## 10. Limits, stated honestly

- **The 64-term cap and the `to`-side prompt are read from `src/dictionary.js`.** Those are verified facts about your code.
- **The ~224-token `initial_prompt` window comes from Whisper's decoder design, not from a measurement here.** With 64 short brand terms you are comfortably inside it; if you raise the cap past roughly 100 terms, verify before trusting it.
- **`initial_prompt` biases, it does not guarantee.** Whisper can still ignore a hinted term, and a prompt-heavy setup can make it *insert* hinted words into silence. If phantom "Seedance" starts appearing in empty clips, trim the list.
- **I have not run Voxden.** Everything above is read from source; none of it is confirmed against live transcription output. The §8 test is how you close that gap.
- **Multilingual is on and no language is pinned** (`sidecar/transcribe.py`), so Hindi and Bengali proper nouns can transcribe — but they arrive in Latin script from an English-leaning decode. The Devanagari-related rows assume you say those names inside English sentences, not full Hindi passages.
- **Numbers are Whisper's call.** It may write "2.5" or "two point five" unpredictably, which is why both forms appear as `from` variants for Seedance. If you hit a third form in practice, add it.
