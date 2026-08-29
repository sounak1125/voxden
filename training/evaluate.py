#!/usr/bin/env python3
"""Measure the tuned model against the base one on the held-out clips.

    python training/evaluate.py

Runs both models through faster-whisper with the exact settings the sidecar
uses, so the numbers describe what the app will actually do — not what the
un-quantised training-time model could do.

Two numbers matter and they are not the same number:

  WER          overall word error rate. Expect this to move very little.
  term recall  how often the names you corrected actually come out right.
               This is the one the whole exercise is about.

A tuned model that improves term recall while WER creeps up slightly is usually
the trade you wanted. A tuned model where WER jumps is forgetting general
English, and you should throw it away.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EVAL_FILE = ROOT / "data" / "audio" / "eval.jsonl"
TUNED_DIR = ROOT / "models" / "voxden-tuned"
MODELS_DIR = ROOT / "models"

sys.path.insert(0, str(ROOT / "sidecar"))


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


def normalize(text: str) -> str:
    s = str(text or "").lower()
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def load_model(name_or_path, device, compute_type):
    from faster_whisper import WhisperModel

    return WhisperModel(
        str(name_or_path),
        device=device,
        compute_type=compute_type,
        download_root=str(MODELS_DIR),
    )


def run(model, rows, language):
    from transcribe import join_segments, transcribe_kwargs

    out = []
    for i, row in enumerate(rows, 1):
        kwargs = transcribe_kwargs(None, language, False)
        segments, _info = model.transcribe(row["audio"], **kwargs)
        out.append(join_segments(segments))
        print(f"  {i}/{len(rows)}", end="\r", flush=True)
    print(" " * 24, end="\r")
    return out


def score(rows, hypotheses):
    import jiwer

    refs = [normalize(r["sentence"]) for r in rows]
    hyps = [normalize(h) for h in hypotheses]
    pairs = [(r, h) for r, h in zip(refs, hyps) if r]
    wer = jiwer.wer([p[0] for p in pairs], [p[1] for p in pairs]) if pairs else 0.0

    hits = 0
    total = 0
    misses = []
    for row, hyp in zip(rows, hypotheses):
        for learned in row.get("learned") or []:
            term = str(learned.get("to") or "").strip()
            if not term:
                continue
            total += 1
            if normalize(term) and normalize(term) in normalize(hyp):
                hits += 1
            else:
                misses.append(term)
    recall = (hits / total) if total else None
    return {"wer": wer, "recall": recall, "hits": hits, "terms": total, "misses": misses}


def pct(value):
    return "  n/a " if value is None else f"{value * 100:6.2f}%"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="large-v3")
    parser.add_argument("--tuned", default=str(TUNED_DIR))
    parser.add_argument("--language", default="en")
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--base-only", action="store_true",
                        help="Baseline the eval set before any tuning exists.")
    args = parser.parse_args()

    rows = read_jsonl(EVAL_FILE)
    if not rows:
        sys.exit(
            f"No eval rows at {EVAL_FILE}.\n"
            "Run: node scripts/export-training-data.js --write"
        )
    missing = [r["audio"] for r in rows if not Path(r["audio"]).exists()]
    if missing:
        sys.exit(f"{len(missing)} eval clips are missing, first: {missing[0]}")

    tuned_path = Path(args.tuned)
    have_tuned = (tuned_path / "model.bin").exists()
    if not have_tuned and not args.base_only:
        sys.exit(
            f"No tuned model at {tuned_path}.\n"
            "Run training/finetune.py first, or pass --base-only for a baseline."
        )

    print(f"clips      {len(rows)}")
    print(f"base       {args.base}")
    print("")

    print("base model")
    base_scores = score(rows, run(load_model(args.base, args.device, args.compute_type),
                                  rows, args.language))
    print(f"  WER         {pct(base_scores['wer'])}")
    print(f"  term recall {pct(base_scores['recall'])}"
          f"  ({base_scores['hits']}/{base_scores['terms']})")

    if args.base_only or not have_tuned:
        return 0

    print("")
    print("tuned model")
    tuned_scores = score(rows, run(load_model(tuned_path, args.device, args.compute_type),
                                   rows, args.language))
    print(f"  WER         {pct(tuned_scores['wer'])}")
    print(f"  term recall {pct(tuned_scores['recall'])}"
          f"  ({tuned_scores['hits']}/{tuned_scores['terms']})")

    print("")
    wer_delta = tuned_scores["wer"] - base_scores["wer"]
    print(f"WER          {wer_delta * 100:+.2f} points  (lower is better)")
    if base_scores["recall"] is not None and tuned_scores["recall"] is not None:
        recall_delta = tuned_scores["recall"] - base_scores["recall"]
        print(f"term recall  {recall_delta * 100:+.2f} points  (higher is better)")
    else:
        recall_delta = None

    print("")
    if recall_delta is None:
        print("No corrected terms in the eval split, so this only measured general WER.")
    elif recall_delta > 0.02 and wer_delta < 0.02:
        print("Keep it. Names improved and general accuracy held.")
    elif wer_delta > 0.05:
        print("Throw it away. General accuracy dropped materially — that is forgetting.")
        print("Try fewer epochs or a lower --lr, or collect more clips first.")
    elif recall_delta <= 0:
        print("No gain on the names it was trained for. More clips, or more epochs.")
    else:
        print("Marginal. Worth collecting more clips before deciding.")

    if tuned_scores["misses"]:
        shown = sorted(set(tuned_scores["misses"]))[:10]
        print("")
        print("still missed: " + ", ".join(shown))

    print("")
    print("Caveat: this eval set is your own dictation, so it cannot detect the model")
    print("getting worse at English it never sees here. Keep a few ordinary, name-free")
    print("dictations in the eval split if you want that signal.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
