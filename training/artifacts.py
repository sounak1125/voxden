"""Safe experimental output paths and metadata with no invented measurements."""
import hashlib
import importlib.metadata
import json
from datetime import datetime, timezone
from pathlib import Path

from dataset import ROOT, write_json

WORK = ROOT / 'training' / 'work'
OUTPUT = ROOT / 'models' / 'voxden-asr-v0.1'
CT2_FILES = ('model.bin', 'config.json', 'tokenizer.json', 'preprocessor_config.json', 'vocabulary.json')


def now():
    return datetime.now(timezone.utc).isoformat()


def versions():
    result = {}
    for package in ('torch', 'transformers', 'peft', 'accelerate', 'faster-whisper', 'ctranslate2', 'numpy', 'soundfile', 'scipy'):
        try:
            result[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            result[package] = None
    return result


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def validate_output_paths(work, output):
    work, output = Path(work).resolve(), Path(output).resolve()
    if not work.is_relative_to(WORK.resolve()):
        raise ValueError(f'work directory must be {WORK} or a child')
    model_root = (ROOT / 'models').resolve()
    if output.parent != model_root or not (output.name == 'voxden-asr-v0.1' or output.name.startswith('voxden-asr-v0.1-')):
        raise ValueError('output must be models/voxden-asr-v0.1 (or a voxden-asr-v0.1-* experiment); application model paths are forbidden')
    return work, output


def require_empty(path):
    path = Path(path)
    if path.exists() and (not path.is_dir() or any(path.iterdir())):
        raise ValueError(f'Refusing to overwrite non-empty output: {path}. Use a fresh experiment directory.')


def validate_ct2(path):
    path = Path(path)
    missing = [name for name in CT2_FILES if not (path / name).is_file() or (path / name).stat().st_size == 0]
    if missing:
        raise ValueError('incomplete CTranslate2 model: ' + ', '.join(missing))
    for name in CT2_FILES[1:]:
        try:
            value = json.loads((path / name).read_text(encoding='utf-8'))
            if not isinstance(value, (dict, list) if name == 'vocabulary.json' else dict) or not value:
                raise ValueError('empty/non-object JSON')
        except (ValueError, OSError) as exc:
            raise ValueError(f'invalid {name}: {exc}') from exc
    return {name: (path / name).stat().st_size for name in CT2_FILES}


def model_signature(path):
    validate_ct2(path)
    return {name: file_hash(Path(path) / name) for name in CT2_FILES}


def new_metadata(training):
    return {'name': 'VoxDen ASR', 'version': '0.1', 'status': 'unvalidated_candidate',
            'base_model': training['base_model'], 'training_method': 'LoRA',
            'training_samples': training['training_samples'], 'created_at': now(),
            'training': training, 'evaluation': {f'{model}_{metric}': None for model in ('stock', 'voxden')
                                              for metric in ('wer', 'cer', 'term_recall')},
            'standalone_validation': None, 'regression_evaluation': None}


def record_benchmark(model_dir, report):
    path = Path(model_dir) / 'metadata.json'
    metadata = json.loads(path.read_text(encoding='utf-8'))
    if report['models']['voxden']['model_signature'] != model_signature(model_dir):
        raise ValueError('benchmark belongs to different model weights')
    for model in ('stock', 'voxden'):
        scores = report['models'][model]['corrections']
        for metric in ('wer', 'cer', 'term_recall'):
            metadata['evaluation'][f'{model}_{metric}'] = scores[metric]
    metadata['regression_evaluation'] = {name: report['models'][name]['regression'] for name in ('stock', 'voxden')}
    metadata['benchmark'] = {k: report[k] for k in ('created_at', 'protocol', 'assessment')}
    metadata['status'] = 'evaluated_candidate'
    write_json(path, metadata)
