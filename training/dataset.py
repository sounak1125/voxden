"""Local corpus export and strict, model-free dataset validation."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'training' / 'data'

# Four data roles, kept physically separate so a mistake has to be deliberate.
#
#   data/audio/pairs.jsonl              source corpus the app collects (opt-in)
#   CORRECTIONS/train.jsonl             real corrected samples, TRAIN
#   CORRECTIONS/eval.jsonl              real corrected samples, held-out IN-DOMAIN eval
#   REGRESSION/eval.jsonl               deliberately recorded GENERAL regression
#   SUPERVISED/train.jsonl              deliberately recorded verified speech, trainable
#
# The correction partitions are split by audio hash and cannot be chosen. The
# regression set is chosen on purpose and is never trained on -- that is the
# whole reason it can say anything about forgetting. SUPERVISED exists so that
# deliberately recorded speech has somewhere to go that is *not* the regression
# set; mixing the two would quietly turn the only independent yardstick into
# more training data.
CORRECTIONS = DATA / 'corrections'
REGRESSION = DATA / 'regression'
SUPERVISED = DATA / 'supervised'
EVAL_ONLY = (REGRESSION,)


def assert_not_trained_on(path, *, what='a training input'):
    """Refuse an evaluation-only manifest where training data is expected."""
    resolved = Path(path).resolve()
    for directory in EVAL_ONLY:
        directory = directory.resolve()
        if resolved == directory or directory in resolved.parents:
            raise ValueError(
                f'{path} is the independent regression set and must never be used as {what}. '
                'Record trainable speech into the supervised role instead '
                '(training/record.py --role supervised).')
    return Path(path)
SAMPLE_RATE = 16000
MIN_SECONDS = 0.25
MAX_SECONDS = 30.0
SPLIT_POLICY = 'pcm-sha256-fixed-10pct-v1'


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temporary.replace(path)


def read_jsonl(path):
    path = Path(path)
    rows, errors = [], []
    for number, line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError('expected a JSON object')
            rows.append(row)
        except (ValueError, TypeError) as exc:
            errors.append({'line': number, 'reason': f'invalid JSON record: {exc}'})
    return rows, errors


def validate_riff(path):
    """Reject damaged chunk lengths before a permissive audio decoder repairs them."""
    try:
        with Path(path).open('rb') as stream:
            size = Path(path).stat().st_size
            header = stream.read(12)
            if len(header) != 12 or header[:4] != b'RIFF' or header[8:] != b'WAVE':
                raise ValueError('unreadable/corrupt RIFF WAV header')
            end = struct.unpack('<I', header[4:8])[0] + 8
            if end != size:
                raise ValueError('truncated/corrupt WAV: RIFF size differs from file size')
            found = set()
            while stream.tell() < end:
                chunk = stream.read(8)
                if len(chunk) != 8:
                    raise ValueError('truncated WAV chunk header')
                length = struct.unpack('<I', chunk[4:])[0]
                next_offset = stream.tell() + length + (length % 2)
                if next_offset > end:
                    raise ValueError('truncated WAV chunk payload')
                if chunk[:4] in (b'fmt ', b'data'):
                    if chunk[:4] in found:
                        raise ValueError('duplicate WAV format/data chunks are unsupported')
                    found.add(chunk[:4])
                stream.seek(next_offset)
            if found != {b'fmt ', b'data'}:
                raise ValueError('WAV lacks format or audio data chunk')
    except OSError as exc:
        raise ValueError(f'audio is missing or unreadable: {exc}') from exc


def inspect_wav(path):
    """Read all frames, not just the header. Strict PCM avoids decoder ambiguity."""
    path = Path(path)
    if not path.is_file():
        raise ValueError('audio is missing or is not a file')
    validate_riff(path)
    try:
        with wave.open(str(path), 'rb') as wav:
            channels, width, rate, frames, compression, _ = wav.getparams()
            if compression != 'NONE' or width != 2 or channels != 1 or rate != SAMPLE_RATE:
                raise ValueError('requires PCM16 mono 16000 Hz WAV; export with --normalize to convert supported WAVs')
            duration = frames / rate
            if not MIN_SECONDS <= duration <= MAX_SECONDS:
                raise ValueError(f'duration {duration:.3f}s outside {MIN_SECONDS}–{MAX_SECONDS}s; align longer clips manually, never truncate')
            pcm = wav.readframes(frames)
            if len(pcm) != frames * channels * width:
                raise ValueError('truncated WAV data')
            if not any(pcm):
                raise ValueError('audio contains only digital silence')
    except (wave.Error, EOFError, OSError) as exc:
        raise ValueError(f'unreadable/corrupt WAV: {exc}') from exc
    return {'audio_sha256': hashlib.sha256(pcm).hexdigest(), 'duration': duration,
            'sample_rate': rate, 'channels': channels}


def normalize_wav(source, destination):
    """Optional local conversion; originals are never edited."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    validate_riff(source)
    info = sf.info(str(source))
    if info.format not in ('WAV', 'WAVEX') or info.channels not in (1, 2):
        raise ValueError('normalization supports mono/stereo WAV only')
    if not MIN_SECONDS <= info.duration <= MAX_SECONDS:
        raise ValueError('audio duration outside 0.25–30 seconds')
    audio, rate = sf.read(str(source), dtype='float32', always_2d=True)
    if len(audio) != info.frames or not np.isfinite(audio).all():
        raise ValueError('truncated or non-finite audio')
    audio = audio.mean(axis=1)
    if rate != SAMPLE_RATE:
        divisor = math.gcd(rate, SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // divisor, rate // divisor)
    destination.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(destination), np.clip(audio, -1, 1), SAMPLE_RATE, subtype='PCM_16')
    return inspect_wav(destination)


def split_for(audio_sha256):
    # Fixed threshold: identical decoded PCM keeps its partition under new IDs.
    return 'eval' if int(audio_sha256[:16], 16) < (1 << 64) // 10 else 'train'


def validate_rows(rows, manifest_dir, *, corrected=True):
    accepted, rejected = [], []
    for index, row in enumerate(rows, 1):
        try:
            if not isinstance(row.get('id'), str) or not row['id'].strip():
                raise ValueError('missing stable sample id')
            if not isinstance(row.get('sentence'), str) or not row['sentence'].strip():
                raise ValueError('empty corrected transcript' if corrected else 'empty reference transcript')
            if not any(c.isalnum() for c in row['sentence']):
                raise ValueError('transcript contains no letters or numbers')
            if corrected and row.get('label_source') != 'user_correction':
                raise ValueError('corrected transcript provenance is unavailable; export the opt-in pairs manifest')
            if not isinstance(row.get('language'), str) or not row['language'].strip():
                raise ValueError('language is missing; declare it explicitly at export')
            if 'raw_transcript' in row and not isinstance(row['raw_transcript'], str):
                raise ValueError('raw transcript must be text when supplied')
            if 'learned' in row and (not isinstance(row['learned'], list) or any(
                    not isinstance(item, dict) or not isinstance(item.get('to'), str) for item in row['learned'])):
                raise ValueError('invalid learned correction annotations')
            if not isinstance(row.get('audio'), str) or not row['audio'].strip():
                raise ValueError('audio path is missing')
            audio = (Path(manifest_dir) / row['audio']).resolve()
            details = inspect_wav(audio)
            if row.get('audio_sha256') and row['audio_sha256'] != details['audio_sha256']:
                raise ValueError('audio changed since export (checksum mismatch)')
            accepted.append({**row, **details, 'audio': str(audio), 'sentence': row['sentence'].strip()})
        except (ValueError, TypeError, OSError) as exc:
            rejected.append({'row': index, 'id': row.get('id'), 'reason': str(exc)})

    # Exclude all conflicting labels, instead of choosing an arbitrary winner.
    ids, hashes = {}, {}
    for row in accepted:
        ids.setdefault(row['id'], set()).add((row['audio_sha256'], row['sentence'], row['language']))
        hashes.setdefault(row['audio_sha256'], set()).add((row['sentence'], row['language']))
    unique, seen_ids, seen_audio = [], set(), set()
    for row in sorted(accepted, key=lambda r: r['id']):
        reason = None
        if len(ids[row['id']]) > 1 or len(hashes[row['audio_sha256']]) > 1:
            reason = 'conflicting duplicate ID/audio labels; review manually'
        elif row['id'] in seen_ids or row['audio_sha256'] in seen_audio:
            reason = 'duplicate sample ID or decoded audio'
        if reason:
            rejected.append({'id': row['id'], 'reason': reason})
        else:
            unique.append(row)
            seen_ids.add(row['id'])
            seen_audio.add(row['audio_sha256'])
    return unique, rejected


def load_manifest(path, *, corrected=True, expected_split=None):
    path = Path(path)
    rows, errors = read_jsonl(path)
    rows, rejected = validate_rows(rows, path.parent, corrected=corrected)
    errors += rejected
    if errors:
        raise ValueError(f'{path}: rejected {len(errors)} record(s): ' + '; '.join(e['reason'] for e in errors[:8]))
    if not rows:
        raise ValueError(f'{path}: no validated samples')
    if expected_split:
        for row in rows:
            if row.get('split_policy') != SPLIT_POLICY or split_for(row['audio_sha256']) != expected_split:
                raise ValueError(f'{path}: row is not in the fixed {expected_split} partition; re-export')
    return rows


def identities(rows):
    return [{'id_sha256': hashlib.sha256(r['id'].encode()).hexdigest(), 'audio_sha256': r['audio_sha256']} for r in rows]


def assert_disjoint(left, right):
    def keys(rows):
        return {('id', r.get('id_sha256') or hashlib.sha256(r['id'].encode()).hexdigest()) for r in rows} | {
            ('audio', r['audio_sha256']) for r in rows}
    if keys(left) & keys(right):
        raise ValueError('dataset leakage: overlapping sample IDs or audio between partitions')


def fingerprint(rows):
    records = [{k: r.get(k) for k in ('id', 'audio_sha256', 'sentence', 'language', 'raw_transcript', 'learned')}
               for r in sorted(rows, key=lambda r: r['id'])]
    return hashlib.sha256(json.dumps(records, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def export_pairs(audio_dir, output, *, language=None, write=False, normalize=False):
    audio_dir, output = Path(audio_dir).resolve(), Path(output).resolve()
    if output == audio_dir or output in audio_dir.parents or audio_dir in output.parents:
        raise ValueError('export output must be separate from the source corpus directory')
    pairs_file = audio_dir / 'pairs.jsonl'
    if not pairs_file.exists():
        raise ValueError(f'No corrected pairs at {pairs_file}. Collect opt-in corrected dictations first, or use --audio-dir.')
    pairs, rejected = read_jsonl(pairs_file)
    candidates = []
    for pair in pairs:
        try:
            if not isinstance(pair.get('text'), str) or not pair['text'].strip():
                raise ValueError('empty or unavailable user-corrected text')
            if not isinstance(pair.get('audio'), str) or not pair['audio'].strip():
                raise ValueError('audio path is missing')
            source = (audio_dir / pair['audio']).resolve()
            if not source.is_relative_to(audio_dir):
                raise ValueError('audio path escapes the selected corpus directory')
            row = {'id': pair.get('id'), 'audio': str(source), 'sentence': pair['text'],
                   'language': pair.get('language') or language, 'label_source': 'user_correction',
                   'language_source': 'recorded' if pair.get('language') else 'export_argument'}
            for key in ('learned', 'ts', 'seconds', 'bytes', 'engine', 'detected_language'):
                if key in pair:
                    row[key] = pair[key]
            if 'asr' in pair:
                row['raw_transcript'] = pair['asr']
            if normalize:
                if not write:
                    raise ValueError('--normalize requires --write; inspection never creates audio')
                destination = output / 'audio' / (hashlib.sha256(source.read_bytes()).hexdigest() + '.wav')
                normalize_wav(source, destination)
                row['audio'] = str(destination)
                row['normalization'] = 'mono PCM16 16000 Hz; stereo mean; polyphase resampling'
            candidates.append(row)
        except (ValueError, OSError, RuntimeError) as exc:
            rejected.append({'id': pair.get('id'), 'reason': str(exc)})
    rows, invalid = validate_rows(candidates, audio_dir)
    rejected.extend(invalid)
    splits = {name: [{**r, 'split': name, 'split_policy': SPLIT_POLICY} for r in rows
                     if split_for(r['audio_sha256']) == name] for name in ('train', 'eval')}
    assert_disjoint(splits['train'], splits['eval'])
    report = {'source_records': len(pairs), 'accepted': len(rows), 'rejected': rejected,
              'train_samples': len(splits['train']), 'eval_samples': len(splits['eval']),
              'duration_seconds': sum(r['duration'] for r in rows), 'split_policy': SPLIT_POLICY,
              'fingerprint': fingerprint(rows)}
    if write:
        output.mkdir(parents=True, exist_ok=True)
        for name, records in splits.items():
            target = output / (name + '.jsonl')
            temporary = target.with_suffix('.jsonl.tmp')
            temporary.write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records), encoding='utf-8')
            temporary.replace(target)
        write_json(output / 'export-report.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio-dir', type=Path, default=ROOT / 'data' / 'audio')
    parser.add_argument('--output', type=Path, default=DATA / 'corrections')
    parser.add_argument('--language', help='Language label for records lacking one, e.g. en; never guessed')
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--normalize', action='store_true', help='Copy/normalize supported WAVs; needs soundfile, numpy, scipy')
    args = parser.parse_args()
    try:
        report = export_pairs(args.audio_dir, args.output, language=args.language, write=args.write, normalize=args.normalize)
        for rejection in report['rejected']:
            print(f"WARNING {rejection.get('id', rejection.get('line', '?'))}: {rejection['reason']}", file=sys.stderr)
        print(f"Validated {report['accepted']} samples ({report['duration_seconds']:.1f}s); rejected {len(report['rejected'])}.")
        print(f"Fixed split: {report['train_samples']} train / {report['eval_samples']} evaluation.")
        if not report['train_samples'] or not report['eval_samples']:
            print('WARNING: a partition is empty; collect more real samples. Do not move samples to force a split.')
        print(f"Output: {args.output}" if args.write else 'Inspection only. Use --write to export.')
        return 0 if report['accepted'] else 1
    except (ValueError, OSError, ImportError) as exc:
        print(f'Export stopped: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
