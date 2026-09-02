#!/usr/bin/env python
"""Record deliberately-read speech into one of the two recorded-audio roles.

Why this exists
---------------
Corrected dictation pairs arrive at the rate the user happens to make mistakes:
the first real export was 7 pairs and 90.3 seconds. Worse, `split_for()` assigns
partitions by audio hash, so a held-out set cannot be chosen -- only waited for,
at ten percent of whatever accumulates. Reading a known script produces labelled
audio at the rate of speech instead.

Roles
-----
Two destinations, because deliberately recorded speech can serve two purposes
that must never be confused:

  --role regression  ->  training/data/regression/eval.jsonl
      Independent general evaluation. NEVER trained on. `evaluate.load_sets`
      loads it with `corrected=False` and no `expected_split`, then asserts it
      disjoint from both correction partitions. Held out by construction; that
      is what lets it say anything about forgetting.

  --role supervised  ->  training/data/supervised/train.jsonl
      Deliberately recorded, manually verified speech that IS allowed to train.
      Exists so trainable read speech has somewhere to go that is not the
      regression set.

A sentence recorded into one role is refused by the other. Mixing them would
quietly turn the only independent yardstick into more training data.

What this is not: a speech benchmark. It produces labelled audio. What that
audio can support depends on how much of it there is and how varied it is -- see
`--summary`, which reports the uncertainty rather than hiding it.
"""
import argparse
import contextlib
import datetime
import hashlib
import json
import math
import os
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dataset import (MAX_SECONDS, MIN_SECONDS, REGRESSION, SAMPLE_RATE, SUPERVISED, inspect_wav,
                     load_manifest)

PROMPTS = Path(__file__).resolve().parent / 'prompts' / 'read-speech-en.txt'
FULL_SCALE = 32767

ROLES = {
    'regression': {
        'directory': REGRESSION,
        'manifest': 'eval.jsonl',
        'label_source': 'read_script',
        'trainable': False,
        'blurb': 'independent general regression evaluation -- never trained on',
    },
    'supervised': {
        'directory': SUPERVISED,
        'manifest': 'train.jsonl',
        'label_source': 'read_script_supervised',
        'trainable': True,
        'blurb': 'deliberately recorded verified speech -- may be used for training',
    },
}

# Audio-quality thresholds, in dBFS so they travel across microphones better
# than a raw sample count does. They are heuristics for catching a session that
# is going wrong, not a quality standard: a single peak gate rejects quiet but
# perfectly usable speech and waves through a room-tone recording with one door
# slam in it, which is why several weak signals are combined instead.
SPEECH_MARGIN_DB = 12.0      # how far above its own noise floor a frame must sit
ABSOLUTE_SPEECH_DB = -45.0   # loud enough to be speech regardless of the noise floor
ABSOLUTE_FLOOR_DB = -55.0    # below this a frame is not speech on any gain setting
UNUSABLE_PEAK_DB = -50.0     # hard reject: nothing was captured
UNUSABLE_SPEECH_RATIO = 0.10 # hard reject: essentially no speech in the take
LOW_PEAK_DB = -26.0          # warn: quiet, still probably usable
LOW_RMS_DB = -40.0           # warn: quiet overall
THIN_SPEECH_RATIO = 0.35     # warn: mostly silence around a short utterance
CLIPPING_RATIO = 0.005       # warn: sustained clipping, not one transient
FRAME_MS, HOP_MS = 30, 10
# Nothing is ever truncated -- a long take is refused and re-read -- but the
# buffer still needs a ceiling so a forgotten session cannot eat all of memory.
HARD_STOP_SECONDS = 180.0


def decibels(value):
    return -math.inf if value <= 0 else 20 * math.log10(value / FULL_SCALE)


def analyse(pcm_bytes):
    """Several weak signals about whether a take contains usable speech.

    `speech_ratio` is an energy-based proxy, not a trained voice activity
    detector. A frame counts as speech when it is loud in absolute terms, or
    when it stands clear of this take's own noise floor. The absolute test has
    to be there: a continuous read with no leading silence has a noise floor
    equal to the speech itself, and a purely relative threshold scores it at
    zero percent and throws away a perfectly good clip.

    The trade-off runs the safe way. A loud constant hum would be miscounted as
    speech, but the person holding the microphone knows whether they just spoke;
    a false accept costs one reviewable clip, a false reject costs a re-read of
    something that was fine. Substituting a real VAD would sharpen this without
    changing any caller -- the returned keys are the interface.
    """
    import numpy

    samples = numpy.frombuffer(pcm_bytes, dtype='<i2')
    total = int(samples.size)
    if not total:
        return {'samples': 0, 'seconds': 0.0, 'peak': 0, 'peak_db': -math.inf,
                'rms_db': -math.inf, 'speech_ratio': 0.0, 'clipping_ratio': 0.0,
                'noise_floor_db': -math.inf, 'silent': True}

    values = samples.astype(numpy.float64)
    peak = int(numpy.abs(samples).max())
    rms = float(numpy.sqrt(numpy.mean(values * values)))
    clipped = int(numpy.count_nonzero(numpy.abs(samples) >= FULL_SCALE - 8))

    frame = int(SAMPLE_RATE * FRAME_MS / 1000)
    hop = int(SAMPLE_RATE * HOP_MS / 1000)
    speech_ratio, floor_db = 0.0, -math.inf
    if total >= frame:
        count = 1 + (total - frame) // hop
        strides = (values.strides[0] * hop, values.strides[0])
        windows = numpy.lib.stride_tricks.as_strided(values, shape=(count, frame), strides=strides)
        power = numpy.sqrt(numpy.mean(windows * windows, axis=1))
        with numpy.errstate(divide='ignore'):
            energies = 20 * numpy.log10(numpy.where(power > 0, power, numpy.nan) / FULL_SCALE)
        finite = energies[numpy.isfinite(energies)]
        if finite.size:
            floor_db = float(numpy.percentile(finite, 10))
            relative = max(floor_db + SPEECH_MARGIN_DB, ABSOLUTE_FLOOR_DB)
            loud = numpy.nan_to_num(energies, nan=-math.inf)
            speech_ratio = float(numpy.count_nonzero(
                (loud >= ABSOLUTE_SPEECH_DB) | (loud >= relative)) / energies.size)

    return {'samples': total, 'seconds': total / SAMPLE_RATE, 'peak': peak,
            'peak_db': decibels(peak), 'rms_db': decibels(rms),
            'speech_ratio': speech_ratio, 'clipping_ratio': clipped / total,
            'noise_floor_db': floor_db, 'silent': peak == 0}


def review(quality):
    """Split the verdict in two: what is unusable, and what is merely poor.

    Only genuine failures block a take. Everything else is a recommendation the
    reader can accept or override, because a quiet recording from a distant
    microphone is still real speech with a real transcript.
    """
    errors, warnings = [], []
    seconds = quality['seconds']
    if seconds > MAX_SECONDS:
        errors.append(f'{seconds:.1f}s exceeds the {MAX_SECONDS:.0f}s ceiling; the pipeline'
                      ' refuses it and never truncates -- read it again, faster')
    elif seconds < MIN_SECONDS:
        errors.append(f'{seconds:.2f}s is too short to be speech')
    if quality['silent']:
        errors.append('digital silence -- nothing reached the input at all')
    elif quality['peak_db'] < UNUSABLE_PEAK_DB:
        errors.append(f'peak {quality["peak_db"]:.0f} dBFS -- the microphone is not picking you up')
    elif quality['speech_ratio'] < UNUSABLE_SPEECH_RATIO:
        errors.append(f'only {quality["speech_ratio"] * 100:.0f}% of frames rise above the noise'
                      ' floor -- this is room tone, not a read line')

    if not errors:
        if quality['peak_db'] < LOW_PEAK_DB:
            warnings.append(f'quiet: peak {quality["peak_db"]:.0f} dBFS'
                            f' (comfortable is above {LOW_PEAK_DB:.0f})')
        if quality['rms_db'] < LOW_RMS_DB:
            warnings.append(f'low average level: {quality["rms_db"]:.0f} dBFS')
        if quality['speech_ratio'] < THIN_SPEECH_RATIO:
            warnings.append(f'mostly silence: {quality["speech_ratio"] * 100:.0f}% speech frames'
                            ' -- trim the pauses by starting and stopping closer to the words')
        if quality['clipping_ratio'] > CLIPPING_RATIO:
            warnings.append(f'clipping on {quality["clipping_ratio"] * 100:.1f}% of samples'
                            ' -- lower the input gain')
    return errors, warnings


def read_prompts(path):
    """One sentence per line; blanks and # comments dropped."""
    lines = Path(path).read_text(encoding='utf-8').splitlines()
    out, seen = [], set()
    for raw in lines:
        text = raw.strip()
        if not text or text.startswith('#'):
            continue
        if not any(c.isalnum() for c in text):
            continue
        # A duplicate line would collide on sample id and be rejected later by
        # validate_rows; drop it here where the cause is still obvious.
        if text in seen:
            continue
        seen.add(text)
        out.append(text)
    if not out:
        raise ValueError(f'{path}: no usable prompt lines')
    return out


def sample_id(sentence):
    """Stable across runs, so a re-read replaces its row instead of adding one."""
    return 'read-' + hashlib.sha256(sentence.encode('utf-8')).hexdigest()[:16]


def read_rows(manifest):
    if not Path(manifest).is_file():
        return []
    rows = []
    for line in Path(manifest).read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line:
            continue
        with contextlib.suppress(json.JSONDecodeError):
            rows.append(json.loads(line))
    return rows


def other_role_rows(role):
    """Everything recorded into the roles this one must stay disjoint from."""
    rows = []
    for name, spec in ROLES.items():
        if name == role:
            continue
        rows.extend(read_rows(spec['directory'] / spec['manifest']))
    return rows


def write_rows(manifest, rows):
    """Whole-file rewrite, so a re-read replaces its row rather than appending a
    second one -- validate_rows rejects an id that carries two different takes."""
    manifest = Path(manifest)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    temporary = manifest.with_suffix(manifest.suffix + '.partial')
    body = ''.join(json.dumps(row, ensure_ascii=False) + '\n'
                   for row in sorted(rows, key=lambda r: r['id']))
    temporary.write_text(body, encoding='utf-8')
    os.replace(temporary, manifest)


def write_wav(path, pcm_bytes):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(SAMPLE_RATE)
        stream.writeframes(pcm_bytes)
    return path


def row_for(sentence, audio_path, manifest_dir, language, script_name, role='regression'):
    spec = ROLES[role]
    details = inspect_wav(audio_path)
    return {
        'id': sample_id(sentence),
        'sentence': sentence,
        'language': language,
        'audio': Path(audio_path).relative_to(manifest_dir).as_posix(),
        'audio_sha256': details['audio_sha256'],
        # Provenance, so a later reader can tell read speech from a correction
        # without inferring it from the absence of a split policy. corrected=False
        # is what lets this be anything other than 'user_correction'.
        'label_source': spec['label_source'],
        'role': role,
        'trainable': spec['trainable'],
        'script': script_name,
        'recorded_at': datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
    }


def capture(device):
    """Blocking record: Enter starts, Enter stops. Returns raw PCM16 bytes."""
    import numpy
    import sounddevice

    chunks = []
    captured = {'frames': 0}

    def callback(indata, frames, time_info, status):
        del frames, time_info
        if status:
            print('  audio warning:', status, file=sys.stderr)
        if captured['frames'] < HARD_STOP_SECONDS * SAMPLE_RATE:
            chunks.append(indata.copy())
            captured['frames'] += len(indata)

    stream = sounddevice.InputStream(samplerate=SAMPLE_RATE, channels=1,
                                     dtype='int16', device=device, callback=callback)
    with stream:
        input()
    if not chunks:
        return b''
    return numpy.concatenate(chunks).tobytes()


def session(args, prompts, existing, spec):
    """Returns the rows added or replaced this run."""
    out_dir = Path(args.out)
    audio_dir = out_dir / 'audio'
    done = {row.get('id') for row in existing}
    foreign = {row.get('id'): row.get('role') for row in other_role_rows(args.role)}
    pending = [s for s in prompts if args.redo_all or sample_id(s) not in done]

    clash = [s for s in pending if sample_id(s) in foreign]
    if clash:
        print(f'{len(clash)} prompt(s) are already recorded in another role and will be skipped;'
              ' one sentence must not sit in two roles.')
        pending = [s for s in pending if sample_id(s) not in foreign]

    print(f'role: {args.role} -- {spec["blurb"]}')
    print(f'{len(prompts)} prompts, {len(done)} already recorded, {len(pending)} to go.')
    if not pending:
        print('Nothing left to read. Add sentences with --prompts, or pass --redo-all.')
        return []
    print('Enter starts a take, Enter stops it. Then k=keep, r=redo, s=skip, q=quit.\n')

    rows = {row['id']: row for row in existing}
    changed = []
    for index, sentence in enumerate(pending, 1):
        while True:
            print(f'[{index}/{len(pending)}]  {sentence}')
            print('  Enter to start...', end='', flush=True)
            input()
            print('  recording -- Enter to stop...', end='', flush=True)
            pcm = capture(args.device)
            quality = analyse(pcm)
            print(f'\r  {quality["seconds"]:.1f}s  peak {quality["peak_db"]:.0f} dBFS'
                  f'  rms {quality["rms_db"]:.0f} dBFS'
                  f'  speech {quality["speech_ratio"] * 100:.0f}%' + ' ' * 8)

            errors, warnings = review(quality)
            if errors:
                for message in errors:
                    print(f'  UNUSABLE: {message}')
                print()
                continue
            for message in warnings:
                print(f'  warning: {message}')
            if warnings:
                print('  recommend re-recording; keep it only if you know it is fine.')

            path = write_wav(audio_dir / (sample_id(sentence) + '.wav'), pcm)
            try:
                row = row_for(sentence, path, out_dir, args.language,
                              Path(args.prompts).name, args.role)
            except ValueError as exc:
                path.unlink(missing_ok=True)
                print(f'  rejected: {exc}\n')
                continue

            default = 'r' if warnings else 'k'
            choice = (input(f'  k=keep  r=redo  s=skip  q=quit  [{default}]: ')
                      .strip().lower() or default)
            if choice.startswith('r'):
                path.unlink(missing_ok=True)
                print()
                continue
            if choice.startswith('s'):
                path.unlink(missing_ok=True)
                print('  skipped.\n')
                break
            rows[row['id']] = row
            changed.append(row)
            write_rows(out_dir / args.manifest, list(rows.values()))
            print('  kept.\n')
            if choice.startswith('q'):
                return changed
            break
        else:
            continue
    return changed


def uncertainty(words, base_rate=0.10, confidence_multiplier=1.96):
    """Rough 1-sigma word-level standard error for a WER near `base_rate`.

    sqrt(p(1-p)/N) treats every reference word as an independent Bernoulli
    trial. Word errors are not independent -- one misheard phrase costs several
    adjacent words -- so the real spread is wider than this, and the gap grows
    with clip length. Treat it as an order-of-magnitude sanity check on corpus
    size, never as an interval to report or to test a difference with.

    For comparing two systems, use `metrics.paired_bootstrap`, which resamples
    whole clips and so keeps the within-clip correlation this ignores.
    """
    if words <= 0:
        return None
    sigma = math.sqrt(base_rate * (1 - base_rate) / words)
    return {'reference_words': words, 'base_rate': base_rate, 'standard_error': sigma,
            'approx_95_range': confidence_multiplier * sigma,
            'method': 'independent-word normal approximation; understates real uncertainty'}


def words_for(target_sigma, base_rate=0.10):
    return int(math.ceil(base_rate * (1 - base_rate) / (target_sigma ** 2)))


def summarise(manifest, role='regression'):
    """Report what the set is, and how uncertain a rate measured on it would be."""
    rows = load_manifest(manifest, corrected=False)
    seconds = sum(row['duration'] for row in rows)
    words = sum(len(row['sentence'].split()) for row in rows)
    unique = {row['sentence'] for row in rows}
    print(f'\n{manifest}')
    print(f'  role: {role} -- {ROLES[role]["blurb"]}')
    print(f'  {len(rows)} clips, {len(unique)} unique sentences,'
          f' {seconds / 60:.1f} minutes, {words} reference words')

    estimate = uncertainty(words)
    if estimate:
        sigma, span = estimate['standard_error'] * 100, estimate['approx_95_range'] * 100
        print(f'  ROUGH uncertainty at a {estimate["base_rate"] * 100:.0f}% WER:'
              f' ~{sigma:.2f} pt 1-sigma, ~+/-{span:.2f} pt at 95%')
        print('    Approximation only: assumes independent word errors, so the true spread is')
        print('    wider. It says nothing about whether a difference is real -- use the paired')
        print('    bootstrap in metrics.paired_bootstrap to compare two systems.')
        for target in (0.01, 0.005):
            need = words_for(target)
            if need > words:
                print(f'    for ~{target * 100:.1f} pt 1-sigma: about {need} words'
                      f' ({need - words} more)')
    if len(unique) < len(rows):
        print(f'  NOTE: {len(rows) - len(unique)} clip(s) repeat a sentence already in the set.')
        print('    Repeats measure acoustic consistency, not additional linguistic coverage.')
        print('    Their errors are correlated, so they do not count as independent words above.')
    return rows


def self_test():
    """No microphone: exercises the manifest contract with synthetic audio.

    The point is that the rows this writes survive the project's own validator,
    including the disjointness the regression role exists to provide.
    """
    import struct
    import tempfile
    from dataset import assert_disjoint, identities

    with tempfile.TemporaryDirectory() as temporary:
        out = Path(temporary) / 'regression'
        audio_dir = out / 'audio'
        sentences = ['The first spoken line for the contract test.',
                     'A second and clearly different spoken line.']
        rows = []
        for seed, sentence in enumerate(sentences, 1):
            pcm = b''.join(struct.pack('<h', ((i * (seed + 1)) % 6001) - 3000)
                           for i in range(SAMPLE_RATE * 2))
            path = write_wav(audio_dir / (sample_id(sentence) + '.wav'), pcm)
            rows.append(row_for(sentence, path, out, 'en', 'self-test'))
        write_rows(out / 'eval.jsonl', rows)

        loaded = load_manifest(out / 'eval.jsonl', corrected=False)
        assert len(loaded) == 2, 'both rows should validate'
        assert {r['label_source'] for r in loaded} == {ROLES['regression']['label_source']}
        assert not any(r['trainable'] for r in loaded), 'regression rows are never trainable'
        replaced = dict(rows[0])
        write_rows(out / 'eval.jsonl', [replaced, rows[1]])
        assert len(load_manifest(out / 'eval.jsonl', corrected=False)) == 2
        assert_disjoint(identities(loaded), [{'id': 'other', 'audio_sha256': 'f' * 64}])
        print('ok record self-test (manifest contract, replacement, disjointness)')
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--role', choices=sorted(ROLES), default='regression',
                        help='regression = held-out, never trained on (default);'
                             ' supervised = deliberately recorded trainable speech')
    parser.add_argument('--prompts', type=Path, default=PROMPTS,
                        help='sentence file, one per line (default: the bundled neutral script)')
    parser.add_argument('--out', type=Path, default=None,
                        help='override the manifest directory the role selects')
    parser.add_argument('--manifest', default=None, help='override the manifest filename')
    parser.add_argument('--language', default='en')
    parser.add_argument('--device', default=None,
                        help='input device index or name; see --list-devices')
    parser.add_argument('--redo-all', action='store_true',
                        help='re-record prompts that already have a take')
    parser.add_argument('--list-devices', action='store_true')
    parser.add_argument('--list-prompts', action='store_true')
    parser.add_argument('--summary', action='store_true',
                        help='report the existing set and its rough uncertainty, then exit')
    parser.add_argument('--self-test', action='store_true',
                        help='validate the manifest contract with synthetic audio; no microphone')
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.self_test:
        return self_test()
    if args.list_devices:
        import sounddevice
        print(sounddevice.query_devices())
        return 0

    spec = ROLES[args.role]
    if args.out is None:
        args.out = spec['directory']
    if args.manifest is None:
        args.manifest = spec['manifest']

    prompts = read_prompts(args.prompts)
    if args.list_prompts:
        words = sum(len(p.split()) for p in prompts)
        print(f'{len(prompts)} prompts, {words} words,'
              f' about {words / 140:.1f} minutes at 140 wpm')
        return 0

    manifest = Path(args.out) / args.manifest
    if args.summary:
        summarise(manifest, args.role)
        return 0

    existing = read_rows(manifest)
    try:
        changed = session(args, prompts, existing, spec)
    except (KeyboardInterrupt, EOFError):
        print('\nstopped.')
        changed = []
    if Path(manifest).is_file():
        summarise(manifest, args.role)
    print(f'  {len(changed)} clip(s) recorded this session')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
