#!/usr/bin/env python3
"""Local ASR sidecar with Whisper, Qwen3-ASR, and Voxtral backends."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import sys

# Whisper often emits these on silence / padding. Drop only if the *whole* clip is this.
BOILERPLATE = frozenset(
    {
        "thank you",
        "thanks",
        "thanks for watching",
        "thank you for watching",
        "please subscribe",
        "subscribe",
        "the end",
        "bye",
        "you",
        "you.",
        "mbc news",
        "subtitles by the amara.org community",
    }
)

VAD_PARAMETERS = {
    "threshold": 0.5,
    "min_speech_duration_ms": 250,
    "min_silence_duration_ms": 400,
    "speech_pad_ms": 200,
}

DEFAULT_MODEL = "large-v3"
DEFAULT_QWEN_MODEL = "Qwen/Qwen3-ASR-1.7B"
DEFAULT_VOXTRAL_MODEL = "mistralai/Voxtral-Mini-3B-2507"
ENGINE_IDS = frozenset({"whisper", "qwen3-asr", "voxtral"})
_runtime = {
    "engine": "faster-whisper",
    "model": DEFAULT_MODEL,
    "device": "cpu",
    "compute_type": "int8",
}
_backend_warning = ""
_dll_dirs_applied = False


def normalize_engine(value):
    engine = str(value or "").strip().lower()
    return engine if engine in ENGINE_IDS else "whisper"


def selected_engine(env=None):
    env = env or os.environ
    return normalize_engine(env.get("VOXDEN_ASR_ENGINE"))


def module_available(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def backend_probe(engine, env=None):
    env = env or os.environ
    engine = normalize_engine(engine)
    if engine == "qwen3-asr":
        missing = [name for name in ("torch", "qwen_asr") if not module_available(name)]
        model = env.get("VOXDEN_QWEN_ASR_MODEL") or DEFAULT_QWEN_MODEL
        label = "Qwen3-ASR"
    elif engine == "voxtral":
        missing = [
            name
            for name in ("torch", "transformers", "accelerate", "mistral_common")
            if not module_available(name)
        ]
        model = env.get("VOXDEN_VOXTRAL_MODEL") or DEFAULT_VOXTRAL_MODEL
        label = "Voxtral"
    else:
        missing = [] if module_available("faster_whisper") else ["faster-whisper"]
        model = env.get("VOXDEN_MODEL") or DEFAULT_MODEL
        label = "Whisper"
    return {
        "available": not missing,
        "engine": engine,
        "model": model,
        "missing": missing,
        "error": "" if not missing else (
            label + " dependencies are missing (" + ", ".join(missing)
            + "). Install sidecar/requirements-asr.txt."
        ),
    }


def emit(obj):
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(line.encode("utf-8"))
    sys.stdout.buffer.flush()


def find_cuda_bin_dirs(env=None):
    env = env or os.environ
    roots = []
    seen_roots = set()

    def add_root(root):
        if not root:
            return
        root = os.path.abspath(root)
        if root in seen_roots or not os.path.isdir(root):
            return
        seen_roots.add(root)
        roots.append(root)

    add_root(os.path.join(sys.prefix, "Lib", "site-packages"))
    try:
        import site
        for p in site.getsitepackages():
            add_root(p)
        add_root(site.getusersitepackages())
    except Exception:
        pass
    extra = env.get("VOXDEN_CUDA_BIN")
    if extra:
        add_root(extra)
    home = os.path.expanduser("~")
    add_root(os.path.join(home, r"AppData\Local\Programs\Python\Python312\Lib\site-packages"))
    add_root(os.path.join(home, r"AppData\Local\Programs\Python\Python311\Lib\site-packages"))

    dirs = []
    seen = set()
    for root in roots:
        nvidia = os.path.join(root, "nvidia")
        if not os.path.isdir(nvidia):
            continue
        try:
            names = os.listdir(nvidia)
        except OSError:
            continue
        for name in names:
            bin_dir = os.path.join(nvidia, name, "bin")
            if os.path.isdir(bin_dir) and bin_dir not in seen:
                seen.add(bin_dir)
                dirs.append(bin_dir)
    return dirs


def apply_cuda_dll_dirs(env=None):
    global _dll_dirs_applied
    dirs = find_cuda_bin_dirs(env)
    if dirs:
        os.environ["PATH"] = os.pathsep.join(dirs) + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            for d in dirs:
                try:
                    os.add_dll_directory(d)
                except OSError:
                    pass
    _dll_dirs_applied = True
    return dirs


def cublas_available():
    if not _dll_dirs_applied:
        apply_cuda_dll_dirs()
    if sys.platform != "win32":
        return True
    try:
        import ctypes
        ctypes.WinDLL("cublas64_12.dll")
        return True
    except OSError:
        return False


def cuda_device_count():
    apply_cuda_dll_dirs()
    try:
        import ctranslate2
        return int(ctranslate2.get_cuda_device_count() or 0)
    except Exception:
        return 0


def pick_runtime(env=None, cuda_count=None, cublas_ok=None):
    env = env or os.environ
    model_name = (env.get("VOXDEN_MODEL") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    requested = (env.get("VOXDEN_DEVICE") or "auto").strip().lower()
    if requested == "cpu":
        cuda_count = 0
    elif cuda_count is None:
        cuda_count = cuda_device_count()
    if cublas_ok is None:
        cublas_ok = True if cuda_count < 1 else cublas_available()
    if requested == "cpu" or cuda_count < 1 or not cublas_ok:
        return {
            "engine": "faster-whisper",
            "model": model_name,
            "device": "cpu",
            "compute_type": (env.get("VOXDEN_COMPUTE") or "int8").strip() or "int8",
        }
    return {
        "engine": "faster-whisper",
        "model": model_name,
        "device": "cuda",
        "compute_type": (env.get("VOXDEN_COMPUTE") or "float16").strip() or "float16",
    }


def load_model():
    from faster_whisper import WhisperModel

    global _runtime
    runtime = pick_runtime()
    download_root = os.environ.get("VOXDEN_MODEL_DIR") or None
    kwargs = {
        "device": runtime["device"],
        "compute_type": runtime["compute_type"],
    }
    if download_root:
        os.makedirs(download_root, exist_ok=True)
        kwargs["download_root"] = download_root

    try:
        model = WhisperModel(runtime["model"], **kwargs)
        _runtime = runtime
        return model
    except Exception:
        if runtime["device"] != "cuda":
            raise
        kwargs["device"] = "cpu"
        kwargs["compute_type"] = "int8"
        model = WhisperModel(runtime["model"], **kwargs)
        _runtime = {
            "engine": "faster-whisper",
            "model": runtime["model"],
            "device": "cpu",
            "compute_type": "int8",
        }
        return model


def normalize_boilerplate(text):
    s = re.sub(r"\s+", " ", str(text or "")).strip().lower()
    s = re.sub(r"[.!?]+$", "", s).strip()
    return s


def is_boilerplate(text):
    return normalize_boilerplate(text) in BOILERPLATE


def should_keep_segment(text, no_speech_prob=0.0, avg_logprob=0.0):
    t = str(text or "").strip()
    if not t:
        return False
    nsp = float(no_speech_prob or 0)
    lp = float(avg_logprob or 0)
    if nsp > 0.6 and lp < -0.5:
        return False
    if is_boilerplate(t) and (nsp > 0.35 or lp < -0.6):
        return False
    return True


def transcribe_kwargs(initial_prompt=None, language="en", vad_filter=True):
    kwargs = {
        "language": language or "en",
        "beam_size": 5,
        "best_of": 5,
        "vad_filter": bool(vad_filter),
        "vad_parameters": dict(VAD_PARAMETERS),
        "condition_on_previous_text": False,
        "multilingual": False,
        "no_speech_threshold": 0.6,
        "compression_ratio_threshold": 2.4,
        "log_prob_threshold": -1.0,
        "repetition_penalty": 1.15,
        "no_repeat_ngram_size": 3,
        "temperature": [0.0, 0.2, 0.4],
    }
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt
    return kwargs


def join_segments(segments):
    parts = []
    for seg in segments:
        text = (getattr(seg, "text", None) or "").strip()
        if not should_keep_segment(
            text,
            getattr(seg, "no_speech_prob", 0.0),
            getattr(seg, "avg_logprob", 0.0),
        ):
            continue
        parts.append(text)
    return " ".join(parts).strip()


def transcribe_file(model, path, initial_prompt=None, vad_filter=None, language="en"):
    import numpy as np
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

    use_vad = True if vad_filter is None else bool(vad_filter)
    audio = decode_audio(path, sampling_rate=16000)
    if audio is None or getattr(audio, "size", 0) == 0:
        return ""
    if use_vad:
        chunks = get_speech_timestamps(audio, VadOptions(**VAD_PARAMETERS))
        if not chunks:
            return ""
        audio_chunks, _meta = collect_chunks(audio, chunks)
        if not audio_chunks or all(getattr(c, "size", 0) == 0 for c in audio_chunks):
            return ""
        audio = np.concatenate(audio_chunks, axis=0)
        if getattr(audio, "size", 0) == 0:
            return ""
    kwargs = transcribe_kwargs(initial_prompt, language, False)
    segments, _info = model.transcribe(audio, **kwargs)
    return join_segments(segments)


def pick_torch_runtime(env=None):
    env = env or os.environ
    import torch

    requested = str(env.get("VOXDEN_DEVICE") or "auto").strip().lower()
    have_cuda = bool(torch.cuda.is_available())
    if requested == "cuda" and not have_cuda:
        raise RuntimeError("NVIDIA GPU was requested, but PyTorch cannot use CUDA.")
    device = "cpu" if requested == "cpu" or not have_cuda else "cuda"
    if device == "cpu":
        return {
            "device": "cpu",
            "device_map": "cpu",
            "dtype": torch.float32,
            "compute_type": "float32",
        }
    supports_bf16 = getattr(torch.cuda, "is_bf16_supported", lambda: False)()
    dtype = torch.bfloat16 if supports_bf16 else torch.float16
    return {
        "device": "cuda",
        "device_map": "cuda:0",
        "dtype": dtype,
        "compute_type": "bfloat16" if supports_bf16 else "float16",
    }


def language_name(code):
    names = {
        "en": "English",
        "hi": "Hindi",
        "de": "German",
        "fr": "French",
        "es": "Spanish",
        "pt": "Portuguese",
        "it": "Italian",
        "nl": "Dutch",
    }
    return names.get(str(code or "").strip().lower())


class WhisperBackend:
    def __init__(self):
        self.model = load_model()

    def transcribe(self, path, prompt=None, vad=None, language="en"):
        return transcribe_file(self.model, path, prompt, vad, language)


class QwenBackend:
    def __init__(self):
        import torch
        from qwen_asr import Qwen3ASRModel

        global _runtime
        runtime = pick_torch_runtime()
        model_name = os.environ.get("VOXDEN_QWEN_ASR_MODEL") or DEFAULT_QWEN_MODEL
        max_tokens = max(64, int(os.environ.get("VOXDEN_ASR_MAX_TOKENS") or 1024))
        self.model = Qwen3ASRModel.from_pretrained(
            model_name,
            dtype=runtime["dtype"],
            device_map=runtime["device_map"],
            max_inference_batch_size=1,
            max_new_tokens=max_tokens,
        )
        self.torch = torch
        _runtime = {
            "engine": "qwen3-asr",
            "model": model_name,
            "device": runtime["device"],
            "compute_type": runtime["compute_type"],
        }

    def transcribe(self, path, prompt=None, vad=None, language="en"):
        del prompt, vad
        with self.torch.inference_mode():
            results = self.model.transcribe(audio=path, language=language_name(language))
        if not results:
            return ""
        return str(getattr(results[0], "text", "") or "").strip()


class VoxtralBackend:
    def __init__(self):
        import torch
        from transformers import AutoProcessor, VoxtralForConditionalGeneration

        global _runtime
        runtime = pick_torch_runtime()
        model_name = os.environ.get("VOXDEN_VOXTRAL_MODEL") or DEFAULT_VOXTRAL_MODEL
        self.max_tokens = max(64, int(os.environ.get("VOXDEN_ASR_MAX_TOKENS") or 1024))
        self.device = runtime["device"]
        self.dtype = runtime["dtype"]
        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(model_name)
        self.model = VoxtralForConditionalGeneration.from_pretrained(
            model_name,
            torch_dtype=self.dtype,
            device_map=runtime["device_map"],
        )
        self.model.eval()
        self.model_name = model_name
        _runtime = {
            "engine": "voxtral",
            "model": model_name,
            "device": runtime["device"],
            "compute_type": runtime["compute_type"],
        }

    def transcribe(self, path, prompt=None, vad=None, language="en"):
        del prompt, vad
        inputs = self.processor.apply_transcription_request(
            language=str(language or "en"),
            audio=path,
            model_id=self.model_name,
        )
        inputs = inputs.to(self.device, dtype=self.dtype)
        with self.torch.inference_mode():
            outputs = self.model.generate(**inputs, max_new_tokens=self.max_tokens)
        prompt_length = inputs.input_ids.shape[1]
        decoded = self.processor.batch_decode(
            outputs[:, prompt_length:],
            skip_special_tokens=True,
        )
        return str(decoded[0] if decoded else "").strip()


def compact_error(exc):
    text = re.sub(r"\s+", " ", str(exc or "")).strip()
    return text[:220] if text else exc.__class__.__name__


def release_failed_torch_load():
    try:
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def load_selected_backend():
    global _backend_warning
    requested = selected_engine()
    probe = backend_probe(requested)
    if not probe["available"]:
        if requested == "whisper":
            raise RuntimeError(probe["error"])
        _backend_warning = probe["error"] + " Using Whisper fallback."
        return WhisperBackend()

    try:
        if requested == "qwen3-asr":
            backend = QwenBackend()
        elif requested == "voxtral":
            backend = VoxtralBackend()
        else:
            backend = WhisperBackend()
        _backend_warning = ""
        return backend
    except Exception as exc:
        if requested == "whisper":
            raise
        release_failed_torch_load()
        _backend_warning = (
            ("Qwen3-ASR" if requested == "qwen3-asr" else "Voxtral")
            + " could not load (" + compact_error(exc) + "). Using Whisper fallback."
        )
        return WhisperBackend()


def parse_request(line):
    path = line
    prompt = None
    vad = None
    language = "en"
    if line.startswith("{") and line.endswith("}"):
        try:
            req = json.loads(line)
            path = req.get("path") or ""
            prompt = req.get("prompt") or None
            if "vad" in req:
                vad = bool(req.get("vad"))
            if req.get("language"):
                language = str(req.get("language"))
        except Exception:
            path = line
            prompt = None
            vad = None
            language = "en"
    return path, prompt, vad, language


def main():
    args = sys.argv[1:]
    if not args:
        emit({"ok": False, "error": "usage: transcribe.py --check | --serve | wav"})
        return 1

    apply_cuda_dll_dirs()

    if args[0] == "--check":
        requested = selected_engine()
        probe = backend_probe(requested)
        warning = ""
        if not probe["available"] and requested != "whisper":
            fallback = backend_probe("whisper")
            if not fallback["available"]:
                emit({"ok": False, "error": probe["error"] + " " + fallback["error"]})
                return 1
            warning = probe["error"] + " Using Whisper fallback."
            probe = fallback
        elif not probe["available"]:
            emit({"ok": False, "error": probe["error"]})
            return 1
        emit({
            "ok": True,
            "selected_engine": requested,
            "engine": "faster-whisper" if probe["engine"] == "whisper" else probe["engine"],
            "model": probe["model"],
            "device": str(os.environ.get("VOXDEN_DEVICE") or "auto"),
            "warning": warning,
        })
        return 0

    if args[0] == "--self-test":
        assert is_boilerplate("Thank you.")
        assert is_boilerplate("Thanks for watching")
        assert not is_boilerplate("Thank you for the file")
        assert not should_keep_segment("Thank you.", no_speech_prob=0.8, avg_logprob=-1.0)
        assert should_keep_segment("Thank you.", no_speech_prob=0.1, avg_logprob=-0.2)
        assert not should_keep_segment("hello", no_speech_prob=0.9, avg_logprob=-1.2)
        assert should_keep_segment("Open Voxden", no_speech_prob=0.1, avg_logprob=-0.2)
        kw = transcribe_kwargs("Seedance, Voxden", "en", True)
        assert kw["language"] == "en"
        assert kw["beam_size"] == 5
        assert kw["multilingual"] is False
        assert kw["vad_filter"] is True
        path, prompt, vad, language = parse_request(
            '{"path":"a.wav","prompt":"Voxden","language":"en"}'
        )
        assert path == "a.wav" and prompt == "Voxden" and language == "en"
        gpu = pick_runtime({"VOXDEN_DEVICE": "auto", "VOXDEN_MODEL": "large-v3"}, cuda_count=1, cublas_ok=True)
        assert gpu["device"] == "cuda" and gpu["compute_type"] == "float16"
        cpu = pick_runtime({"VOXDEN_DEVICE": "auto", "VOXDEN_MODEL": "large-v3"}, cuda_count=0, cublas_ok=False)
        assert cpu["device"] == "cpu" and cpu["compute_type"] == "int8"
        missing = pick_runtime({"VOXDEN_DEVICE": "auto", "VOXDEN_MODEL": "large-v3"}, cuda_count=1, cublas_ok=False)
        assert missing["device"] == "cpu"
        forced = pick_runtime({"VOXDEN_DEVICE": "cpu", "VOXDEN_MODEL": "large-v3"}, cuda_count=8, cublas_ok=True)
        assert forced["device"] == "cpu"
        assert normalize_engine("QWEN3-ASR") == "qwen3-asr"
        assert normalize_engine("bad") == "whisper"
        assert language_name("en") == "English"
        emit({"ok": True, "self_test": True})
        return 0

    try:
        backend = load_selected_backend()
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1

    if args[0] == "--serve":
        emit({
            "ok": True,
            "ready": True,
            "engine": _runtime["engine"],
            "model": _runtime["model"],
            "device": _runtime["device"],
            "compute_type": _runtime["compute_type"],
            "selected_engine": selected_engine(),
            "warning": _backend_warning,
        })
        for line in sys.stdin:
            raw = line.strip()
            if not raw:
                continue
            if raw == "QUIT":
                break
            path, prompt, vad, language = parse_request(raw)
            try:
                text = backend.transcribe(path, prompt, vad, language)
                emit({"ok": True, "text": text})
            except Exception as exc:
                emit({"ok": False, "error": str(exc)})
        return 0

    try:
        text = backend.transcribe(args[0])
        emit({"ok": True, "text": text})
        return 0
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
