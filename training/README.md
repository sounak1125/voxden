# VoxDen ASR v0.1 — standalone training experiment

This folder builds a **candidate** derived from `openai/whisper-large-v3` using
LoRA. It does not change Electron, settings, the overlay, dictation, model
selection, installers, downloads, or sentence correction. The application is
not configured to use `models/voxden-asr-v0.1/`.

## Actual validation status (2026-08-31)

- Seven existing corrected WAVs passed validation: 90.3 seconds, **7 train / 0
  evaluation** under the fixed split. More real recordings are required. The
  exporter never moves training clips into evaluation to fill an empty split.
- Stock cached Whisper large-v3 loaded on an RTX 4070 and transcribed one real
  recording using VoxDen's VAD and decoding helpers. This was a **smoke test on
  a training clip**, not a held-out benchmark. Its local report is
  `training/work/stock-smoke.json` (contains private transcription text).
- Core tests plus tiny random-model tests cover CUDA FP16 training with
  accumulation/checkpointing, encoder/decoder LoRA gradients, adapter reload,
  merge equivalence, actual CTranslate2 conversion and faster-whisper inference.
  Random fixtures are not speech datasets or quality measurements.
- Validation: 29 core tests, 3 model contract tests and the existing `npm test`
  suite passed. The dependency-free core tests do not fetch pretrained models.
- **No large-v3 fine-tune, large-v3 adapter/merge/conversion, or stock-versus-tuned
  benchmark has been completed. No VoxDen candidate or benchmark numbers are
  claimed. General regression benchmarking is unavailable without real samples.**

See [AUDIT.md](AUDIT.md) for the pre-change findings and scope.

## Requirements and privacy

Use Python **3.11 or 3.12**; the local checks used Windows Python 3.12.10.
Training requires NVIDIA CUDA and refuses CPU execution. Approximately 12 GB
VRAM is the target, not a tested large-v3 peak-memory guarantee. Close other GPU
workloads. Plan for at least 16 GB system RAM (32 GB preferable for merging) and
**25–40 GB free disk**, plus recordings, environment and retained checkpoints.
These are planning estimates, not measurements of a complete build.

The pinned training stack was exercised with PyTorch 2.11.0+cu128, Transformers
4.57.6, PEFT 0.18.0, Accelerate 1.12.0, CTranslate2 4.8.1 and faster-whisper
1.2.1. Do not infer large-v3 compatibility or quality from the tiny-model tests.

All audio, labels, predictions, adapters and models stay local. Scripts default
to cache-only/offline loading. `--allow-download` permits public pretrained
weight downloads only. There is no dataset upload, paid API, cloud trainer, Hub
push or experiment reporting service. Telemetry and trainer reporting are
disabled. Use an offline machine after caching dependencies/weights if you need
network isolation beyond these application settings.

Initial downloads can include the HF large-v3 weights (roughly 3–6 GB depending
on serialization), a separate faster-whisper/CT2 stock copy (roughly 3 GB), and
several GB of Python/CUDA dependencies. Do not install training extras into the
application environment. Model caches use `training/work/cache/`; adapters,
merged weights and checkpoints also consume disk independently.

## Workflow

Run commands from the repository root in PowerShell. `python`/`py` must refer to
a working Python installation. On this machine the installed interpreter is
`$env:LOCALAPPDATA\Programs\Python\Python312\python.exe`; use its full path if
the Python launcher is not on PATH.

### 1. Collect corrected VoxDen dictations

Use the **existing** opt-in “Keep audio for training” setting and correct saved
dictations in history. No new collection behavior is introduced. Pending clips
without a user correction are never exported. Manually ensure the final text
matches what was spoken: an editorial rewrite is not an accurate ASR label.

Development data is `data/audio/pairs.jsonl` plus its `corpus/` WAVs. Packaged
VoxDen uses its Electron user-data directory, usually
`$env:APPDATA\Voxden\data\audio`. Supply `--audio-dir` to select it explicitly;
the exporter does not search other private folders.

### 2. Inspect available training samples

```powershell
node scripts/export-training-data.js --language en
```

For the installed application's corpus:

```powershell
node scripts/export-training-data.js --audio-dir "$env:APPDATA\Voxden\data\audio" --language en
```

The original pairs do not record a language. `--language en` is an explicit
dataset label, **not detected metadata**; choose the actual language. For mixed
languages supply accurate per-record language labels before export. Reports
preserve `language_source` so the distinction stays visible. Inspection reads
all WAV frames but makes no writes and needs only Python's standard library.
Set `VOXDEN_TRAINING_PYTHON` to select an interpreter if needed.

### 3. Export a validated dataset

```powershell
node scripts/export-training-data.js --language en --write
```

Outputs:

```text
training/data/corrections/train.jsonl
training/data/corrections/eval.jsonl
training/data/corrections/export-report.json
```

Rows include ID, absolute audio path, corrected `sentence`, language, label
provenance, measured duration/rate/channels, decoded-PCM SHA-256 and split policy.
The source `asr` field becomes `raw_transcript`: it is the original displayed
transcript, potentially already processed by the application, not an engine ID.
Existing `learned`, timestamps and other available metadata are preserved;
missing engine/detected-language information is not invented.

Default accepted audio is readable, non-silent PCM16 mono 16 kHz WAV, 0.25–30
seconds. Missing, corrupt, truncated, empty-label and duplicate records produce
explicit warnings and rejection reasons. Conflicting duplicate labels are all
rejected. A duration/silence check is **not proof of speech**; listen to data.
Long clips must be manually aligned into truthful audio/text pairs. They are
never truncated against a full-length transcript.

After installing requirements, unsupported mono/stereo WAV rates/encodings may
be normalized into **new copies**, leaving originals unchanged:

```powershell
node scripts/export-training-data.js --language en --write --normalize
```

Normalization averages stereo channels, uses polyphase resampling, and writes
PCM16/16 kHz under the export's `audio/`. Inspect normalized audio, particularly
stereo with phase cancellation. Do not change normalization policy mid-experiment.

The fixed rule assigns decoded-audio hashes below a constant 10% threshold to
evaluation. Counts approximate 90/10 only with enough samples. Reordering,
adding or deleting other records cannot change a surviving recording's split.
Identical audio under new IDs shares the split. Do not edit hash rules to obtain
a convenient holdout. This policy replaces the old unstable ranked split;
old manifests/results are not compatible and must not be reused.

Training and evaluation revalidate every row, fail on any bad manifest record,
verify checksums and reject ID/audio overlap. Training identities are also
stored with the adapter so later evaluation cannot accidentally include past
training recordings after a re-export. Preserve originals during an experiment.

### 4. Install CUDA/PyTorch training dependencies

Create a separate environment:

```powershell
py -3.12 -m venv training/work/venv
$trainPy = (Resolve-Path -LiteralPath training/work/venv/Scripts/python.exe).Path
$env:VOXDEN_TRAINING_PYTHON = $trainPy
& $trainPy -m pip install --upgrade pip
& $trainPy -m pip install torch==2.11.0 --index-url https://download.pytorch.org/whl/cu128
& $trainPy -m pip install -r training/requirements.txt
& $trainPy -c "import torch; print(torch.__version__, torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CUDA unavailable')"
```

The CUDA 12.8 wheel matches the locally exercised PyTorch build. Select a
CUDA wheel supported by your driver from the [official PyTorch instructions](https://pytorch.org/get-started/previous-versions/).
Do not install a CPU-only wheel for training. Driver version and GPU support
must be checked on each machine; other wheel combinations are not validated here.

For CTranslate2 GPU inference, install **cuBLAS for CUDA 12 and cuDNN 9** with
their DLL directories on Windows PATH. A working CUDA PyTorch import alone does
not prove those DLLs are available to CTranslate2. See the
[faster-whisper GPU requirements](https://github.com/SYSTRAN/faster-whisper#gpu).
The standalone helper also uses VoxDen's existing NVIDIA DLL discovery.

### 5. Run the stock Whisper baseline before training

Once both partitions are non-empty:

```powershell
& $trainPy training/evaluate.py --base-only --allow-download
```

`large-v3` resolves to the stock Systran CTranslate2 conversion of
`openai/whisper-large-v3`. The first command may download that public model.
Omit `--allow-download` on subsequent offline runs. To reuse an existing cached
stock model without copying it, supply the snapshot directory to `--base`:

```powershell
$stock = (Resolve-Path -LiteralPath models/models--Systran--faster-whisper-large-v3/snapshots/edaa852ec7e145841d8ffdb056a99866b5f0a478).Path
& $trainPy training/evaluate.py --base-only --base $stock
```

The snapshot above is present on this development machine; other machines must
use their actual cache path. Custom local stock paths must contain unmodified
Whisper large-v3 weights; their file hashes are recorded. Do not label another
architecture or previously tuned directory as the stock baseline.

Results, references and predictions are saved locally in
`training/work/baseline.json`. WER, CER, corrected-term recall and sample counts
are real measured values only. No report is written for an empty evaluation
set. Training requires this matching baseline.

Both models use the same read-only `sidecar/transcribe.py` helpers: decode at
16 kHz, Silero VAD (threshold .5, speech 250 ms, silence 400 ms, padding 200 ms),
concatenate speech chunks, beam/best-of 3, temperature `[0.0, 0.2]`, repetition
penalty 1.15, no-repeat ngram 3, disabled previous-text conditioning and the
existing segment filters. Default device/compute type is CUDA/float16.

No personal dictionary prompt or sentence correction is applied. Historical
per-clip prompts/quality settings are not stored, so this matches the **current
accurate Whisper decoding path**, not every possible historical app run.
`--quality fast`, `--no-vad`, `--device cpu --compute-type int8` are supported
for a separately established experiment. Do not change them between models;
dataset, decode, runtime versions, sidecar code and stock-weight fingerprints
must match the baseline. Empty model predictions count as deletions, not skips.
Keep the original baseline report after training: its complete file hash is
recorded with the adapter, and replacing it invalidates the comparison.

### 6. Train VoxDen ASR v0.1

Preflight without loading HF weights:

```powershell
& $trainPy training/finetune.py --check
```

Train the adapter:

```powershell
& $trainPy training/finetune.py --stage train --allow-download
```

Use `--stock $stock` if the baseline command used a local stock path. The base
HF download is separate from the CT2 stock cache. Offline training requires
those HF weights and processor files to already be cached.

Defaults are rank 32, alpha 64, dropout .05, target modules `q_proj v_proj`,
learning rate 1e-4, 3 epochs, batch 1, accumulation 8, FP16 and non-reentrant
gradient checkpointing. All are configurable:

```powershell
& $trainPy training/finetune.py --stage train --epochs 2 --lr 1e-4 --rank 32 --alpha 64 --dropout 0.05 --target-modules q_proj v_proj --batch 1 --accum 8 --fp16 --gradient-checkpointing
```

Use `--no-fp16` or `--no-gradient-checkpointing` only with sufficient memory.
The frozen base can use FP16; trainable adapters stay FP32 for AMP gradient
scaling. Language prefixes are constructed per sample. Labels exceeding the
decoder context fail rather than truncate. Held-out rows never enter Trainer.
The default `--min-clips 50` is an experimental guard, **not** a statistical
claim that 50 clips suffice. Lower it only for explicitly limited diagnostics.

The script prints CUDA status, GPU/VRAM, model, sample counts and configuration.
On OOM, close other GPU workloads, keep batch 1/checkpointing, or lower rank.
Increasing accumulation alone does not save memory when batch is already 1.
No CPU fallback occurs. Checkpoints retain the last two epochs; interrupted
stages leave their artifacts for inspection, not automatic reuse.

### 7. Merge LoRA

```powershell
& $trainPy training/finetune.py --stage merge
```

This reloads the recorded base and revision, applies the saved adapter with
PEFT `merge_and_unload(safe_merge=True)` and saves HF weights plus processor
files. It never substitutes a newly supplied base during merge. See
[PEFT model merging](https://huggingface.co/docs/peft/developer_guides/lora#merge-lora-weights-into-the-base-model).

### 8. Convert to CTranslate2

```powershell
& $trainPy training/finetune.py --stage convert --quantization float16
```

Conversion uses the Python API in the same environment, not a potentially
different converter on PATH. It checks non-empty `model.bin`, `config.json`,
`tokenizer.json`, `preprocessor_config.json`, and `vocabulary.json`, then loads
faster-whisper and transcribes the first held-out clip. A failed load or empty
transcription fails the stage and leaves an unvalidated candidate. The design
follows the [CTranslate2 Whisper conversion workflow](https://opennmt.net/CTranslate2/guides/transformers.html#whisper).

Output directories must be new/empty. No stage recursively deletes existing
models. Use a fresh `--work-dir training/work/experiment-02` and
`--output models/voxden-asr-v0.1-experiment-02` consistently for another run.
Application model paths, including `models/voxden-tuned`, are forbidden outputs.

### 9. Validate standalone faster-whisper inference

Conversion already performs a real inference check. To repeat it explicitly:

```powershell
$testAudio = (Get-Content -LiteralPath training/data/corrections/eval.jsonl -First 1 | ConvertFrom-Json).audio
& $trainPy training/inference.py --model models/voxden-asr-v0.1 --audio $testAudio --language en
```

This consumes the lazy segment generator and requires non-empty output on a
real speech clip. Model hashes, decoding settings, elapsed time and the actual
transcription are written to `training/work/standalone-validation.json` and the
candidate metadata. No app launch/integration occurs. An empty result may mean
bad audio, VAD rejection or model failure; review it without tuning settings to
make a candidate appear better.

### 10. Evaluate stock versus VoxDen ASR

```powershell
& $trainPy training/evaluate.py
```

Again use `--base $stock` if needed. This reuses the recorded stock baseline
only when its complete protocol matches, evaluates the candidate on identical
held-out references, prints a comparison table and saves
`training/work/comparison.json`. Actual metrics are copied to
`models/voxden-asr-v0.1/metadata.json`. Untested fields remain `null`. Candidate
weights must match their standalone validation before scoring.

After establishing the baseline, this command performs steps 6–10 in separate
processes to release memory between stages:

```powershell
& $trainPy training/finetune.py --allow-download
```

Add `--stock $stock` for the local baseline path. Omit `--allow-download` after
all public model files are cached. A candidate is never automatically promoted.

## Data roles

Four manifests, kept physically separate so mixing them has to be deliberate.
`dataset.py` names the directories; `assert_not_trained_on()` enforces the one
rule that cannot be relaxed.

| Manifest | Contents | Trainable |
| --- | --- | --- |
| `data/audio/pairs.jsonl` | source corpus the app collects (opt-in) | — |
| `training/data/corrections/train.jsonl` | real corrected samples, TRAIN | yes |
| `training/data/corrections/eval.jsonl` | real corrected samples, held-out IN-DOMAIN eval | no |
| `training/data/regression/eval.jsonl` | deliberately recorded GENERAL regression | **never** |
| `training/data/supervised/train.jsonl` | deliberately recorded verified speech | yes |

The correction partitions are assigned by audio hash and cannot be chosen. The
regression set is chosen on purpose and is never trained on — that is the only
reason it can say anything about forgetting. `supervised` exists so deliberately
recorded *trainable* speech has somewhere to go that is not the regression set;
`record.py` refuses a sentence already recorded in the other role.

Passing the regression manifest as a training input raises rather than trains.

## Recording read speech

Corrected pairs arrive at the rate the user makes mistakes, and `split_for()`
assigns partitions by audio hash — so a held-out set cannot be chosen, only
waited for. Reading a known script produces labelled audio at the rate of
speech, and because the reference text is fixed in advance the result is
independent of the corrections the model is tuned on.

```powershell
& $trainPy training/record.py --list-devices
& $trainPy training/record.py                          # --role regression (default)
& $trainPy training/record.py --role supervised        # trainable read speech
& $trainPy training/record.py --summary
& $trainPy training/record.py --prompts my.personal.txt
```

Enter starts a take and Enter stops it; then `k` keeps, `r` re-reads, `s` skips,
`q` stops. Progress is written after every kept clip, so a session can be
abandoned and resumed. Re-reading a sentence **replaces** its row — appending a
second take under one id is the conflict `validate_rows` refuses.

### Audio quality

`analyse()` reports duration, digital silence, peak, RMS, sustained clipping and
a speech proportion; `review()` splits the verdict in two.

**Hard-rejected** (unusable, no keep option): over 30 s — the `inspect_wav`
ceiling, and nothing is ever truncated — under 0.25 s, digital silence, a peak
below −50 dBFS, or under 10% of frames above the noise floor, which is room tone
with a transient in it rather than a read line.

**Warned, and re-recording is recommended but not forced**: quiet peak or RMS,
mostly-silence around a short utterance, sustained clipping. A single peak
threshold is gain- and device-dependent, so a quiet recording from a distant
microphone is flagged rather than discarded — it is still real speech with a
real transcript.

The speech proportion is an energy-based proxy, **not a trained VAD**: a frame
counts when it is loud absolutely, or clear of this take's own noise floor. The
absolute test is what keeps a continuous read with no pauses from scoring zero.
The trade-off runs toward false accepts, because the reader knows whether they
just spoke. Substituting a real VAD would sharpen `analyse()` without changing
any caller.

### Prompts and coverage

`training/prompts/read-speech-en.txt` is 129 neutral sentences, 1476 words,
roughly 10.5 minutes read — no personal names or private vocabulary, so it stays
public. Keep your own domain terms in a separate file; a name ending
`.personal.txt` is gitignored, as is `training/data/`.

**To grow the set, add new sentences and record across multiple sessions.** Do
not re-read the same script expecting proportional statistical power. Repeated
prompts measure acoustic consistency — useful in its own right, for microphone
and session variation — but their errors are correlated with the original take
and they add no new linguistic coverage. `--summary` counts unique sentences
separately and says so when repeats are present. Multiple sessions also vary
room, gain and voice condition, which a single sitting cannot.

### What `--summary` does and does not claim

It reports clips, unique sentences, minutes, reference words, and a **rough**
uncertainty: an approximate 1σ standard error and an approximate 95% range
(1.96σ) for a WER near 10%.

That figure comes from `sqrt(p(1-p)/N)` over reference words, which assumes every
word is an independent trial. Word errors cluster inside an utterance — one
misheard phrase costs several adjacent words — so **the true spread is wider than
reported, and the gap grows with clip length.** Treat it as an order-of-magnitude
check on corpus size. It is not a confidence interval for any measured system, it
does not test a difference, and nothing derived from it should be described as
significant.

For stock-versus-candidate comparisons use `metrics.paired_bootstrap`, which
resamples whole clips with replacement and scores both systems on the same
resample, so within-clip correlation and per-clip difficulty are handled
correctly. `evaluate.py` calls it through `compare()` and stores the result under
`comparison` in the report, with the interval echoed in `assessment`. It returns
a percentile interval and the share of resamples favouring the candidate — a
frequency, **not a p-value**, and not a significance test. A baseline recorded
before per-clip counts existed cannot be resampled; that is reported, not raised.

**Do not generate fake speech data to fill any of these sets.** `--self-test`
writes synthetic tones to a temporary directory to check the manifest contract
and never touches `training/data/`. Add regression data **before** baselining or
training, so one protocol is frozen across the comparison.

## Metrics and candidate assessment

WER and CER sum edit distances over the corpus, divided by reference word and
character counts. Text uses Unicode NFKC/case folding, punctuation-to-space
normalization (apostrophes retained), and collapsed whitespace. CER includes
remaining spaces. Scores are fractions in JSON and percentages in the table;
insertions can legitimately push WER above 100%.

Term recall is presence of a complete normalized token sequence, once per term
per sample. `Seedance` does not match `Seedancer`. Existing `learned[].to`
annotations are used only if present in the final reference. Where absent,
replacement/insertion spans from original-to-corrected transcript alignment are
labelled `transcript_diff_heuristic`. Deletion-only edits have no target term.
This heuristic can include ordinary wording edits; inspect report terms before
claiming a vocabulary improvement. It does not recover unrecorded metadata.
`--min-term-examples 3` controls the frequent-term breakdown only, not which
examples count toward aggregate recall.

Promising candidates improve corrected-term recall materially without a
significant WER/CER regression on independent speech, load reliably and behave
normally. Reports show signed deltas, flag missing regression coverage and
small holdouts, and never say “keep it” based solely on personal corrections.
Positive WER/CER deltas are worse. Thresholds and statistical confidence need
to be agreed using a sufficiently large, untouched set. Near-duplicate takes,
speaker/session overlap and semantic label errors are not detected by exact
audio hashes; manually curate them. LoRA does not guarantee against forgetting.

## Outputs, cleanup and tests

```text
training/data/corrections/      manifests, rejection report, optional audio copies
training/data/regression/       independently supplied evaluation speech
training/work/adapter/          adapter weights, processor, training provenance
training/work/merged/           merged HF weights and processor
training/work/checkpoints/      training checkpoints
training/work/cache/            public pretrained model cache
training/work/venv/             isolated training environment, if created
training/work/*.json            baseline, comparison and inference reports
models/voxden-asr-v0.1/         experimental CT2 model and metadata
```

These data/work/model paths are ignored by the repository's existing Git rules.
Reports and fine-tuned weights may encode private information; never commit or
share them unintentionally. Clearing audio in the existing application does
not erase separate export copies, reports or trained artifacts. Delete those
separately when withdrawing the data. Never delete the app's corpus as a model
cleanup step.

To inspect then delete one default experimental model, use PowerShell only:

```powershell
$repoRoot = (Resolve-Path -LiteralPath .).Path
$artifactPath = Join-Path $repoRoot 'models\voxden-asr-v0.1'
if (Test-Path -LiteralPath $artifactPath) {
    $resolvedArtifact = (Resolve-Path -LiteralPath $artifactPath).Path
    if ($resolvedArtifact -ne $artifactPath) { throw 'Unexpected resolved target' }
    Get-Item -LiteralPath $resolvedArtifact
    Remove-Item -LiteralPath $resolvedArtifact -Recurse -Confirm
}
```

Apply the same explicit inspection to `training/work/adapter`, `merged`,
`checkpoints`, or the whole `training/work` if you also want to remove caches,
reports and the training environment. Remove `training/data/corrections` only
when its manifests/normalized copies are no longer needed. There is no automatic
recursive cleanup in the scripts.

Tests (no pretrained downloads):

```powershell
& $trainPy -m unittest discover -s training -p test_pipeline.py -v
& $trainPy -m unittest discover -s training -p test_model_pipeline.py -v
& $trainPy -m unittest discover -s training -p test_record.py -v
npm test
```

The core suite can run without torch/PEFT (normalization test skips without its
optional dependencies). The model contract suite requires training packages;
its FP16 test skips if no GPU exists. It intentionally uses random weights,
not `openai/whisper-large-v3`. Tests do not certify model quality, realistic
training duration, peak large-model VRAM or performance on other Windows setups.
