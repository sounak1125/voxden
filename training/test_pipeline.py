"""Small local fixtures exercise validation; none are speech benchmarks."""
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifacts import OUTPUT, WORK, file_hash, model_signature, new_metadata, record_benchmark, require_empty, validate_ct2, validate_output_paths
from dataset import ROOT, SPLIT_POLICY, assert_disjoint, export_pairs, fingerprint, identities, inspect_wav, load_manifest, normalize_wav, split_for, validate_rows, write_json
from evaluate import main as evaluate_main, require_baseline, score
from finetune import main as finetune_main, parser, require_cuda
from inference import decode_protocol, transcribe, validate_standalone
from metrics import contains_tokens, corrected_terms, distance, normalize


def wav(path, seed=1, rate=16000, channels=1, frames=8000):
    # Deterministic non-speech test signal. Not used for ASR quality measurement.
    pcm = b''.join(struct.pack('<h', ((index * (seed + 1)) % 6001) - 3000) for index in range(frames * channels))
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((channels, 2, rate, frames, 'NONE', 'not compressed'))
        stream.writeframes(pcm)
    return path


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audio = wav(self.root / 'clip.wav')
        self.row = {'id': 'one', 'audio': str(self.audio), 'sentence': 'Use Seedance today',
                    'raw_transcript': 'use sea dance today', 'language': 'en', 'label_source': 'user_correction'}

    def valid(self, **changes):
        rows, errors = validate_rows([{**self.row, **changes}], self.root)
        self.assertEqual(errors, [])
        return rows[0]

    def rejected(self, **changes):
        rows, errors = validate_rows([{**self.row, **changes}], self.root)
        self.assertFalse(rows)
        self.assertTrue(errors)
        return errors[0]['reason']

    def test_valid_audio_and_relative_path(self):
        self.assertEqual(self.valid(audio='clip.wav')['sample_rate'], 16000)

    def test_missing_and_empty_audio(self):
        self.assertIn('missing', self.rejected(audio='missing.wav'))
        self.assertIn('missing', self.rejected(audio=''))

    def test_corrupt_and_truncated_wav(self):
        self.audio.write_bytes(b'corrupt')
        self.assertIn('corrupt', self.rejected())
        wav(self.audio)
        self.audio.write_bytes(self.audio.read_bytes()[:-100])
        self.assertIn('truncated', self.rejected())

    def test_empty_transcript_and_missing_correction(self):
        self.assertIn('empty', self.rejected(sentence=' '))
        self.assertIn('provenance', self.rejected(label_source=None))
        self.assertIn('letters', self.rejected(sentence='!!!'))

    def test_corrupt_metadata_rejected(self):
        self.assertIn('raw transcript', self.rejected(raw_transcript=7))
        self.assertIn('annotations', self.rejected(learned=7))
        self.assertIn('annotations', self.rejected(learned=[{'to': 7}]))

    def test_language_not_invented(self):
        self.assertIn('language', self.rejected(language=None))

    def test_normalization_copies_without_touching_original(self):
        try:
            import soundfile
            import scipy
        except ImportError:
            self.skipTest('optional normalization dependencies not installed')
        wav(self.audio, rate=8000, channels=2)
        original = self.audio.read_bytes()
        destination = self.root / 'normalized.wav'
        details = normalize_wav(self.audio, destination)
        self.assertEqual(details['sample_rate'], 16000)
        self.assertEqual(details['channels'], 1)
        self.assertEqual(self.audio.read_bytes(), original)

    def test_rate_channels_duration_and_silence(self):
        for kwargs in ({'rate': 8000}, {'channels': 2}, {'frames': 100}, {'frames': 480001}):
            wav(self.audio, **kwargs)
            self.rejected()
        wav(self.audio)
        raw = self.audio.read_bytes()
        self.audio.write_bytes(raw[:44] + bytes(len(raw) - 44))
        self.assertIn('silence', self.rejected())

    def test_audio_checksum_changes(self):
        row = self.valid()
        wav(self.audio, seed=99)
        self.assertIn('checksum', self.rejected(audio_sha256=row['audio_sha256']))

    def test_duplicate_id_and_audio_removed(self):
        rows, errors = validate_rows([self.row, self.row, {**self.row, 'id': 'copy'}], self.root)
        self.assertEqual((len(rows), len(errors)), (1, 2))
        self.assertTrue(all('duplicate' in error['reason'] for error in errors))

    def test_conflicting_duplicates_excluded(self):
        rows, errors = validate_rows([self.row, {**self.row, 'id': 'copy', 'sentence': 'Different label'}], self.root)
        self.assertEqual((len(rows), len(errors)), (0, 2))

    def test_split_stability_distribution_and_no_overlap(self):
        keys = [hashlib.sha256(str(i).encode()).hexdigest() for i in range(10000)]
        before = {key: split_for(key) for key in keys[:100]}
        after = {key: split_for(key) for key in reversed(keys)}
        self.assertEqual(before, {key: after[key] for key in before})
        evaluation = [key for key in keys if after[key] == 'eval']
        self.assertTrue(850 < len(evaluation) < 1150)
        self.assertFalse(set(evaluation) & {key for key in keys if after[key] == 'train'})

    def test_leakage_by_id_or_audio_including_historical_training(self):
        row = self.valid()
        with self.assertRaisesRegex(ValueError, 'leakage'):
            assert_disjoint([row], [{**row, 'id': 'new'}])
        with self.assertRaisesRegex(ValueError, 'leakage'):
            assert_disjoint(identities([row]), [{**row, 'audio_sha256': 'different'}])

    def test_fingerprint_tracks_labels_not_paths(self):
        row = self.valid()
        self.assertEqual(fingerprint([row]), fingerprint([{**row, 'audio': 'elsewhere'}]))
        self.assertNotEqual(fingerprint([row]), fingerprint([{**row, 'sentence': 'Changed'}]))
        self.assertNotEqual(fingerprint([row]), fingerprint([{**row, 'raw_transcript': 'Changed'}]))

    def test_export_repeated_growth_and_no_invented_metadata(self):
        source = self.root / 'source'
        source.mkdir()
        pairs = []
        for i in range(40):
            wav(source / f'{i}.wav', seed=i)
            pairs.append({'id': str(i), 'audio': f'{i}.wav', 'text': 'Reference', 'asr': 'raw reference'})
        manifest = source / 'pairs.jsonl'
        def save(count):
            manifest.write_text(''.join(json.dumps(r) + '\n' for r in pairs[:count]), encoding='utf-8')
            return export_pairs(source, self.root / 'export', language='en', write=True)
        save(10)
        def assignments():
            return {row['id']: kind for kind in ('train', 'eval')
                    for row in (json.loads(line) for line in (self.root / 'export' / f'{kind}.jsonl').read_text().splitlines())}
        old = assignments()
        report = save(40)
        self.assertEqual(old, {key: assignments()[key] for key in old})
        self.assertEqual(report['accepted'], 40)
        for kind in ('train', 'eval'):
            rows = load_manifest(self.root / 'export' / f'{kind}.jsonl', expected_split=kind)
            self.assertNotIn('engine', rows[0])
            self.assertEqual(rows[0]['raw_transcript'], 'raw reference')
            self.assertEqual(rows[0]['language_source'], 'export_argument')

    def test_export_malformed_json_and_escaped_path_warnings(self):
        source = self.root / 'source'
        source.mkdir()
        (source / 'pairs.jsonl').write_text('{broken\n' + json.dumps({'id': 'x', 'audio': '../clip.wav', 'text': 'x'}))
        report = export_pairs(source, self.root / 'export', language='en')
        self.assertEqual(len(report['rejected']), 2)

    def test_manifest_strict_partition_and_invalid_rows(self):
        row = self.valid()
        file = self.root / 'train.jsonl'
        file.write_text(json.dumps({**row, 'split_policy': SPLIT_POLICY}) + '\n')
        opposite = 'eval' if split_for(row['audio_sha256']) == 'train' else 'train'
        with self.assertRaisesRegex(ValueError, 'partition'):
            load_manifest(file, expected_split=opposite)
        file.write_text(file.read_text() + '{broken\n')
        with self.assertRaisesRegex(ValueError, 'invalid JSON'):
            load_manifest(file)

    def test_unicode_metrics_and_insertions_deletions(self):
        self.assertEqual(normalize('Café, SEEDANCE 2.5!'), 'café seedance 2 5')
        self.assertEqual(distance(['a', 'b'], ['a', 'c', 'd']), 2)
        result = score([{'id': '1', 'sentence': 'cat sat'}, {'id': '2', 'sentence': 'dog'}], ['cat', 'dog dog'])
        self.assertAlmostEqual(result['wer'], 2 / 3)
        self.assertAlmostEqual(result['cer'], 8 / 10)
        self.assertIsNone(result['term_recall'])
        with self.assertRaises(ValueError):
            score([self.row], [])

    def test_term_boundaries_annotations_and_diff(self):
        self.assertFalse(contains_tokens('Seedancer', 'Seedance'))
        self.assertFalse(contains_tokens('concatenate', 'cat'))
        self.assertTrue(contains_tokens('use Seedance 2.5!', 'Seedance 2.5'))
        terms = corrected_terms(self.row)
        self.assertEqual(terms, [{'term': 'seedance', 'source': 'transcript_diff_heuristic'}])
        rows = [{**self.row, 'id': str(i), 'learned': [{'to': 'Seedance'}, {'to': 'Seedance'}, {'to': 'absent'}]} for i in range(3)]
        result = score(rows, ['Seedance', 'Seedancer', 'Seedance'])
        self.assertEqual((result['term_hits'], result['term_examples']), (2, 3))
        self.assertAlmostEqual(result['frequent_terms']['seedance']['recall'], 2 / 3)

    def test_safe_output_directories_and_no_overwrite(self):
        self.assertEqual(validate_output_paths(WORK, OUTPUT), (WORK.resolve(), OUTPUT.resolve()))
        for work, out in ((ROOT, OUTPUT), (WORK, ROOT / 'models'), (WORK, ROOT / 'models' / 'voxden-tuned'), (WORK / '../../src', OUTPUT)):
            with self.assertRaises(ValueError):
                validate_output_paths(work, out)
        with self.assertRaises(ValueError):
            require_empty(self.root)

    def mock_ct2(self):
        model = self.root / 'model'
        model.mkdir()
        (model / 'model.bin').write_bytes(b'test fixture, not actual weights')
        for file in ('config.json', 'tokenizer.json', 'preprocessor_config.json', 'vocabulary.json'):
            write_json(model / file, {'fixture': True})
        return model

    def test_ct2_required_file_checks(self):
        model = self.mock_ct2()
        self.assertEqual(len(validate_ct2(model)), 5)
        (model / 'tokenizer.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'tokenizer'):
            validate_ct2(model)
        (model / 'model.bin').unlink()
        with self.assertRaisesRegex(ValueError, 'model.bin'):
            validate_ct2(model)

    def test_metadata_null_until_real_report_and_identity_guard(self):
        model = self.mock_ct2()
        metadata = new_metadata({'base_model': 'openai/whisper-large-v3', 'training_samples': 5})
        self.assertTrue(all(value is None for value in metadata['evaluation'].values()))
        write_json(model / 'metadata.json', metadata)
        measured = score([self.row], ['Use Seedance today'])
        report = {'created_at': 'test', 'protocol': {}, 'assessment': [],
                  'models': {name: {'model_signature': model_signature(model), 'corrections': measured, 'regression': None}
                             for name in ('stock', 'voxden')}}
        record_benchmark(model, report)
        saved = json.loads((model / 'metadata.json').read_text())
        self.assertEqual(saved['evaluation']['voxden_wer'], 0)
        (model / 'model.bin').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'different model'):
            record_benchmark(model, report)

    def test_baseline_mismatch_rejected(self):
        file = self.root / 'baseline.json'
        write_json(file, {'protocol': {'settings': 1}, 'models': {'stock': {}}})
        with self.assertRaisesRegex(ValueError, 'differ'):
            require_baseline(file, {'settings': 2})

    def test_baseline_comparison_metadata_and_regression_with_mock_inference(self):
        # An integration test using synthetic fixtures, never a real benchmark.
        source = self.root / 'source'
        source.mkdir()
        pairs = []
        for index in range(40):
            wav(source / f'{index}.wav', seed=index)
            pairs.append({'id': str(index), 'audio': f'{index}.wav', 'text': 'Use Seedance', 'asr': 'use sea dance'})
        (source / 'pairs.jsonl').write_text(''.join(json.dumps(row) + '\n' for row in pairs))
        output = self.root / 'export'
        export_pairs(source, output, language='en', write=True)
        regression = self.root / 'regression.jsonl'
        regression.write_text(json.dumps({'id': 'regression', 'audio': str(wav(self.root / 'regression.wav', seed=123)),
                                          'sentence': 'ordinary speech', 'language': 'en'}) + '\n')
        baseline = self.root / 'baseline.json'
        comparison = self.root / 'comparison.json'
        model = self.mock_ct2()
        argv = ['--train-file', str(output / 'train.jsonl'), '--eval-file', str(output / 'eval.jsonl'),
                '--regression-file', str(regression), '--baseline', str(baseline), '--tuned', str(model)]
        with patch('evaluate.resolve_stock', return_value=model), patch('evaluate.load_model', return_value=object()), \
                patch('evaluate.transcribe', side_effect=lambda _, row, **kwargs: row['sentence']), patch('builtins.print'):
            self.assertEqual(evaluate_main([*argv, '--base-only']), 0)
            report = json.loads(baseline.read_text())
            training = {'base_model': 'test fixture', 'training_samples': 1, 'baseline_protocol': report['protocol'],
                        'baseline_sha256': file_hash(baseline),
                        'training_identities': identities(load_manifest(output / 'train.jsonl', expected_split='train'))}
            metadata = new_metadata(training)
            metadata['standalone_validation'] = {'passed': True, 'model_signature': model_signature(model)}
            write_json(model / 'metadata.json', metadata)
            self.assertEqual(evaluate_main([*argv, '--output', str(comparison)]), 0)
        saved = json.loads((model / 'metadata.json').read_text())
        self.assertEqual(saved['status'], 'evaluated_candidate')
        self.assertEqual(saved['regression_evaluation']['voxden']['samples'], 1)
        self.assertEqual(saved['evaluation']['voxden_term_recall'], 1)
        self.assertEqual(json.loads(baseline.read_text()), report)

    def test_inference_uses_sidecar_vad_and_consumes_output(self):
        module = SimpleNamespace(transcribe_file=lambda model, path, **kwargs: json.dumps(kwargs))
        with patch('inference.sidecar', return_value=module):
            result = json.loads(transcribe(object(), self.row))
        self.assertTrue(result['vad_filter'])
        self.assertIsNone(result['initial_prompt'])
        self.assertEqual(result['language'], 'en')
        protocol = decode_protocol()
        self.assertEqual(protocol['kwargs_without_language']['beam_size'], 3)
        self.assertEqual(protocol['kwargs_without_language']['temperature'], [0.0, 0.2])

    def test_standalone_load_or_empty_transcript_fails(self):
        model = self.mock_ct2()
        with patch('inference.load_model', side_effect=RuntimeError('cannot load')):
            with self.assertRaisesRegex(RuntimeError, 'cannot load'):
                validate_standalone(model, self.audio)
        with patch('inference.load_model', return_value=object()), patch('inference.transcribe', return_value=''):
            with self.assertRaisesRegex(ValueError, 'no text'):
                validate_standalone(model, self.audio)

    def test_cuda_guard_and_oom_message(self):
        fake = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False), version=SimpleNamespace(cuda=None))
        with patch.dict(sys.modules, {'torch': fake}):
            with self.assertRaisesRegex(ValueError, 'CPU training is disabled'):
                require_cuda()
        with patch('finetune.preflight', side_effect=RuntimeError('CUDA out of memory')):
            self.assertEqual(finetune_main(['--check']), 1)

    def test_cli_configuration(self):
        args = parser().parse_args(['--alpha', '16', '--dropout', '.1', '--no-fp16', '--no-gradient-checkpointing', '--target-modules', 'q_proj'])
        self.assertEqual((args.alpha, args.dropout, args.fp16, args.gradient_checkpointing), (16, .1, False, False))

    def test_node_entrypoint(self):
        environment = {**os.environ, 'VOXDEN_TRAINING_PYTHON': sys.executable}
        result = subprocess.run(['node', str(ROOT / 'scripts' / 'export-training-data.js'), '--help'],
                                capture_output=True, text=True, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--audio-dir', result.stdout)


if __name__ == '__main__':
    unittest.main()
