"""Standalone inference using the existing sidecar's read-only decode helpers."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from functools import lru_cache
from pathlib import Path

from artifacts import OUTPUT, WORK, file_hash, model_signature, now, validate_ct2, versions
from dataset import ROOT, inspect_wav, write_json


def local_environment(allow_download=False):
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    os.environ['HF_HUB_DISABLE_IMPLICIT_TOKEN'] = '1'
    os.environ['DO_NOT_TRACK'] = '1'
    os.environ['WANDB_DISABLED'] = 'true'
    os.environ['HF_HUB_OFFLINE'] = '0' if allow_download else '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '0' if allow_download else '1'


@lru_cache(maxsize=1)
def sidecar():
    spec = importlib.util.spec_from_file_location('voxden_training_decode', ROOT / 'sidecar' / 'transcribe.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def decode_protocol(device='cuda', compute_type='float16', quality='accurate', vad=True):
    return {'device': device, 'compute_type': compute_type, 'quality': quality, 'vad': vad,
            'initial_prompt': None, 'language': 'per-row explicit label',
            'kwargs_without_language': {k: v for k, v in sidecar().transcribe_kwargs(None, 'en', False, quality).items() if k != 'language'},
            'vad_parameters': sidecar().VAD_PARAMETERS, 'segment_filter': 'sidecar.join_segments',
            'sidecar_sha256': file_hash(ROOT / 'sidecar' / 'transcribe.py'),
            'runtime_versions': {k: v for k, v in versions().items() if k in ('faster-whisper', 'ctranslate2', 'numpy')}}


def load_model(model_path, *, device='cuda', compute_type='float16', allow_download=False):
    local_environment(allow_download)
    # Retain DLL directory handles on Windows for the life of the model process.
    if sys.platform == 'win32':
        for directory in sidecar().find_cuda_bin_dirs():
            os.environ['PATH'] = directory + os.pathsep + os.environ.get('PATH', '')
            if hasattr(os, 'add_dll_directory'):
                _dll_handles.append(os.add_dll_directory(directory))
    from faster_whisper import WhisperModel
    import ctranslate2
    if device == 'cuda' and ctranslate2.get_cuda_device_count() < 1:
        raise ValueError('CUDA unavailable for CTranslate2; no CPU fallback. Check CUDA 12/cuDNN 9 DLLs.')
    return WhisperModel(str(model_path), device=device, compute_type=compute_type,
                        download_root=str(WORK / 'cache'), local_files_only=not allow_download)


_dll_handles = []


def resolve_stock(name, allow_download=False):
    local_environment(allow_download)
    if Path(name).is_dir():
        path = Path(name).resolve()
    else:
        from faster_whisper.utils import download_model
        path = Path(download_model(str(name), cache_dir=str(WORK / 'cache'), local_files_only=not allow_download))
    validate_ct2(path)
    return path


def transcribe(model, row, *, quality='accurate', vad=True):
    return sidecar().transcribe_file(model, row['audio'], initial_prompt=None,
                                     vad_filter=vad, language=row['language'], quality=quality)


def validate_standalone(model_path, audio, *, language='en', device='cuda', compute_type='float16', quality='accurate', vad=True):
    validate_ct2(model_path)
    details = inspect_wav(audio)
    started = time.perf_counter()
    model = load_model(model_path, device=device, compute_type=compute_type)
    try:
        text = transcribe(model, {'audio': str(audio), 'language': language}, quality=quality, vad=vad)
    finally:
        del model
    if not text.strip():
        raise ValueError('standalone inference produced no text; candidate validation failed (check speech/VAD)')
    return {'passed': True, 'created_at': now(), 'audio_sha256': details['audio_sha256'],
            'language': language, 'transcript': text, 'elapsed_seconds': time.perf_counter() - started,
            'model_signature': model_signature(model_path),
            'decode': decode_protocol(device, compute_type, quality, vad)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, default=OUTPUT)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--language', default='en')
    parser.add_argument('--device', choices=('cuda', 'cpu'), default='cuda')
    parser.add_argument('--compute-type', default='float16')
    parser.add_argument('--quality', choices=('accurate', 'fast'), default='accurate')
    parser.add_argument('--no-vad', action='store_true')
    parser.add_argument('--report', type=Path, default=WORK / 'standalone-validation.json')
    args = parser.parse_args()
    try:
        result = validate_standalone(args.model, args.audio, language=args.language, device=args.device,
                                     compute_type=args.compute_type, quality=args.quality, vad=not args.no_vad)
        write_json(args.report, result)
        metadata_file = args.model / 'metadata.json'
        if metadata_file.exists():
            metadata = json.loads(metadata_file.read_text(encoding='utf-8'))
            metadata['standalone_validation'] = result
            write_json(metadata_file, metadata)
        print(f'Standalone model loaded and transcribed speech. Local report: {args.report}')
        return 0
    except (ValueError, RuntimeError, OSError, ImportError) as exc:
        print(f'Inference validation failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
