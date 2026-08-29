#!/usr/bin/env python3
"""Local faster-whisper sidecar. CUDA when available, CPU fallback. No API keys."""
from __future__ import annotations

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
_runtime = {
    "model": DEFAULT_MODEL,
    "device": "cpu",
    "compute_type": "int8",
}
_dll_dirs_applied = False


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
            "model": model_name,
            "device": "cpu",
            "compute_type": (env.get("VOXDEN_COMPUTE") or "int8").strip() or "int8",
        }
    return {
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
        try:
            import faster_whisper  # noqa: F401
        except Exception as exc:
            emit({"ok": False, "error": str(exc)})
            return 1
        model_name = os.environ.get("VOXDEN_MODEL", DEFAULT_MODEL)
        runtime = pick_runtime()
        emit({
            "ok": True,
            "engine": "faster-whisper",
            "model": model_name,
            "device": runtime["device"],
            "compute_type": runtime["compute_type"],
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
        emit({"ok": True, "self_test": True})
        return 0

    try:
        model = load_model()
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1

    if args[0] == "--serve":
        emit({
            "ok": True,
            "ready": True,
            "engine": "faster-whisper",
            "model": _runtime["model"],
            "device": _runtime["device"],
            "compute_type": _runtime["compute_type"],
        })
        for line in sys.stdin:
            raw = line.strip()
            if not raw:
                continue
            if raw == "QUIT":
                break
            path, prompt, vad, language = parse_request(raw)
            try:
                text = transcribe_file(model, path, prompt, vad, language)
                emit({"ok": True, "text": text})
            except Exception as exc:
                emit({"ok": False, "error": str(exc)})
        return 0

    try:
        text = transcribe_file(model, args[0])
        emit({"ok": True, "text": text})
        return 0
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
