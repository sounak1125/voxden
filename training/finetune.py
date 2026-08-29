#!/usr/bin/env python3
"""LoRA fine-tune of Whisper on the clips Voxden collected, then convert the
result to CTranslate2 so the sidecar can load it.

    python training/finetune.py                 train, merge, convert
    python training/finetune.py --skip-train    re-convert from an existing adapter

Input is data/audio/train.jsonl, written by `node scripts/export-training-data.js
--write`. Output is models/voxden-tuned/, which the app picks up on its own.

Only the LoRA adapters are trained; the base weights stay frozen. That is what
keeps this inside 12 GB and it is also the main defence against the model
forgetting general English while it learns a handful of names. It is a defence,
not a guarantee — run training/evaluate.py afterwards and actually look at the
numbers before you keep the result.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRAIN_FILE = ROOT / "data" / "audio" / "train.jsonl"
WORK_DIR = ROOT / "training" / "work"
ADAPTER_DIR = WORK_DIR / "adapter"
MERGED_DIR = WORK_DIR / "merged"
OUT_DIR = ROOT / "models" / "voxden-tuned"

SAMPLE_RATE = 16000


def read_jsonl(path: Path):
    rows = []
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("audio") and rec.get("sentence"):
                rows.append(rec)
    return rows


def require_training_deps():
    """Fail with instructions rather than a traceback when the training extras
    are not installed — they are a 3 GB install nobody does by accident."""
    missing = []
    for module in ("torch", "transformers", "peft", "soundfile"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        sys.exit(
            "Missing training dependencies: " + ", ".join(missing) + "\n"
            "  pip install torch --index-url https://download.pytorch.org/whl/cu124\n"
            "  pip install -r training/requirements.txt"
        )


def build_dataset(rows, processor):
    import numpy as np
    import soundfile as sf
    from torch.utils.data import Dataset

    class ClipDataset(Dataset):
        def __len__(self):
            return len(rows)

        def __getitem__(self, index):
            row = rows[index]
            audio, rate = sf.read(row["audio"], dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if rate != SAMPLE_RATE:
                # Voxden always writes 16 kHz. Anything else would be silently
                # mis-framed by the feature extractor, so stop instead.
                raise ValueError(
                    f"{row['audio']} is {rate} Hz, expected {SAMPLE_RATE} Hz"
                )
            features = processor.feature_extractor(
                np.asarray(audio), sampling_rate=rate, return_tensors="np"
            ).input_features[0]
            labels = processor.tokenizer(row["sentence"]).input_ids
            return {"input_features": features, "labels": labels}

    return ClipDataset()


class Collator:
    """Standard Whisper collator: mel features are already fixed-length, labels
    are padded to the batch max and masked out of the loss with -100."""

    def __init__(self, processor, decoder_start_token_id):
        self.processor = processor
        self.decoder_start_token_id = decoder_start_token_id

    def __call__(self, features):
        batch = self.processor.feature_extractor.pad(
            [{"input_features": f["input_features"]} for f in features],
            return_tensors="pt",
        )
        labels_batch = self.processor.tokenizer.pad(
            [{"input_ids": f["labels"]} for f in features], return_tensors="pt"
        )
        labels = labels_batch["input_ids"].masked_fill(
            labels_batch.attention_mask.ne(1), -100
        )
        # The tokenizer prepends the decoder start token; the model adds it back
        # itself, so drop it here or every label is shifted by one.
        if (labels[:, 0] == self.decoder_start_token_id).all().cpu().item():
            labels = labels[:, 1:]
        batch["labels"] = labels
        return batch


def train(args, rows):
    require_training_deps()
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import (
        Seq2SeqTrainer,
        Seq2SeqTrainingArguments,
        WhisperForConditionalGeneration,
        WhisperProcessor,
    )

    if not torch.cuda.is_available():
        sys.exit(
            "No CUDA device visible to torch.\n"
            "You almost certainly installed the CPU-only wheel. Reinstall with:\n"
            "  pip install torch --index-url https://download.pytorch.org/whl/cu124"
        )

    print(f"gpu        {torch.cuda.get_device_name(0)}")
    print(f"base       {args.base}")
    print(f"clips      {len(rows)}")

    processor = WhisperProcessor.from_pretrained(
        args.base, language=args.language, task="transcribe"
    )
    model = WhisperForConditionalGeneration.from_pretrained(
        args.base, torch_dtype=torch.float16 if args.fp16 else torch.float32
    )

    # Training must not be steered by the generation-time decoder prompt.
    model.config.forced_decoder_ids = None
    model.config.suppress_tokens = []
    model.config.use_cache = False
    if model.generation_config is not None:
        model.generation_config.forced_decoder_ids = None

    lora = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        target_modules=["q_proj", "v_proj"],
        lora_dropout=0.05,
        bias="none",
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    # Gradient checkpointing drops activations from a frozen base, which leaves
    # the LoRA layers with nothing to backprop through unless the inputs are
    # explicitly marked as requiring grad.
    if args.gradient_checkpointing:
        model.enable_input_require_grads()

    dataset = build_dataset(rows, processor)
    collator = Collator(processor, model.config.decoder_start_token_id)

    training_args = Seq2SeqTrainingArguments(
        output_dir=str(WORK_DIR / "checkpoints"),
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.accum,
        learning_rate=args.lr,
        warmup_ratio=0.1,
        num_train_epochs=args.epochs,
        gradient_checkpointing=args.gradient_checkpointing,
        fp16=args.fp16,
        logging_steps=10,
        save_strategy="no",
        remove_unused_columns=False,
        label_names=["labels"],
        report_to=[],
    )

    trainer = Seq2SeqTrainer(
        args=training_args,
        model=model,
        train_dataset=dataset,
        data_collator=collator,
    )
    trainer.train()

    ADAPTER_DIR.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(ADAPTER_DIR))
    processor.save_pretrained(str(ADAPTER_DIR))
    print(f"adapter    {ADAPTER_DIR}")


def merge(args):
    """Fold the adapter into a full set of weights. CTranslate2 has no concept
    of LoRA, so the merge has to happen before conversion."""
    if not ADAPTER_DIR.exists():
        sys.exit(f"No adapter at {ADAPTER_DIR}. Run without --skip-train first.")
    require_training_deps()

    import torch
    from peft import PeftModel
    from transformers import WhisperForConditionalGeneration, WhisperProcessor

    print("merging adapter into base weights")
    base = WhisperForConditionalGeneration.from_pretrained(
        args.base, torch_dtype=torch.float16
    )
    merged = PeftModel.from_pretrained(base, str(ADAPTER_DIR)).merge_and_unload()

    if MERGED_DIR.exists():
        shutil.rmtree(MERGED_DIR, ignore_errors=True)
    MERGED_DIR.mkdir(parents=True, exist_ok=True)
    merged.save_pretrained(str(MERGED_DIR), safe_serialization=True)

    # faster-whisper needs tokenizer.json and preprocessor_config.json beside
    # the converted weights, and they only exist if the processor is saved too.
    processor = WhisperProcessor.from_pretrained(
        args.base, language=args.language, task="transcribe"
    )
    processor.save_pretrained(str(MERGED_DIR))
    print(f"merged     {MERGED_DIR}")


def convert(args):
    converter = shutil.which("ct2-transformers-converter")
    if not converter:
        sys.exit(
            "ct2-transformers-converter not on PATH. It ships with ctranslate2 — "
            "activate the environment that has it installed."
        )
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR, ignore_errors=True)
    cmd = [
        converter,
        "--model", str(MERGED_DIR),
        "--output_dir", str(OUT_DIR),
        "--quantization", args.quantization,
        "--copy_files", "tokenizer.json", "preprocessor_config.json",
    ]
    print("converting to CTranslate2")
    subprocess.run(cmd, check=True)

    missing = [
        name
        for name in ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json")
        if not (OUT_DIR / name).exists()
    ]
    if missing:
        sys.exit(f"Conversion finished but {OUT_DIR} is missing: {', '.join(missing)}")
    print(f"model      {OUT_DIR}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="openai/whisper-large-v3")
    parser.add_argument("--language", default="en")
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--lr", type=float, default=1e-4,
                        help="LoRA recipes often use 1e-3; this is deliberately "
                             "lower because the dataset is small and personal.")
    parser.add_argument("--rank", type=int, default=32)
    parser.add_argument("--batch", type=int, default=1)
    parser.add_argument("--accum", type=int, default=8)
    parser.add_argument("--quantization", default="float16")
    parser.add_argument("--min-clips", type=int, default=50)
    parser.add_argument("--fp16", dest="fp16", action="store_true", default=True)
    parser.add_argument("--no-fp16", dest="fp16", action="store_false")
    parser.add_argument("--gradient-checkpointing", dest="gradient_checkpointing",
                        action="store_true", default=True)
    parser.add_argument("--no-gradient-checkpointing", dest="gradient_checkpointing",
                        action="store_false")
    parser.add_argument("--skip-train", action="store_true",
                        help="Merge and convert an adapter that already exists.")
    args = parser.parse_args()

    WORK_DIR.mkdir(parents=True, exist_ok=True)

    if not args.skip_train:
        rows = read_jsonl(TRAIN_FILE)
        if not rows:
            sys.exit(
                f"No training rows at {TRAIN_FILE}.\n"
                "Run: node scripts/export-training-data.js --write"
            )
        if len(rows) < args.min_clips:
            sys.exit(
                f"Only {len(rows)} clips. Below roughly {args.min_clips} a fine-tune "
                "mostly memorises noise. Keep collecting, or pass "
                f"--min-clips {len(rows)} if you want to try anyway."
            )
        missing = [r["audio"] for r in rows if not Path(r["audio"]).exists()]
        if missing:
            sys.exit(f"{len(missing)} clips listed in train.jsonl are missing, first: {missing[0]}")
        train(args, rows)

    merge(args)
    convert(args)

    print("")
    print("Now measure it before trusting it:")
    print("  python training/evaluate.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
