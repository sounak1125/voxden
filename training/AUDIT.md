# ASR training audit — 2026-08-31

This audit was reported before implementation. The requested scope is the
standalone VoxDen ASR v0.1 pipeline only; no application integration.

## Existing infrastructure and verified behavior

- `src/corpus.js` implements opt-in recording retention, pending clip claiming,
  promotion after a history correction, replacement on re-edit, and deletion.
  Its existing tests passed before changes. `src/main.js` passes corrected text,
  the original displayed text as `asr`, and currently an empty `learned` list.
- `src/overlay.js` records/resamples PCM16 mono 16 kHz WAVs. Corpus pairs include
  ID, relative audio path, corrected text, original text, learned annotations
  when available, timestamps, byte counts and duration. Language and engine
  identity are not currently recorded. No new collection is required.
- `scripts/export-training-data.js` had a summary/export CLI.
- `training/finetune.py` had a CUDA guard, LoRA q/v projections, a reasonable
  initial recipe, collator, adapter saving, merging and converter invocation.
- `training/evaluate.py` had WER and learned-term scoring through faster-whisper.
- Local hardware: RTX 4070, 12 GB VRAM; Python 3.12.10, CUDA PyTorch available.
  PEFT was absent and was installed only into ignored `training/work/test-deps`
  for this development session; application packages were not changed.

## Unvalidated, incomplete or risky before this change

1. The old README explicitly said no end-to-end training had occurred. No
   adapter, merged candidate, standalone tuned inference or comparison was
   established by the audit.
2. Sorting hashes and taking the first 10% changes old assignments when samples
   are added. It was not a stable split despite its comment.
3. Export only checked path existence, dropped IDs, silently ignored malformed
   records, accepted duplicates and lacked format/speech-length validation.
4. Training could silently truncate >30-second audio while retaining its full
   transcript. It did not validate label length or train/eval contamination.
5. Generation suppression settings were altered without a training need.
   Checkpointing/FP16 adapter gradients had not been tested; LoRA alpha, dropout
   and target modules were partly hard-coded.
6. Evaluation called `model.transcribe` without the sidecar's pre-VAD path.
   There was no CER, persistent baseline, regression set support, metadata,
   weight/dataset provenance, or post-conversion real transcription gate.
7. Term recall used substring matches and relied only on `learned`; current
   correction collection often supplies an empty list. Original text is
   available for explicitly labelled heuristic span alignment.
8. Conversion deleted old output folders and treated file existence as success.
   Its default `models/voxden-tuned` path and documentation assumed app use,
   conflicting with this task's isolated experimental output requirement.
9. Documentation overstated 12 GB compatibility and gave “keep it” advice
   without independent regression results. Personal corrections alone cannot
   establish general accuracy or rule out forgetting.

## Scoped implementation

Modified only `scripts/export-training-data.js` and `training/{finetune.py,
evaluate.py,requirements.txt,README.md}`. Added `training/{dataset.py,metrics.py,
artifacts.py,inference.py,test_pipeline.py,test_model_pipeline.py,AUDIT.md}`.
Corpus, sidecar and other application files were read, not edited. Reused the
existing collator, LoRA recipe and sidecar decoding helpers where appropriate.

The exporter now delegates to a common Python validator. Fixed decoded-audio
hash partitions, strict manifest checks and stored training identities prevent
exact ID/audio leakage. Training stages are separate processes, preserve
existing outputs, save provenance, require a matching baseline, and gate
candidate evaluation on actual standalone inference. Reports remain local.

## Actual validation and remaining release blockers

- Exported the real local corpus: 7 valid pairs, 90.3 seconds, zero rejected;
  fixed partition is 7 train / 0 eval. No samples were moved to manufacture a
  holdout. This is an expected small-corpus limitation, not a successful baseline.
- Stock cached Whisper large-v3 loaded and transcribed a real local clip on
  CUDA using the current sidecar preprocessing. This is smoke validation only.
- The focused tests exercise deterministic growth, no overlap, malformed data,
  rejection cases, normalization, metrics, metadata identity and safe outputs.
- Tiny random-model tests exercise CUDA FP16 Trainer accumulation/checkpointing,
  encoder/decoder LoRA gradients, adapter reload, merge equivalence, conversion,
  and actual faster-whisper generator execution. They download no model and
  provide no ASR benchmark data.
- Final validation: 29 core tests and 3 model contract tests passed. The existing
  `npm test` suite passed, including corpus and sidecar checks. Python syntax
  checks and `git diff --check` passed. Sandbox-only Python launch failures
  were resolved by running those checks with approved interpreter access.
- Large-v3 fine-tuning, real adapter/merge/conversion and held-out stock/candidate
  benchmarking remain **unvalidated**. There is no candidate artifact and no
  invented metric. A real independent regression dataset is also absent.

Collect enough real corrected recordings for a non-empty fixed holdout and a
useful training corpus, add independent regression speech, then run the exact
README workflow before declaring the ASR-development release criteria met.
