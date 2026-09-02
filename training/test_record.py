"""Contract tests for the read-speech recorder and the paired bootstrap.

No microphone, no ASR, no speech benchmark. These assert that what record.py
writes survives the project's own validator, that the four data roles stay
separate, that the audio gate rejects only what is genuinely unusable, and that
the uncertainty reported to the reader is described as the approximation it is.
"""
import math
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dataset import (CORRECTIONS, MAX_SECONDS, REGRESSION, SAMPLE_RATE, SUPERVISED,
                     assert_disjoint, assert_not_trained_on, identities, load_manifest, split_for)
from metrics import paired_bootstrap
from record import (ROLES, analyse, read_prompts, read_rows, review, row_for, sample_id,
                    uncertainty, words_for, write_rows, write_wav)


def tone(seconds, amplitude=9000, hz=180, floor=0):
    """Deterministic non-speech signal. Never used to measure ASR quality."""
    out = []
    for index in range(int(SAMPLE_RATE * seconds)):
        value = amplitude * math.sin(2 * math.pi * hz * index / SAMPLE_RATE)
        out.append(int(max(-32768, min(32767, value + floor))))
    return b''.join(struct.pack('<h', value) for value in out)


def silence(seconds, amplitude=0):
    return tone(seconds, amplitude=amplitude)


class Prompts(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / 'p.txt'

    def test_drops_comments_blanks_and_punctuation_only_lines(self):
        self.path.write_text('# a comment\n\nReal sentence one.\n   \n...\nReal sentence two.\n',
                             encoding='utf-8')
        self.assertEqual(read_prompts(self.path), ['Real sentence one.', 'Real sentence two.'])

    def test_drops_duplicates_before_they_collide_on_id(self):
        self.path.write_text('Same line.\nSame line.\nOther line.\n', encoding='utf-8')
        self.assertEqual(read_prompts(self.path), ['Same line.', 'Other line.'])

    def test_empty_script_is_an_error_not_an_empty_session(self):
        self.path.write_text('# only comments\n\n', encoding='utf-8')
        with self.assertRaises(ValueError):
            read_prompts(self.path)

    def test_bundled_script_is_usable_and_within_the_duration_ceiling(self):
        prompts = read_prompts(Path(__file__).resolve().parent / 'prompts' / 'read-speech-en.txt')
        self.assertGreater(len(prompts), 100)
        self.assertLess(max(len(p.split()) for p in prompts), 40)

    def test_ids_are_stable_and_distinct(self):
        self.assertEqual(sample_id('One line.'), sample_id('One line.'))
        self.assertNotEqual(sample_id('One line.'), sample_id('Two line.'))


class AudioGate(unittest.TestCase):
    """Only genuinely unusable audio is refused; poor audio is a recommendation."""

    def verdict(self, pcm):
        return review(analyse(pcm))

    def test_digital_silence_is_refused(self):
        errors, _ = self.verdict(silence(2.0))
        self.assertTrue(any('silence' in e for e in errors))

    def test_nothing_reaching_the_input_is_refused(self):
        errors, _ = self.verdict(tone(2.0, amplitude=30))
        self.assertTrue(errors)

    def test_room_tone_with_one_transient_is_refused(self):
        # A single door slam would pass a peak-only gate. It is not a read line.
        pcm = tone(2.4, amplitude=20) + tone(0.2, amplitude=9000) + tone(2.4, amplitude=20)
        errors, _ = self.verdict(pcm)
        self.assertTrue(any('noise floor' in e for e in errors))

    def test_quiet_but_real_speech_is_a_warning_not_a_rejection(self):
        # The whole point of dropping the single peak gate: gain varies by
        # device, and a quiet take is still real speech with a real transcript.
        pcm = tone(0.3, amplitude=60) + tone(2.0, amplitude=1000) + tone(0.3, amplitude=60)
        errors, warnings = self.verdict(pcm)
        self.assertFalse(errors)
        self.assertTrue(any('quiet' in w for w in warnings))

    def test_a_continuous_read_with_no_pauses_is_accepted(self):
        # A purely relative threshold scores this at zero percent speech, because
        # the noise floor and the speech are the same level, and throws away a
        # perfectly good clip. The absolute test exists for exactly this case.
        errors, warnings = self.verdict(tone(3.0, amplitude=9000))
        self.assertFalse(errors)
        self.assertFalse(warnings)
        self.assertEqual(analyse(tone(3.0, amplitude=9000))['speech_ratio'], 1.0)

    def test_sustained_clipping_warns(self):
        pcm = tone(0.2, amplitude=80) + tone(2.5, amplitude=60000) + tone(0.2, amplitude=80)
        errors, warnings = self.verdict(pcm)
        self.assertFalse(errors)
        self.assertTrue(any('clipping' in w for w in warnings))

    def test_over_long_is_refused_and_never_truncated(self):
        errors, _ = self.verdict(tone(MAX_SECONDS + 1))
        self.assertTrue(any('never truncates' in e for e in errors))

    def test_empty_capture_is_refused(self):
        errors, _ = self.verdict(b'')
        self.assertTrue(errors)


class Uncertainty(unittest.TestCase):
    def test_reports_sigma_and_a_wider_95_range(self):
        result = uncertainty(3600)
        self.assertAlmostEqual(result['standard_error'], math.sqrt(0.10 * 0.90 / 3600))
        self.assertAlmostEqual(result['approx_95_range'], 1.96 * result['standard_error'])
        self.assertGreater(result['approx_95_range'], result['standard_error'])

    def test_names_itself_an_approximation_that_understates(self):
        self.assertIn('understates', uncertainty(1000)['method'])

    def test_empty_corpus_has_no_estimate_rather_than_a_fake_one(self):
        self.assertIsNone(uncertainty(0))

    def test_word_target_inverts_the_estimate(self):
        need = words_for(0.005)
        self.assertLessEqual(uncertainty(need)['standard_error'], 0.005)


class Bootstrap(unittest.TestCase):
    """Resampling clips, which keeps the within-clip correlation the closed-form
    word-level estimate throws away."""

    @staticmethod
    def predictions(per_clip):
        return [{'id': str(index), 'word_errors': errors, 'reference_words': words,
                 'character_errors': errors * 4, 'reference_characters': words * 5}
                for index, (errors, words) in enumerate(per_clip)]

    def test_detects_a_consistent_improvement(self):
        base = self.predictions([(3, 10)] * 40)
        candidate = self.predictions([(1, 10)] * 40)
        result = paired_bootstrap(base, candidate, iterations=400)
        self.assertLess(result['observed_delta'], 0)
        self.assertTrue(result['interval_excludes_zero'])
        self.assertEqual(result['clips'], 40)

    def test_a_wash_produces_an_interval_containing_zero(self):
        pattern = [(3, 10), (0, 12), (5, 8), (1, 15)] * 10
        base = self.predictions(pattern)
        candidate = self.predictions(pattern)
        result = paired_bootstrap(base, candidate, iterations=400)
        self.assertEqual(result['observed_delta'], 0)
        self.assertFalse(result['interval_excludes_zero'])

    def test_noisy_clips_widen_the_interval(self):
        # Same mean delta, wildly different per-clip variance: the resample has
        # to notice, which a word-level standard error cannot.
        steady_base = self.predictions([(2, 10)] * 30)
        steady_cand = self.predictions([(1, 10)] * 30)
        noisy_base = self.predictions([(6, 10) if i % 2 else (0, 10) for i in range(30)])
        noisy_cand = self.predictions([(3, 10) if i % 2 else (0, 10) for i in range(30)])
        steady = paired_bootstrap(steady_base, steady_cand, iterations=600)
        noisy = paired_bootstrap(noisy_base, noisy_cand, iterations=600)
        width = lambda r: r['interval'][1] - r['interval'][0]
        self.assertGreater(width(noisy), width(steady))

    def test_is_deterministic_for_a_seed(self):
        base = self.predictions([(3, 10), (1, 12)] * 15)
        candidate = self.predictions([(2, 10), (1, 12)] * 15)
        first = paired_bootstrap(base, candidate, iterations=200, seed=7)
        second = paired_bootstrap(base, candidate, iterations=200, seed=7)
        self.assertEqual(first['interval'], second['interval'])

    def test_refuses_unpaired_prediction_sets(self):
        base = self.predictions([(1, 10)] * 5)
        candidate = self.predictions([(1, 10)] * 4)
        with self.assertRaises(ValueError):
            paired_bootstrap(base, candidate, iterations=50)

    def test_refuses_predictions_that_predate_per_clip_counts(self):
        base = [{'id': '0', 'reference': 'a', 'hypothesis': 'a'}]
        candidate = [{'id': '0', 'reference': 'a', 'hypothesis': 'a'}]
        with self.assertRaises(ValueError):
            paired_bootstrap(base, candidate, iterations=50)

    def test_does_not_claim_significance(self):
        base = self.predictions([(3, 10)] * 20)
        candidate = self.predictions([(1, 10)] * 20)
        result = paired_bootstrap(base, candidate, iterations=200)
        self.assertNotIn('p_value', result)
        self.assertIn('not a p-value', result['caveat'])


class Roles(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.out = Path(self.dir.name) / 'set'
        self.manifest = self.out / 'eval.jsonl'

    def record(self, sentence, seconds=2.0, amplitude=9000, role='regression'):
        path = write_wav(self.out / 'audio' / (sample_id(sentence) + '.wav'),
                         tone(seconds, amplitude))
        return row_for(sentence, path, self.out, 'en', 'test.txt', role)

    def test_the_four_roles_are_physically_separate(self):
        paths = {CORRECTIONS.resolve(), REGRESSION.resolve(), SUPERVISED.resolve()}
        self.assertEqual(len(paths), 3)
        for directory in paths:
            self.assertNotIn(directory, [p for other in paths - {directory} for p in other.parents])

    def test_regression_rows_are_marked_untrainable(self):
        row = self.record('First spoken line.', role='regression')
        self.assertFalse(row['trainable'])
        self.assertEqual(row['role'], 'regression')

    def test_supervised_rows_are_marked_trainable(self):
        row = self.record('First spoken line.', role='supervised')
        self.assertTrue(row['trainable'])
        self.assertEqual(row['label_source'], ROLES['supervised']['label_source'])
        self.assertNotEqual(row['label_source'], ROLES['regression']['label_source'])

    def test_the_regression_set_is_refused_as_a_training_input(self):
        with self.assertRaises(ValueError):
            assert_not_trained_on(REGRESSION / 'eval.jsonl')
        with self.assertRaises(ValueError):
            assert_not_trained_on(REGRESSION / 'nested' / 'anything.jsonl')

    def test_trainable_roles_are_accepted_as_training_inputs(self):
        self.assertTrue(assert_not_trained_on(CORRECTIONS / 'train.jsonl'))
        self.assertTrue(assert_not_trained_on(SUPERVISED / 'train.jsonl'))

    def test_rows_validate_as_an_uncorrected_manifest(self):
        rows = [self.record('First spoken line.'), self.record('Second spoken line.', seconds=2.5)]
        write_rows(self.manifest, rows)
        loaded = load_manifest(self.manifest, corrected=False)
        self.assertEqual(len(loaded), 2)
        self.assertEqual({r['language'] for r in loaded}, {'en'})

    def test_read_speech_is_rejected_as_a_corrected_manifest(self):
        # Read speech must never be mistaken for a user correction, which is
        # what the in-domain eval partition requires.
        write_rows(self.manifest, [self.record('First spoken line.')])
        with self.assertRaises(ValueError):
            load_manifest(self.manifest, corrected=True)

    def test_audio_path_is_relative_so_the_set_can_be_moved(self):
        row = self.record('First spoken line.')
        self.assertFalse(Path(row['audio']).is_absolute())
        self.assertTrue(row['audio'].startswith('audio/'))

    def test_a_second_take_replaces_rather_than_accumulates(self):
        sentence = 'A line that gets read twice.'
        first = self.record(sentence, seconds=2.0)
        write_rows(self.manifest, [first])
        second = self.record(sentence, seconds=2.5)
        self.assertEqual(first['id'], second['id'])
        self.assertNotEqual(first['audio_sha256'], second['audio_sha256'])
        rows = {row['id']: row for row in read_rows(self.manifest)}
        rows[second['id']] = second
        write_rows(self.manifest, list(rows.values()))
        loaded = load_manifest(self.manifest, corrected=False)
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0]['audio_sha256'], second['audio_sha256'])

    def test_appending_both_takes_is_what_the_validator_refuses(self):
        import json
        sentence = 'A line that gets read twice.'
        write_rows(self.manifest, [self.record(sentence, seconds=2.0)])
        second = self.record(sentence, seconds=2.5)
        with open(self.manifest, 'a', encoding='utf-8') as handle:
            handle.write(json.dumps(second) + '\n')
        with self.assertRaises(ValueError):
            load_manifest(self.manifest, corrected=False)

    def test_over_long_audio_is_refused_by_the_manifest_too(self):
        sentence = 'A line read far too slowly.'
        path = write_wav(self.out / 'audio' / (sample_id(sentence) + '.wav'),
                         tone(MAX_SECONDS + 1))
        with self.assertRaises(ValueError):
            row_for(sentence, path, self.out, 'en', 'test.txt')

    def test_silence_is_refused_by_the_manifest_too(self):
        sentence = 'A line nobody actually said.'
        path = write_wav(self.out / 'audio' / (sample_id(sentence) + '.wav'), silence(1.0))
        with self.assertRaises(ValueError):
            row_for(sentence, path, self.out, 'en', 'test.txt')

    def test_the_set_stays_disjoint_from_the_correction_partitions(self):
        rows = [self.record('First spoken line.'), self.record('Second spoken line.', seconds=2.5)]
        write_rows(self.manifest, rows)
        regression = load_manifest(self.manifest, corrected=False)
        assert_disjoint(identities(regression), [{'id': 'pair-1', 'audio_sha256': 'a' * 64}])

    def test_rows_are_outside_the_hash_partition_by_design(self):
        # Nothing here declares a split policy, which is what keeps these clips
        # out of the ten-percent lottery and makes the set genuinely held out.
        row = self.record('First spoken line.')
        self.assertNotIn('split_policy', row)
        self.assertIn(split_for(row['audio_sha256']), ('train', 'eval'))


if __name__ == '__main__':
    unittest.main()
