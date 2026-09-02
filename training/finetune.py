#!/usr/bin/env python3
"""VoxDen ASR v0.1: CUDA LoRA -> adapter -> merged HF -> validated CT2 candidate."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from artifacts import OUTPUT, WORK, file_hash, new_metadata, now, require_empty, validate_ct2, validate_output_paths, versions
from dataset import DATA, SAMPLE_RATE, fingerprint, identities, write_json
from evaluate import load_sets, protocol_for, require_baseline
from inference import local_environment, resolve_stock, validate_standalone


def require_cuda():
    import torch
    available = torch.cuda.is_available()
    print(f'CUDA available: {available}; PyTorch CUDA: {torch.version.cuda}', flush=True)
    if not available:
        raise ValueError('CUDA training is required. Install a CUDA PyTorch wheel in the training environment; CPU training is disabled.')
    print(f'GPU: {torch.cuda.get_device_name(0)}', flush=True)
    try:
        free, total = torch.cuda.mem_get_info()
        print(f'VRAM: {free / 2**30:.2f} GiB free / {total / 2**30:.2f} GiB total', flush=True)
    except RuntimeError:
        print('VRAM availability could not be queried.')


def configure_lora(model, args):
    import torch
    from peft import LoraConfig, get_peft_model
    # Generic PEFT wrapper: SEQ_2_SEQ_LM wrappers expect input_ids, not audio.
    model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=args.alpha,
        target_modules=args.target_modules, lora_dropout=args.dropout, bias='none'))
    # AMP GradScaler cannot unscale FP16 trainable gradients. Keep only adapter
    # parameters in FP32; the frozen base can remain in FP16.
    for parameter in model.parameters():
        if parameter.requires_grad:
            parameter.data = parameter.data.to(torch.float32)
    model.config.use_cache = False
    model.accepts_loss_kwargs = False
    model.print_trainable_parameters()
    return model


def build_dataset(rows, processor, max_target_positions):
    import numpy as np
    import soundfile as sf
    from torch.utils.data import Dataset
    labels = []
    for row in rows:
        processor.tokenizer.set_prefix_tokens(language=row['language'], task='transcribe', predict_timestamps=False)
        tokens = processor.tokenizer(row['sentence']).input_ids
        if len(tokens) - 1 > max_target_positions:
            raise ValueError(f"sample {row['id']}: transcript exceeds decoder context; align manually, never truncate")
        labels.append(tokens)

    class ClipDataset(Dataset):
        def __len__(self):
            return len(rows)

        def __getitem__(self, index):
            # Manifest already checks the full WAV; repeat shape bounds to prevent
            # the feature extractor silently truncating a changed recording.
            audio, rate = sf.read(rows[index]['audio'], dtype='float32')
            if rate != SAMPLE_RATE or audio.ndim != 1 or not 4000 <= len(audio) <= 480000:
                raise ValueError('audio format/duration changed after validation')
            features = processor.feature_extractor(np.asarray(audio), sampling_rate=rate, return_tensors='np').input_features[0]
            return {'input_features': features, 'labels': labels[index]}

    return ClipDataset()


class Collator:
    def __init__(self, processor, decoder_start_token_id):
        self.processor, self.decoder_start_token_id = processor, decoder_start_token_id

    def __call__(self, features):
        batch = self.processor.feature_extractor.pad(
            [{'input_features': f['input_features']} for f in features], return_tensors='pt')
        padded = self.processor.tokenizer.pad([{'input_ids': f['labels']} for f in features], return_tensors='pt')
        labels = padded['input_ids'].masked_fill(padded.attention_mask.ne(1), -100)
        if (labels[:, 0] == self.decoder_start_token_id).all().cpu().item():
            labels = labels[:, 1:]
        batch['labels'] = labels
        return batch


def training_config(args):
    return {key: getattr(args, key) for key in ('rank', 'alpha', 'dropout', 'target_modules', 'lr',
            'epochs', 'batch', 'accum', 'fp16', 'gradient_checkpointing', 'seed')}


def preflight(args):
    require_cuda()
    train_rows, eval_rows, regression = load_sets(args.train_file, args.eval_file, args.regression_file)
    print(f'Base model: {args.base}; training samples: {len(train_rows)}; held-out samples: {len(eval_rows)}', flush=True)
    print(json.dumps(training_config(args), indent=2), flush=True)
    if len(train_rows) < args.min_clips:
        raise ValueError(f'{len(train_rows)} training clips < --min-clips {args.min_clips}. Collect more; reducing this guard is only an explicit smoke experiment, not evidence of quality.')
    stock_path = resolve_stock(args.stock, args.allow_download)
    protocol = protocol_for(eval_rows, regression, stock_path, device=args.inference_device,
                            compute_type=args.compute_type, quality=args.quality, vad=not args.no_vad,
                            min_term_examples=args.min_term_examples)
    baseline = require_baseline(args.baseline, protocol)
    return train_rows, eval_rows, baseline


def train(args):
    rows, _, baseline = preflight(args)
    from transformers import Seq2SeqTrainer, Seq2SeqTrainingArguments, WhisperForConditionalGeneration, WhisperProcessor, set_seed
    import torch
    adapter, checkpoints = args.work_dir / 'adapter', args.work_dir / 'checkpoints'
    require_empty(adapter)
    require_empty(checkpoints)
    set_seed(args.seed)
    options = {'local_files_only': not args.allow_download, 'cache_dir': str(WORK / 'cache')}
    processor = WhisperProcessor.from_pretrained(args.base, use_fast=True, **options)
    model = WhisperForConditionalGeneration.from_pretrained(args.base,
            torch_dtype=torch.float16 if args.fp16 else torch.float32, **options)
    base_revision = getattr(model.config, '_commit_hash', None)
    dataset = build_dataset(rows, processor, model.config.max_target_positions)
    model = configure_lora(model, args)
    arguments = Seq2SeqTrainingArguments(output_dir=str(checkpoints),
        per_device_train_batch_size=args.batch, gradient_accumulation_steps=args.accum,
        learning_rate=args.lr, warmup_ratio=0.1, num_train_epochs=args.epochs,
        fp16=args.fp16, gradient_checkpointing=args.gradient_checkpointing,
        gradient_checkpointing_kwargs={'use_reentrant': False} if args.gradient_checkpointing else None,
        logging_steps=1, save_strategy='epoch', save_total_limit=2, seed=args.seed, data_seed=args.seed,
        remove_unused_columns=False, label_names=['labels'], report_to=[], push_to_hub=False,
        dataloader_num_workers=0, optim='adamw_torch')
    trainer = Seq2SeqTrainer(model=model, args=arguments, train_dataset=dataset,
                            data_collator=Collator(processor, model.config.decoder_start_token_id))
    trainer.train()
    model.save_pretrained(str(adapter), safe_serialization=True)
    processor.save_pretrained(str(adapter))
    training = {'base_model': args.base, 'base_revision': base_revision, 'training_samples': len(rows),
                'training_fingerprint': fingerprint(rows), 'training_identities': identities(rows),
                'configuration': training_config(args), 'created_at': now(), 'versions': versions(),
                'baseline_protocol': baseline['protocol'], 'baseline_measured_at': baseline['created_at'],
                'baseline_sha256': file_hash(args.baseline)}
    write_json(adapter / 'training.json', training)
    print(f'Adapter saved: {adapter}')


def merge(args):
    import torch
    from peft import PeftModel
    from transformers import WhisperForConditionalGeneration, WhisperProcessor
    adapter, merged_dir = args.work_dir / 'adapter', args.work_dir / 'merged'
    training = json.loads((adapter / 'training.json').read_text(encoding='utf-8'))
    require_empty(merged_dir)
    # Reload the exact recorded base revision, never a different CLI base.
    kwargs = {'local_files_only': not args.allow_download, 'cache_dir': str(WORK / 'cache'), 'torch_dtype': torch.float16}
    if training.get('base_revision'):
        kwargs['revision'] = training['base_revision']
    base = WhisperForConditionalGeneration.from_pretrained(training['base_model'], **kwargs)
    merged = PeftModel.from_pretrained(base, str(adapter), local_files_only=True).merge_and_unload(safe_merge=True)
    merged.config.use_cache = True
    merged.save_pretrained(str(merged_dir), safe_serialization=True)
    WhisperProcessor.from_pretrained(str(adapter), local_files_only=True, use_fast=True).save_pretrained(str(merged_dir))
    write_json(merged_dir / 'training.json', training)
    print(f'Merged Hugging Face model saved: {merged_dir}')


def convert(args):
    from ctranslate2.converters import TransformersConverter
    from dataset import assert_disjoint, load_manifest
    merged = args.work_dir / 'merged'
    training = json.loads((merged / 'training.json').read_text(encoding='utf-8'))
    eval_rows = load_manifest(args.eval_file, expected_split='eval')
    assert_disjoint(training['training_identities'], eval_rows)
    if fingerprint(eval_rows) != training['baseline_protocol']['corrections_fingerprint']:
        raise ValueError('held-out references changed since training')
    require_empty(args.output)
    converter = TransformersConverter(str(merged), copy_files=['tokenizer.json', 'preprocessor_config.json'],
                                       load_as_float16=True)
    converter.convert(str(args.output), quantization=args.quantization, force=False)
    validate_ct2(args.output)
    metadata = new_metadata(training)
    metadata['conversion'] = {'quantization': args.quantization, 'created_at': now(), 'versions': versions()}
    write_json(args.output / 'metadata.json', metadata)
    row = eval_rows[0]
    metadata['standalone_validation'] = validate_standalone(args.output, row['audio'], language=row['language'],
        device=args.inference_device, compute_type=args.compute_type, quality=args.quality, vad=not args.no_vad)
    write_json(args.output / 'metadata.json', metadata)
    print(f'Converted candidate loaded and transcribed held-out speech: {args.output}')


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument('--stage', choices=('all', 'train', 'merge', 'convert'), default='all')
    result.add_argument('--check', action='store_true', help='CUDA/data/baseline preflight only; no weight loading or training')
    result.add_argument('--base', default='openai/whisper-large-v3')
    result.add_argument('--stock', default='large-v3')
    result.add_argument('--train-file', type=Path, default=DATA / 'corrections' / 'train.jsonl')
    result.add_argument('--eval-file', type=Path, default=DATA / 'corrections' / 'eval.jsonl')
    result.add_argument('--regression-file', type=Path, default=DATA / 'regression' / 'eval.jsonl')
    result.add_argument('--baseline', type=Path, default=WORK / 'baseline.json')
    result.add_argument('--work-dir', type=Path, default=WORK)
    result.add_argument('--output', type=Path, default=OUTPUT)
    result.add_argument('--epochs', type=float, default=3.0)
    result.add_argument('--lr', type=float, default=1e-4)
    result.add_argument('--rank', type=int, default=32)
    result.add_argument('--alpha', type=int, default=64)
    result.add_argument('--dropout', type=float, default=0.05)
    result.add_argument('--target-modules', nargs='+', default=['q_proj', 'v_proj'])
    result.add_argument('--batch', type=int, default=1)
    result.add_argument('--accum', type=int, default=8)
    result.add_argument('--min-clips', type=int, default=50)
    result.add_argument('--seed', type=int, default=42)
    result.add_argument('--fp16', action=argparse.BooleanOptionalAction, default=True)
    result.add_argument('--gradient-checkpointing', action=argparse.BooleanOptionalAction, default=True)
    result.add_argument('--quantization', choices=('float16', 'int8_float16', 'int8', 'float32'), default='float16')
    result.add_argument('--inference-device', choices=('cuda', 'cpu'), default='cuda')
    result.add_argument('--compute-type', default='float16')
    result.add_argument('--quality', choices=('accurate', 'fast'), default='accurate')
    result.add_argument('--no-vad', action='store_true')
    result.add_argument('--min-term-examples', type=int, default=3)
    result.add_argument('--allow-download', action='store_true', help='Allow public pretrained weights only; all samples stay local')
    return result


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    args = parser().parse_args(argv)
    try:
        local_environment(args.allow_download)
        args.work_dir, args.output = validate_output_paths(args.work_dir, args.output)
        if min(args.epochs, args.lr, args.rank, args.alpha, args.batch, args.accum, args.min_clips, args.min_term_examples) <= 0 or not 0 <= args.dropout < 1:
            raise ValueError('training hyperparameters must be positive; dropout must be in [0, 1)')
        if args.check:
            preflight(args)
            print('Preflight passed. Model weights/training have not been tested.')
        elif args.stage == 'all':
            # Separate processes release CUDA/CPU allocations between expensive stages.
            for stage in ('train', 'merge', 'convert'):
                subprocess.run([sys.executable, str(Path(__file__).resolve()), *argv, '--stage', stage], check=True)
            command = [sys.executable, str(Path(__file__).with_name('evaluate.py')), '--base', args.stock,
                       '--tuned', str(args.output), '--train-file', str(args.train_file), '--eval-file', str(args.eval_file),
                       '--regression-file', str(args.regression_file), '--baseline', str(args.baseline),
                       '--output', str(args.work_dir / 'comparison.json'), '--device', args.inference_device,
                       '--compute-type', args.compute_type, '--quality', args.quality,
                       '--min-term-examples', str(args.min_term_examples)]
            if args.no_vad:
                command.append('--no-vad')
            if args.allow_download:
                command.append('--allow-download')
            subprocess.run(command, check=True)
        else:
            {'train': train, 'merge': merge, 'convert': convert}[args.stage](args)
        return 0
    except subprocess.CalledProcessError as exc:
        print(f'Build stopped at a failed stage (exit {exc.returncode}); no model was promoted.', file=sys.stderr)
        return 1
    except (ValueError, RuntimeError, OSError, ImportError, KeyError) as exc:
        if 'out of memory' in str(exc).lower():
            print('CUDA out of memory. Close other GPU workloads; use --batch 1, --gradient-checkpointing, or a lower --rank. '
                  'Increasing --accum alone does not reduce memory at batch 1. No CPU fallback.', file=sys.stderr)
        else:
            print(f'Build stopped: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
