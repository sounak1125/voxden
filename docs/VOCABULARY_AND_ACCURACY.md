# Custom vocabulary and recognition accuracy

How a word you add reaches the speech engine, what happens to it afterwards,
and how any of that is measured.

## The problem this replaced

`src/main.js` had always built a prompt out of the user's dictionary and
written it into every sidecar request. Two of the three backends threw it away:

| engine | what `transcribe()` did with `prompt` |
| --- | --- |
| Whisper | passed it as `initial_prompt` |
| Qwen3-ASR | `del prompt` — discarded |
| Parakeet | `del prompt, vad, language, quality` — discarded |

Qwen3-ASR is the engine the shipping build defaults to, so for most installs
every custom word was accepted by the UI and silently dropped before it reached
a model. Nothing anywhere reported it.

Three smaller faults sat on top of that:

* `hasAlnumEnds` was `/^[a-z0-9](?:.*[a-z0-9])?$/i`, so the dictionary refused
  `नमस्ते`, `Café` and `José` — it told people their own name was not a word.
* Matching used `new RegExp('\\b' + from + '\\b', 'gi')`. `\b` is defined
  against ASCII word characters, so a Devanagari rule never fired.
* The prompt builder took the first 64 terms with no ranking and no token
  budget, whatever engine was running.

## How vocabulary reaches an engine now

`src/asr-capabilities.js` states, in one place, what each engine can do. The
same table exists in `sidecar/transcribe.py`, and `scripts/test-asr-capabilities.js`
fails if the two ever disagree.

| engine | mechanism | budget | languages | confidence |
| --- | --- | --- | --- | --- |
| Whisper large-v3 | `initial_prompt` | 48 terms / 180 tokens | en hi de fr es pt it nl | per-segment `avg_logprob` |
| Qwen3-ASR 1.7B | `context` (system message) | 96 terms / 600 tokens | en hi de fr es pt it nl | none |
| Parakeet TDT | none | — | en | none |

Whisper's prompt window is `n_text_ctx / 2 - 1` = 223 tokens and the tail is
what gets cut, so the budget sits under it rather than at it. Qwen's `context`
argument is the contextual-biasing input `qwen_asr` documents; it becomes the
system message of the chat template.

Every reply from the sidecar now says which engine ran and whether the
vocabulary was honoured — `context`, `initial_prompt`, `none` or `unsupported`.
An engine that cannot take a vocabulary says so instead of staying quiet.

## The three stages after recognition

They are separate on purpose, because they carry different risk.

1. **Explicit replacement** (`src/vocabulary.js`) — the rules the user wrote,
   matched exactly, in any script, with Unicode-aware word boundaries. No
   judgement, so it runs on every path including verbatim mode.
2. **Acoustic repair** (`src/repair.js`) — deciding that a span the engine
   produced is a mangled vocabulary term. This is a judgement, so it is gated
   on evidence (below).
3. **Writing cleanup** (`src/cleanup.js`, `src/style.js`) — fillers,
   punctuation, tone. Deterministic rules only: repairing a name is not their
   job, and none of them introduces a word the speaker did not say.

### What licenses a repair

Only two things, without a user in the loop:

* the letters are identical and only the spacing moved (`seedance2` →
  `Seedance 2`); or
* the decoder itself flagged that span as uncertain.

Everything else is reported as an **escalation candidate** rather than applied.
This is not caution for its own sake. Applying every phonetic match to the
held-out recordings produced seven false substitutions in seven clips —
`Laura called me this morning` became `LoRA called me this morning`, `an
entropic system` became `an Anthropic system` — and pushed word error rate up
from 0.142 to 0.166. The gate that fixed it is: **no word in a repaired span
may be ordinary English**, inflections included.

The cost is a class of repair given up. `See Dance too` for `Seedance 2` is
three ordinary words and will never be repaired automatically; that case
belongs to an explicit rule, where the user has said what they want replaced.

`scripts/test-repair.js` keeps 27 ordinary English sentences as a hard gate.

## Routing

An "accurate" dictation on a CPU used to be handed to Parakeet for speed —
which cannot take a vocabulary at all. It still is, when there is nothing to
lose. When the dictionary is non-empty and the primary engine can use it, the
dictation stays on the primary and the reason is recorded. A dictation the user
explicitly asked to be fast is still fast.

Parakeet raises an error on a non-English request rather than returning a
confident English transcript nobody can explain.

## Chunk boundaries

The chunker keeps `OVERLAP_MS` of the previous slice at the front of each new
one, so adjacent transcripts should share their seam. That overlap used to be
joined with `texts.join(' ')` and handed to the repeat collapser, which both
left duplicates in and flattened repetition the speaker had actually made.

Overlap is now removed at the seam. A seam where no overlap can be matched is a
cut through the middle of a word — neither transcript ever contained it — so up
to two such seams per dictation are re-recognised from the audio that spans
them, and the result is spliced in only if it anchors on both sides.

## What gets downloaded

Setup used to be all-or-nothing. `SpeechModelsManager.install()` took no
argument and fetched every pack; `setupDictation` called it beside the Whisper
download unconditionally; the banner added the lot up and told a first-run user
"up to 11.0 GB" before they had dictated a word.

| component | download | needed when |
| --- | --- | --- |
| Python runtime | 0 (in the installer) | always |
| Whisper large-v3 | 3.10 GB | you selected Whisper |
| Qwen3-ASR 1.7B | 4.70 GB | you selected Qwen |
| Parakeet TDT int8 | 0.66 GB | fast English path, CPU |
| Parakeet TDT float32 | 2.51 GB | fast English path, DirectML only |

Exactly one Parakeet precision can ever load: `parakeet_quantization()` picks
int8 on the CPU and float32 on a GPU, and the shipped runtime is ONNX Runtime's
DirectML build with no CUDA execution provider at all. So the float32 weights
are reachable only when the processor setting is "AMD or Intel GPU", and they
are not offered otherwise.

`src/model-plan.js` is the single answer to "what does this configuration
need". It is pure — settings, hardware, sizes, what is on disk, in; a plan out —
and both the banner and the downloader read it, so they cannot disagree about
the number. A Qwen install now fetches 4.70 GB, a Whisper install 3.10 GB, a
Parakeet install 0.66 GB. Everything else is listed under the setup card with
its own size and its own button, and switching engine offers the missing
download by name instead of reporting a broken install.

## Which engine to ship as the default

Measured on the held-out recordings, on the runtime users actually get — the
bundled `torch 2.11.0+cpu` with no cuBLAS, so neither large model reaches a GPU:

| engine (CPU) | WER | term recall | median | download |
| --- | --- | --- | --- | --- |
| Parakeet TDT int8 | 0.136 | 0.286 | 695 ms | 0.66 GB |
| Whisper large-v3 | 0.112 | 0.714 | 8 936 ms | 3.10 GB |
| Qwen3-ASR 1.7B | 0.148 | 0.857 | 10 680 ms | 4.70 GB |

On a GPU the picture changes — Whisper 0.107 WER at 688 ms with the cuBLAS pack.
Qwen CUDA acceleration is a separate PyTorch pack; CPU, CUDA, and ROCm Qwen all
receive the same `context=` string. Until that pack is installed and the sidecar
verifies GPU execution, packaged Qwen stays on CPU torch.

Read plainly: **on the shipped configuration Qwen is worse than Parakeet on word
error rate and fifteen times slower, for seven times the download.** What Qwen
buys is custom-term recall (0.857 against 0.286) and multilingual support, which
Parakeet has none of — it is English-only. Whisper sits between the two on every
axis except speed, where it is nearly as slow as Qwen.

So the evidence supports Parakeet as the default for English dictation and Qwen
as the download somebody chooses for Hindi, mixed speech, or a dictionary-heavy
workflow. That is a product decision rather than a code one; the default lives
in one line of `settings` in `src/main.js`, and the plan above makes switching
cost only the model that was not already fetched.

Caveats: seven clips, ninety seconds, one speaker. Hindi accuracy is unmeasured
because there are no Hindi recordings to measure it on.

## Measuring

```bash
node scripts/eval-asr.js --engine qwen3-asr --device cuda --vocab data/dictionary.json --label after
node scripts/eval-report.js --gate temp/eval/before.json temp/eval/after.json
```

`eval-asr.js` drives the real sidecar over its real stdio protocol, using the
consented recordings the corpus has already parked (`data/audio/pairs.jsonl`)
and their reference transcripts. Nothing is uploaded and no audio leaves the
machine. `--raw` measures the engine alone; the default measures the text a
user would actually be pasted.

It reports word and character error rate, exact custom-term precision and
recall, false dictionary insertions, language/script accuracy, and median and
p95 stop-to-text latency.

`eval-report.js --gate` exits non-zero when a threshold is missed. The
thresholds live in `GATES` at the top of that file: accuracy must hold or
improve, latency may drift by a quarter, and **a single false dictionary
substitution fails the run**. Moving one is a decision to argue for in the
commit that moves it, not a way to make a run pass.

### Measurement hygiene

Latency numbers are worthless on a busy machine. An early run of this harness
reported the vocabulary work costing 2.4× latency; re-running it on an idle
machine showed the true cost was nil, and a direct timing of `qwen_asr` with
0, 27 and 226 characters of context confirmed context length has no measurable
effect (1531 / 1543 / 1400 ms). Measure when nothing else is on the GPU.

## Privacy

The per-dictation record kept in history contains only numbers and terms the
user typed in themselves — which engine ran, how the vocabulary was applied,
how many terms fitted, and each repair that was made or declined. It carries no
audio, no transcript text, no clipboard and no window text, so it is safe to
keep whatever the context settings say.
