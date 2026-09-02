"""Baseline and paired standalone evaluation. No application integration."""
from __future__ import annotations

import argparse
import gc
import json
import sys
import time
from pathlib import Path

from artifacts import OUTPUT, WORK, file_hash, model_signature, now, record_benchmark
from dataset import DATA, assert_disjoint, assert_not_trained_on, fingerprint, load_manifest, write_json
from inference import decode_protocol, load_model, resolve_stock, transcribe
from metrics import paired_bootstrap, METRIC_POLICY, score


def load_sets(train_file, eval_file, regression_file):
    train = load_manifest(assert_not_trained_on(train_file), expected_split='train')
    corrections = load_manifest(eval_file, expected_split='eval')
    assert_disjoint(train, corrections)
    regression = None
    if regression_file and Path(regression_file).exists():
        regression = load_manifest(regression_file, corrected=False)
        assert_disjoint(train, regression)
        assert_disjoint(corrections, regression)
    elif regression_file and Path(regression_file) != DATA / 'regression' / 'eval.jsonl':
        raise ValueError(f'explicit regression manifest is missing: {regression_file}')
    return train, corrections, regression


def protocol_for(corrections, regression, stock_path, *, device='cuda', compute_type='float16', quality='accurate', vad=True, min_term_examples=3):
    return {'corrections_fingerprint': fingerprint(corrections),
            'regression_fingerprint': fingerprint(regression) if regression else None,
            'correction_samples': len(corrections), 'regression_samples': len(regression) if regression else 0,
            'decode': decode_protocol(device, compute_type, quality, vad),
            'stock_model_signature': model_signature(stock_path),
            'metrics': METRIC_POLICY, 'min_term_examples': min_term_examples}


def require_baseline(path, protocol):
    report = json.loads(Path(path).read_text(encoding='utf-8'))
    if report.get('protocol') != protocol or 'stock' not in report.get('models', {}):
        raise ValueError('baseline dataset, model or evaluation settings differ; baseline must match the frozen experiment protocol')
    if report['models']['stock'].get('model_signature') != protocol['stock_model_signature']:
        raise ValueError('baseline stock model signature mismatch')
    return report


def compare(stock, tuned, *, iterations=2000, seed=0, confidence=0.95):
    """Paired bootstrap over clips for each dataset both systems scored.

    Kept separate from `assess` so the notes stay a list of sentences while the
    numbers stay machine-readable. A baseline recorded before per-clip counts
    existed cannot be resampled; that is reported, not raised, so an otherwise
    valid comparison still completes.
    """
    out = {}
    for dataset in ('corrections', 'regression'):
        left, right = stock.get(dataset), tuned.get(dataset)
        if not left or not right:
            out[dataset] = {'available': False, 'reason': 'dataset not scored for both models'}
            continue
        entry = {}
        for metric in ('wer', 'cer'):
            try:
                entry[metric] = paired_bootstrap(left['predictions'], right['predictions'],
                                                 metric=metric, iterations=iterations,
                                                 seed=seed, confidence=confidence)
            except (ValueError, KeyError) as exc:
                entry[metric] = {'available': False, 'reason': str(exc)}
        out[dataset] = {'available': True, **entry}
    return out


def assess(stock, tuned, comparison=None):
    notes = ['Experimental candidate only; no automatic promotion or application changes.']
    for dataset in ('corrections', 'regression'):
        if stock[dataset] is None or tuned[dataset] is None:
            notes.append('General regression benchmarking unavailable until real independent samples are added.')
            continue
        for metric in ('wer', 'cer'):
            delta = tuned[dataset][metric] - stock[dataset][metric]
            notes.append(f'{dataset} {metric.upper()}: {delta * 100:+.2f} percentage points (positive is worse).')
    before, after = stock['corrections']['term_recall'], tuned['corrections']['term_recall']
    if before is None or after is None:
        notes.append('Corrected-term recall unavailable: no eligible corrected terms.')
    else:
        notes.append(f'Corrected-term recall: {(after - before) * 100:+.2f} percentage points.')
    if tuned['corrections']['samples'] < 30:
        notes.append('Very small held-out set: metrics do not establish a reliable improvement.')
    for dataset, result in (comparison or {}).items():
        wer = (result or {}).get('wer') if result.get('available') else None
        if not wer or wer.get('available') is False:
            continue
        low, high = wer['interval']
        notes.append(
            f'{dataset} WER delta {wer["observed_delta"] * 100:+.2f} points, '
            f'{int(wer["confidence"] * 100)}% paired-bootstrap interval '
            f'[{low * 100:+.2f}, {high * 100:+.2f}] over {wer["clips"]} clips. '
            'Percentile bootstrap, not a significance test.')
    return notes


def evaluate_model(path, corrections, regression, *, device, compute_type, quality, vad, min_term_examples):
    model = load_model(path, device=device, compute_type=compute_type)
    result = {'model_signature': model_signature(path)}
    try:
        for name, rows in (('corrections', corrections), ('regression', regression)):
            if rows is None:
                result[name] = None
                continue
            started = time.perf_counter()
            hypotheses = []
            for index, row in enumerate(rows, 1):
                hypotheses.append(transcribe(model, row, quality=quality, vad=vad))
                print(f'{name}: {index}/{len(rows)}', flush=True)
            result[name] = score(rows, hypotheses, min_term_examples)
            result[name]['elapsed_seconds'] = time.perf_counter() - started
    finally:
        del model
        gc.collect()
    return result


def print_scores(report):
    def pct(value):
        return 'n/a' if value is None else f'{value * 100:.2f}%'
    print(f"{'MODEL / DATASET':<38} {'N':>5} {'WER':>9} {'CER':>9} {'TERM RECALL':>13}")
    for name, model in report['models'].items():
        for dataset in ('corrections', 'regression'):
            scores = model[dataset]
            if scores is not None:
                label = ('Whisper large-v3' if name == 'stock' else 'VoxDen ASR v0.1') + ' / ' + dataset
                print(f"{label:<38} {scores['samples']:>5} {pct(scores['wer']):>9} {pct(scores['cer']):>9} {pct(scores['term_recall']):>13}")
                if scores['term_examples']:
                    print(f"  corrected-term hits: {scores['term_hits']}/{scores['term_examples']}")
    for note in report.get('assessment', []):
        print(note)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='large-v3', help='Stock faster-whisper identifier or local CT2 directory')
    parser.add_argument('--tuned', type=Path, default=OUTPUT)
    parser.add_argument('--train-file', type=Path, default=DATA / 'corrections' / 'train.jsonl')
    parser.add_argument('--eval-file', type=Path, default=DATA / 'corrections' / 'eval.jsonl')
    parser.add_argument('--regression-file', type=Path, default=DATA / 'regression' / 'eval.jsonl')
    parser.add_argument('--baseline', type=Path, default=WORK / 'baseline.json')
    parser.add_argument('--output', type=Path, help='Default: baseline.json for --base-only, comparison.json otherwise')
    parser.add_argument('--base-only', action='store_true')
    parser.add_argument('--allow-download', action='store_true', help='Permit public stock weight download; never uploads samples')
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--compute-type', default='float16')
    parser.add_argument('--quality', choices=('accurate', 'fast'), default='accurate')
    parser.add_argument('--no-vad', action='store_true')
    parser.add_argument('--min-term-examples', type=int, default=3)
    args = parser.parse_args(argv)
    try:
        if args.min_term_examples < 1:
            raise ValueError('--min-term-examples must be positive')
        train, corrections, regression = load_sets(args.train_file, args.eval_file, args.regression_file)
        if regression is None:
            print('General regression benchmarking unavailable: no real regression manifest provided.')
        stock_path = resolve_stock(args.base, args.allow_download)
        options = dict(device=args.device, compute_type=args.compute_type, quality=args.quality,
                       vad=not args.no_vad, min_term_examples=args.min_term_examples)
        protocol = protocol_for(corrections, regression, stock_path, **options)
        report = {'created_at': now(), 'protocol': protocol, 'models': {}, 'assessment': []}
        if args.base_only:
            report['models']['stock'] = evaluate_model(stock_path, corrections, regression, **options)
        else:
            baseline = require_baseline(args.baseline, protocol)
            metadata = json.loads((args.tuned / 'metadata.json').read_text(encoding='utf-8'))
            training = metadata['training']
            if training['baseline_sha256'] != file_hash(args.baseline):
                raise ValueError('pre-training baseline report changed since training; restore the original report')
            if training['baseline_protocol'] != protocol:
                raise ValueError('candidate training used a different baseline protocol')
            for rows in (corrections, regression or []):
                assert_disjoint(training['training_identities'], rows)
            validation = metadata.get('standalone_validation') or {}
            if not validation.get('passed') or validation.get('model_signature') != model_signature(args.tuned):
                raise ValueError('candidate has no passing standalone inference test for these weights')
            report['models']['stock'] = baseline['models']['stock']
            report['stock_measured_at'] = baseline['created_at']
            report['models']['voxden'] = evaluate_model(args.tuned, corrections, regression, **options)
            report['comparison'] = compare(report['models']['stock'], report['models']['voxden'])
            report['assessment'] = assess(report['models']['stock'], report['models']['voxden'],
                                          report['comparison'])
        output = args.output or (args.baseline if args.base_only else WORK / 'comparison.json')
        if not args.base_only and output.resolve() == args.baseline.resolve():
            raise ValueError('comparison output must not overwrite the pre-training baseline')
        write_json(output, report)
        if not args.base_only:
            record_benchmark(args.tuned, report)
        print_scores(report)
        print(f'Local results: {output}')
        return 0
    except (ValueError, OSError, RuntimeError, ImportError, KeyError) as exc:
        print(f'Evaluation stopped: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
