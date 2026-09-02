"""Corpus WER/CER, auditable corrected-term recall, and paired bootstrap.

Corpus WER is a ratio of summed edit distances, so a closed-form standard error
over words assumes every word is an independent trial. Errors cluster inside an
utterance -- one misheard phrase costs several words at once -- so that
assumption understates the real uncertainty, and the understatement grows with
the average clip length. Resampling whole clips keeps the clustering intact.

The bootstrap here is *paired*: both systems are scored on the same resampled
clips, so the per-clip difficulty that dominates the variance cancels out of the
difference. That is the comparison worth making between stock and a candidate.
"""
import random
import unicodedata
from difflib import SequenceMatcher

METRIC_POLICY = 'unicode-nfkc-casefold-punctuation-space-cer-with-spaces-v1'


def normalize(text):
    text = unicodedata.normalize('NFKC', text).casefold()
    return ' '.join(''.join(c if c.isalnum() or c == "'" else ' ' for c in text).split())


def distance(reference, hypothesis):
    previous = list(range(len(hypothesis) + 1))
    for i, a in enumerate(reference, 1):
        current = [i]
        for j, b in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def contains_tokens(text, term):
    words, target = normalize(text).split(), normalize(term).split()
    return bool(target) and any(words[i:i + len(target)] == target for i in range(len(words) - len(target) + 1))


def corrected_terms(row):
    explicit = [item['to'] for item in row.get('learned') or []
                if isinstance(item, dict) and isinstance(item.get('to'), str) and item['to'].strip()]
    source = 'recorded_correction'
    if not explicit and isinstance(row.get('raw_transcript'), str) and row['raw_transcript'].strip():
        source = 'transcript_diff_heuristic'
        before, after = normalize(row['raw_transcript']).split(), normalize(row['sentence']).split()
        explicit = [' '.join(after[j:k]) for kind, _, _, j, k in SequenceMatcher(None, before, after, autojunk=False).get_opcodes()
                    if kind in ('replace', 'insert')]
    return [{'term': term, 'source': source} for term in sorted({normalize(t) for t in explicit})
            if term and contains_tokens(row['sentence'], term)]


def score(rows, hypotheses, min_term_examples=3):
    if len(rows) != len(hypotheses) or not rows:
        raise ValueError('one hypothesis is required per non-empty evaluation row')
    word_errors = char_errors = word_count = char_count = 0
    term_counts, predictions = {}, []
    for row, hypothesis in zip(rows, hypotheses):
        reference, hyp = normalize(row['sentence']), normalize(hypothesis)
        if not reference:
            raise ValueError('empty normalized reference')
        word_errors += distance(reference.split(), hyp.split())
        char_errors += distance(reference, hyp)
        word_count += len(reference.split())
        char_count += len(reference)
        terms = corrected_terms(row)
        for item in terms:
            count = term_counts.setdefault(item['term'], {'samples': 0, 'hits': 0, 'sources': []})
            count['samples'] += 1
            count['hits'] += int(contains_tokens(hypothesis, item['term']))
            if item['source'] not in count['sources']:
                count['sources'].append(item['source'])
        # Per-clip counts, not just the running totals: a paired bootstrap needs
        # to re-aggregate over resampled clips, which is impossible once the
        # numerator and denominator have been summed away.
        predictions.append({'id': row['id'], 'reference': row['sentence'], 'hypothesis': hypothesis,
                            'terms': terms,
                            'word_errors': distance(reference.split(), hyp.split()),
                            'reference_words': len(reference.split()),
                            'character_errors': distance(reference, hyp),
                            'reference_characters': len(reference)})
    total = sum(t['samples'] for t in term_counts.values())
    hits = sum(t['hits'] for t in term_counts.values())
    return {'samples': len(rows), 'wer': word_errors / word_count, 'cer': char_errors / char_count,
            'word_errors': word_errors, 'reference_words': word_count, 'character_errors': char_errors,
            'reference_characters': char_count, 'term_recall': hits / total if total else None,
            'term_hits': hits, 'term_examples': total,
            'frequent_terms': {k: {**v, 'recall': v['hits'] / v['samples']} for k, v in sorted(term_counts.items())
                               if v['samples'] >= min_term_examples}, 'predictions': predictions}


def _totals(predictions, indices, metric):
    errors = words = 0
    error_key = 'word_errors' if metric == 'wer' else 'character_errors'
    count_key = 'reference_words' if metric == 'wer' else 'reference_characters'
    for index in indices:
        errors += predictions[index][error_key]
        words += predictions[index][count_key]
    return errors, words


def paired_bootstrap(baseline, candidate, *, metric='wer', iterations=2000, seed=0, confidence=0.95):
    """Resample clips with replacement; both systems see the same resample.

    `baseline` and `candidate` are the `predictions` lists two `score()` calls
    produced over the same manifest. Returns the observed delta, a percentile
    interval for it, and the share of resamples in which the candidate came out
    ahead.

    That share is a bootstrap frequency, not a p-value, and this function does
    not decide significance. An interval that excludes zero is evidence worth
    looking at; with the sample sizes this project realistically has, it is not
    proof, and nothing here should be reported as though it were.
    """
    if metric not in ('wer', 'cer'):
        raise ValueError("metric must be 'wer' or 'cer'")
    left = {row['id']: row for row in baseline}
    right = {row['id']: row for row in candidate}
    shared = sorted(left.keys() & right.keys())
    if not shared:
        raise ValueError('paired bootstrap needs the same clips scored by both systems')
    if len(shared) != len(left) or len(shared) != len(right):
        raise ValueError('prediction sets differ; re-score both systems on one manifest')
    missing = [row for row in list(left.values()) + list(right.values()) if 'reference_words' not in row]
    if missing:
        raise ValueError('predictions predate per-clip counts; re-run the baseline to enable the bootstrap')

    ordered_left = [left[i] for i in shared]
    ordered_right = [right[i] for i in shared]

    def rate(predictions, indices):
        errors, words = _totals(predictions, indices, metric)
        return errors / words if words else float('nan')

    everything = range(len(shared))
    observed = rate(ordered_right, everything) - rate(ordered_left, everything)

    rng = random.Random(seed)
    deltas = []
    for _ in range(iterations):
        sample = [rng.randrange(len(shared)) for _ in range(len(shared))]
        delta = rate(ordered_right, sample) - rate(ordered_left, sample)
        if delta == delta:  # skip a resample that drew only empty references
            deltas.append(delta)
    deltas.sort()
    if not deltas:
        raise ValueError('every resample was degenerate; the manifest is too small to bootstrap')
    lower = deltas[max(0, int((1 - confidence) / 2 * len(deltas)) - 1)]
    upper = deltas[min(len(deltas) - 1, int((1 + confidence) / 2 * len(deltas)))]
    return {
        'metric': metric,
        'clips': len(shared),
        'iterations': len(deltas),
        'seed': seed,
        'confidence': confidence,
        'observed_delta': observed,
        'interval': [lower, upper],
        'share_candidate_better': sum(1 for d in deltas if d < 0) / len(deltas),
        'interval_excludes_zero': (lower < 0 and upper < 0) or (lower > 0 and upper > 0),
        'caveat': ('percentile bootstrap over clips; a frequency, not a p-value, '
                   'and not a significance test'),
    }
