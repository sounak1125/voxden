# Training Voxden on your own voice

A LoRA fine-tune of Whisper on the clips Voxden collected from your corrections,
converted to CTranslate2 and dropped where the app finds it.

**Nothing in this folder has been run end to end.** The scripts are written
against the documented APIs and they compile, but no fine-tune has been executed
against real data — there was none to run against. Treat the first run as a
shakedown, and treat `evaluate.py` as the thing that decides whether the result
is worth keeping.

## Before you start

You need collected pairs. Turn on **Settings → Data and privacy → Keep audio for
training**, then dictate and correct as usual. Check what has accumulated:

```bash
node scripts/export-training-data.js
```

Below roughly 100 clips there is nothing worth training on and `finetune.py`
will refuse. A few hundred short clips is where proper nouns start to move.
Hours of audio is what general accuracy needs.

## Install

Training pulls in torch and transformers — about 3 GB, and none of it is needed
to run Voxden. Install torch from the CUDA index first, or you will silently get
the CPU-only wheel:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu124
```

```bash
pip install -r training/requirements.txt
```

Confirm it took:

```bash
python -c "import torch; print(torch.cuda.is_available())"
```

`finetune.py` exits with instructions if this is `False`.

## Run

```bash
node scripts/export-training-data.js --write
```

Writes `data/audio/train.jsonl` and `data/audio/eval.jsonl`. The split is a
deterministic hash of the clip id, so re-running never moves a clip from eval
into train and quietly contaminates your measurement.

Get a baseline first — you cannot tell whether a fine-tune helped without one:

```bash
python training/evaluate.py --base-only
```

Then train:

```bash
python training/finetune.py
```

This trains the adapter, merges it into the base weights, and converts the
result to `models/voxden-tuned/`. Expect hours on a 4070, and about 6 GB of
Hugging Face download the first time.

Then measure:

```bash
python training/evaluate.py
```

## Reading the result

Two numbers, and they are not the same number:

- **WER** — overall word error rate. Expect this to barely move. A personal
  dataset of a few hundred clips is not going to change general English.
- **Term recall** — how often the names you actually corrected come out right.
  This is what the whole exercise is for.

The trade you want is term recall up, WER flat. If WER jumps more than a few
points, the model is forgetting general English and you should delete
`models/voxden-tuned/` and try again with fewer epochs or a lower `--lr`.

`evaluate.py` measures through faster-whisper with the sidecar's exact decode
settings, so the numbers describe what the app will really do — including the
int8/float16 quantisation, which is its own opportunity to lose quality.

**The blind spot:** your eval set is your own dictation. It cannot detect the
model getting worse at English it never sees there. If you want that signal,
keep a handful of ordinary, name-free dictations in the eval split.

## Using it

The app picks up `models/voxden-tuned/` on its own and shows a **Use your tuned
model** toggle in Settings → General. Switching it reloads the engine, which
takes a few seconds. Turning it off falls back to stock `large-v3` — the tuned
model stays on disk.

To go back permanently, delete `models/voxden-tuned/`.

`VOXDEN_MODEL` overrides everything, which is the quick way to A/B by hand:

```bash
VOXDEN_MODEL=large-v3 npm start
```

## Choices worth knowing about

**LoRA, not a full fine-tune.** Partly because 1.55B parameters of Whisper
large-v3 will not train in 12 GB, and partly because freezing the base is the
main defence against forgetting. It is a defence, not a guarantee.

**fp16, not 8-bit.** An 8-bit base would leave more headroom, but bitsandbytes
on Windows is a reliability problem and fp16 large-v3 fits a 4070 with gradient
checkpointing. If you hit OOM, drop `--batch` to 1 (already the default) and
raise `--accum`.

**Learning rate 1e-4, not the usual 1e-3.** LoRA recipes for Whisper usually run
an order of magnitude hotter. This dataset is small and personal, and a hot LR on
small data is exactly how you get a model that has memorised your clips and
forgotten everything else.

**Only `q_proj` and `v_proj`.** More target modules mean more capacity to
overfit a few hundred clips. If term recall stalls and WER stays flat, adding
`k_proj` and `out_proj` is the next thing to try.

## Re-converting without retraining

If conversion fails or you want a different quantisation, the adapter is kept:

```bash
python training/finetune.py --skip-train --quantization int8
```
