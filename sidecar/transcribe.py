#!/usr/bin/env python3
"""Local ASR sidecar with Whisper, Qwen3-ASR, and Parakeet Fast-chat backends."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import sys
import time

_SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)

import qwen_accel

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
DEFAULT_PARAKEET_MODEL = "nemo-parakeet-tdt-0.6b-v2"
ENGINE_IDS = frozenset({"whisper", "qwen3-asr", "parakeet"})

# What each engine can actually do. The JavaScript side keeps the same table in
# src/asr-capabilities.js; scripts/test-asr-capabilities.js asserts the two
# agree, because a capability contract that disagrees with itself is worse than
# none at all.
#
# `vocabulary` is the one that mattered. Every request has always carried the
# user's dictionary in a "prompt" field, and two of the three backends opened
# with `del prompt`. The terms were accepted and dropped, silently, forever.
# Now a backend either names the mechanism it uses or reports "unsupported",
# and the reply says which happened.
#
#   initial_prompt  faster-whisper: text prefixed to the decoder. Whisper's
#                   prompt window is n_text_ctx/2 - 1 = 223 tokens.
#   context         qwen_asr >= 0.0.6: transcribe(audio, context=...) becomes
#                   the system message of the chat template. This is the
#                   contextual-biasing input Qwen3-ASR documents.
#   None            onnx-asr exposes recognize(path) and nothing else. The
#                   Parakeet TDT graph has no biasing entry point at all.
ENGINE_CAPABILITIES = {
    "whisper": {
        "vocabulary": "initial_prompt",
        "max_vocabulary_tokens": 180,
        "languages": ["en", "hi", "de", "fr", "es", "pt", "it", "nl"],
        "confidence": True,
        "segments": True,
    },
    "qwen3-asr": {
        "vocabulary": "context",
        "max_vocabulary_tokens": 600,
        "languages": ["en", "hi", "de", "fr", "es", "pt", "it", "nl"],
        "confidence": False,
        "segments": False,
    },
    "parakeet": {
        "vocabulary": None,
        "max_vocabulary_tokens": 0,
        "languages": ["en"],
        "confidence": False,
        "segments": True,
    },
}


def engine_capabilities(engine):
    return ENGINE_CAPABILITIES.get(normalize_engine(engine), ENGINE_CAPABILITIES["whisper"])


def vocabulary_mechanism(engine):
    return engine_capabilities(engine)["vocabulary"]


# The shape every backend returns. `vocabulary` is not decoration: it is how
# src/main.js knows whether the dictionary reached the model or has to be
# applied to the transcript afterwards, and it is what the diagnostics show the
# user instead of letting them guess.
def transcription(text, engine, device, vocabulary="none", language="", segments=None, extra=None):
    out = {
        "text": str(text or "").strip(),
        "engine": engine,
        "device": device,
        "vocabulary": vocabulary,
        "language": language or "",
    }
    if segments:
        out["segments"] = segments
    if extra:
        out.update(extra)
    return out
# What the processor setting can say. "directml" is the AMD entry -- and the
# Intel one, since a single DirectX 12 backend covers both -- so nothing here
# is named after a vendor except CUDA, which is a vendor's own product name.
DEVICE_IDS = frozenset({"auto", "cuda", "directml", "cpu"})
DEVICE_LABELS = {
    "cuda": "NVIDIA GPU",
    "directml": "AMD or Intel GPU",
    "rocm": "supported AMD GPU",
    "cpu": "CPU",
}
# Keyed by engine. faster-whisper is deliberately not in requirements-asr.txt --
# that file is only the optional engines -- so the default engine needs its own
# command rather than a pointer at the requirements file.
# What to install for a module that is absent. None means the package needs
# more than a plain pip install -- torch wants the CUDA index URL -- so the
# whole engine falls back to the requirements file.
PIP_NAMES = {
    "faster-whisper": "faster-whisper",
    "onnx-asr": "onnx-asr[hub]",
    "onnxruntime": "onnxruntime",
    "qwen_asr": "qwen-asr",
    "torch": None,
}
REQUIREMENTS_HINT = "pip install -r sidecar/requirements-asr.txt"


def install_command(missing):
    """Name only what is actually absent.

    A fixed per-engine command told anyone missing just onnx-asr to install
    onnxruntime as well. onnxruntime-gpu imports under the same module name, so
    that reads as present -- and following the advice would have put the CPU
    build alongside the GPU one, which is the combination the docs warn against.
    """
    names = []
    for module in missing:
        pip = PIP_NAMES.get(module, module)
        if pip is None:
            return REQUIREMENTS_HINT
        if pip not in names:
            names.append(pip)
    return "pip install " + " ".join(names) if names else REQUIREMENTS_HINT
_PARENT_PROGRESS = re.compile(r"^(Fetching\s+\d+\s+files|Loading checkpoint shards)$", re.I)
_last_hub_progress = [-1, ""]
_runtime = {
    "engine": "faster-whisper",
    "model": DEFAULT_MODEL,
    "device": "cpu",
    "compute_type": "int8",
}
_backend_warning = ""
# The install command is kept apart from the prose. Every consumer appends more
# sentences after the warning, so a command baked into it lands mid-paragraph
# with the next sentence running straight into it.
_backend_fix = ""
# Engine id the command belongs to, so the UI can name it instead of saying "it"
# two sentences after the engine was last mentioned.
_backend_fix_engine = ""
_fast_runtime = {
    "engine": "",
    "model": "",
    "device": "",
}
_dll_dirs_applied = False


def normalize_engine(value):
    engine = str(value or "").strip().lower()
    return engine if engine in ENGINE_IDS else "whisper"


def selected_engine(env=None):
    env = env or os.environ
    return normalize_engine(env.get("VOXDEN_ASR_ENGINE"))


def requested_device(env=None):
    env = env or os.environ
    value = str(env.get("VOXDEN_DEVICE") or "auto").strip().lower()
    return value if value in DEVICE_IDS else "auto"


def device_label(device):
    return DEVICE_LABELS.get(str(device or "").strip().lower(), "CPU")


def cpu_thread_count(env=None):
    """How much of the CPU the engines are allowed to use.

    CTranslate2 -- and through it faster-whisper -- runs on four threads when
    nothing tells it otherwise, however many cores the machine has. On a
    12-core Ryzen that leaves two thirds of the chip idle, and it is the
    largest single reason dictation crawls on a PC with no NVIDIA card to fall
    back to. ONNX Runtime picks a better number on its own; this is passed to
    it anyway so one setting moves both engines.

    os.cpu_count() counts logical processors. Every SMT-2 desktop part -- the
    whole Ryzen line, and Intel's performance cores -- reports two per core,
    and halving it recovers the physical count. The kernels here are
    SIMD-bound and saturate a core, so the sibling thread adds contention
    rather than throughput. The ceiling leaves a few cores for whatever the
    user is dictating into.
    """
    env = env or os.environ
    override = str(env.get("VOXDEN_CPU_THREADS") or "").strip()
    if override:
        try:
            value = int(override)
        except ValueError:
            value = 0
        if value > 0:
            return value
    logical = int(os.cpu_count() or 4)
    return max(4, min(logical // 2, 16))


def module_available(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def missing_note(probe):
    """What is absent, with no install command, so it can precede one."""
    return (
        probe["label"] + " is not installed on this PC (missing "
        + ", ".join(probe["missing"]) + ")."
    )


def join_warning(existing, extra):
    """Warnings accumulate across the primary and the Fast-dictation backend.
    Each clause is a finished sentence, so a space is all they need."""
    return (existing + " " + extra).strip() if existing else extra


def install_error(probe):
    """The full sentence. The command goes last so nothing follows it: these
    strings are shown verbatim in the app and users copy the tail."""
    return missing_note(probe) + " Run: " + install_command(probe["missing"])


def backend_probe(engine, env=None):
    env = env or os.environ
    engine = normalize_engine(engine)
    if engine == "parakeet":
        return parakeet_probe()
    if engine == "qwen3-asr":
        missing = [name for name in ("torch", "qwen_asr") if not module_available(name)]
        model = env.get("VOXDEN_QWEN_ASR_MODEL") or DEFAULT_QWEN_MODEL
        label = "Qwen3-ASR"
    else:
        missing = [] if module_available("faster_whisper") else ["faster-whisper"]
        model = env.get("VOXDEN_MODEL") or DEFAULT_MODEL
        label = "Whisper"
    probe = {
        "available": not missing,
        "engine": engine,
        "label": label,
        "model": model,
        "missing": missing,
        "error": "",
    }
    if missing:
        probe["error"] = install_error(probe)
    return probe


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
    requested = requested_device(env)
    threads = cpu_thread_count(env)
    # CTranslate2 has exactly one GPU backend and it is CUDA -- no ROCm, no
    # DirectML, no Vulkan. So "directml" here is not a request this engine can
    # refuse or honour: it describes a PC with an AMD or Intel card in it, and
    # Whisper lands on the CPU there the same way it does under "cpu". The
    # thread count is what makes that landing survivable.
    if requested in ("cpu", "directml"):
        cuda_count = 0
    elif cuda_count is None:
        cuda_count = cuda_device_count()
    if cublas_ok is None:
        cublas_ok = True if cuda_count < 1 else cublas_available()
    if cuda_count < 1 or not cublas_ok:
        return {
            "engine": "faster-whisper",
            "model": model_name,
            "device": "cpu",
            "compute_type": (env.get("VOXDEN_COMPUTE") or "int8").strip() or "int8",
            "cpu_threads": threads,
        }
    return {
        "engine": "faster-whisper",
        "model": model_name,
        "device": "cuda",
        "compute_type": (env.get("VOXDEN_COMPUTE") or "float16").strip() or "float16",
        "cpu_threads": threads,
    }


def load_model():
    from faster_whisper import WhisperModel

    global _runtime
    runtime = pick_runtime()
    download_root = os.environ.get("VOXDEN_MODEL_DIR") or None
    kwargs = {
        "device": runtime["device"],
        "compute_type": runtime["compute_type"],
        "cpu_threads": runtime["cpu_threads"],
        "local_files_only": os.environ.get("VOXDEN_OFFLINE") == "1",
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
            "cpu_threads": runtime["cpu_threads"],
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


def transcribe_kwargs(initial_prompt=None, language="en", vad_filter=True, quality=None):
    fast = str(quality or "").strip().lower() == "fast"
    kwargs = {
        "language": language or "en",
        "beam_size": 1 if fast else 3,
        "best_of": 1 if fast else 3,
        "vad_filter": bool(vad_filter),
        "vad_parameters": dict(VAD_PARAMETERS),
        "condition_on_previous_text": False,
        "multilingual": False,
        "no_speech_threshold": 0.6,
        "compression_ratio_threshold": 2.4,
        "log_prob_threshold": -1.0,
        "repetition_penalty": 1.15,
        "no_repeat_ngram_size": 3,
        "temperature": 0.0 if fast else [0.0, 0.2],
    }
    if initial_prompt:
        kwargs["initial_prompt"] = initial_prompt
    return kwargs


# How unsure a Whisper segment has to be before the finalizer is told about it.
# avg_logprob near zero is a confident decode; -0.8 is where a segment starts
# being a guess. This is the only confidence signal any of the three engines
# reports, so it is the only place uncertain-span rechecking can be gated on --
# and gating it is what stops the recheck from running on every clip.
UNCERTAIN_LOGPROB = -0.8


def join_segments(segments, collect=False):
    """Join kept segments, optionally reporting the shaky ones.

    The alignment is preserved rather than thrown away: each returned span
    carries the start and end the decoder gave it, so a later pass can go back
    to that slice of audio instead of guessing which words were doubtful.
    """
    parts = []
    spans = []
    for seg in segments:
        text = (getattr(seg, "text", None) or "").strip()
        logprob = float(getattr(seg, "avg_logprob", 0.0) or 0.0)
        no_speech = float(getattr(seg, "no_speech_prob", 0.0) or 0.0)
        if not should_keep_segment(text, no_speech, logprob):
            continue
        parts.append(text)
        if collect and logprob <= UNCERTAIN_LOGPROB:
            spans.append({
                "text": text,
                "start": round(float(getattr(seg, "start", 0.0) or 0.0), 3),
                "end": round(float(getattr(seg, "end", 0.0) or 0.0), 3),
                "logprob": round(logprob, 3),
            })
    joined = " ".join(parts).strip()
    return (joined, spans) if collect else joined


def transcribe_file(model, path, initial_prompt=None, vad_filter=None, language="en", quality=None):
    import numpy as np
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

    use_vad = True if vad_filter is None else bool(vad_filter)
    audio = decode_audio(path, sampling_rate=16000)
    if audio is None or getattr(audio, "size", 0) == 0:
        return "", []
    if use_vad:
        chunks = get_speech_timestamps(audio, VadOptions(**VAD_PARAMETERS))
        if not chunks:
            return "", []
        audio_chunks, _meta = collect_chunks(audio, chunks)
        if not audio_chunks or all(getattr(c, "size", 0) == 0 for c in audio_chunks):
            return "", []
        audio = np.concatenate(audio_chunks, axis=0)
        if getattr(audio, "size", 0) == 0:
            return "", []
    kwargs = transcribe_kwargs(initial_prompt, language, False, quality)
    segments, _info = model.transcribe(audio, **kwargs)
    return join_segments(segments, collect=True)


def pick_torch_runtime(env=None):
    """Choose Qwen's torch device from a real probe, not from the UI setting.

    CPU PyTorch stays CPU. A CUDA or ROCm pack may use the GPU only after
    torch reports the device and a tensor actually executes. DirectML is not
    a Qwen path. The Whisper cuBLAS pack does not change this.
    """
    env = env or os.environ
    import torch

    choice = qwen_accel.choose_backend(env, torch)
    dtype = choice.get("dtype")
    if dtype is None:
        dtype = qwen_accel.dtype_for(choice.get("compute_type") or "float32", torch)
    return {
        "device": choice["device"],
        "device_map": choice["device_map"],
        "dtype": dtype,
        "compute_type": choice["compute_type"],
        "backend": choice["backend"],
        "probe_passed": choice["probe_passed"],
        "fallback_reason": choice.get("fallback_reason") or "",
        "gpu_name": choice.get("gpu_name") or "",
        "gpu_arch": choice.get("gpu_arch") or "",
        "torch_version": choice.get("torch_version") or getattr(torch, "__version__", ""),
        "pack_id": choice.get("pack_id") or "",
        "pack_version": choice.get("pack_version") or "",
        "sdpa": choice.get("sdpa") or "",
        "build": choice.get("build") or qwen_accel.torch_build_kind(torch),
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


def emit_hub_progress(percent, detail=""):
    desc = re.sub(r"\s+", " ", str(detail or "")).strip() or "model"
    if _PARENT_PROGRESS.match(desc):
        return
    try:
        value = int(percent)
    except (TypeError, ValueError):
        return
    value = max(0, min(100, value))
    if _last_hub_progress[0] == value and _last_hub_progress[1] == desc:
        return
    _last_hub_progress[0] = value
    _last_hub_progress[1] = desc
    sys.stderr.write("VOXDEN_PROGRESS " + str(value) + " " + desc + "\n")
    sys.stderr.flush()


def hub_progress_tqdm(*args, **kwargs):
    from tqdm.auto import tqdm

    class _Tqdm(tqdm):
        def update(self, n=1):
            result = super().update(n)
            total = float(self.total or 0)
            current = float(self.n or 0)
            percent = int(round(100.0 * current / total)) if total else 0
            emit_hub_progress(percent, self.desc)
            return result

    kwargs["disable"] = False
    kwargs.setdefault("mininterval", 0.4)
    kwargs.setdefault("file", sys.stderr)
    return _Tqdm(*args, **kwargs)


def prefetch_hub_model(repo_id, ignore_patterns=None):
    from huggingface_hub import snapshot_download

    sys.stderr.write(
        "Downloading " + str(repo_id) + ". Large files can take several minutes.\n"
    )
    sys.stderr.flush()
    kwargs = {"repo_id": repo_id, "tqdm_class": hub_progress_tqdm}
    if ignore_patterns:
        kwargs["ignore_patterns"] = list(ignore_patterns)
    try:
        return snapshot_download(**kwargs)
    except TypeError:
        kwargs.pop("tqdm_class", None)
        return snapshot_download(**kwargs)


class WhisperBackend:
    engine_id = "whisper"

    def __init__(self):
        self.model = load_model()

    def transcribe(self, path, prompt=None, vad=None, language="en", quality=None):
        text, spans = transcribe_file(self.model, path, prompt, vad, language, quality)
        return transcription(
            text,
            "whisper",
            _runtime.get("device", ""),
            vocabulary="initial_prompt" if prompt else "none",
            language=language,
            segments=spans,
        )


def _qwen_runtime_record(runtime, model_name, init_passed=False):
    device = runtime.get("device") or "cpu"
    backend = runtime.get("backend") or ("cuda" if device == "cuda" else "cpu")
    return {
        "engine": "qwen3-asr",
        "model": model_name,
        "device": device,
        "backend": backend,
        "compute_type": runtime.get("compute_type") or "float32",
        "probe_passed": bool(runtime.get("probe_passed")),
        "init_passed": bool(init_passed),
        "fallback_reason": runtime.get("fallback_reason") or "",
        "gpu_name": runtime.get("gpu_name") or "",
        "gpu_arch": runtime.get("gpu_arch") or "",
        "torch_version": runtime.get("torch_version") or "",
        "pack_id": runtime.get("pack_id") or "",
        "pack_version": runtime.get("pack_version") or "",
        "sdpa": runtime.get("sdpa") or "",
    }


def qwen_result_extra(context=""):
    timings = qwen_accel.last_timings()
    return {
        "backend": _runtime.get("backend") or "cpu",
        "compute_type": _runtime.get("compute_type") or "",
        "gpu_name": _runtime.get("gpu_name") or "",
        "gpu_arch": _runtime.get("gpu_arch") or "",
        "torch_version": _runtime.get("torch_version") or "",
        "pack_id": _runtime.get("pack_id") or "",
        "pack_version": _runtime.get("pack_version") or "",
        "probe_passed": bool(_runtime.get("probe_passed")),
        "init_passed": bool(_runtime.get("init_passed")),
        "fallback_reason": _runtime.get("fallback_reason") or "",
        "context_sha256": qwen_accel.last_context_sha256(),
        "context_chars": len(context or ""),
        "audio_sec": timings.get("audio_sec") or 0,
        "recognition_sec": timings.get("recognition_sec") or 0,
        "rtf": timings.get("rtf") or 0,
        "cold_start_sec": timings.get("cold_start_sec") or 0,
    }


class QwenBackend:
    engine_id = "qwen3-asr"

    def __init__(self):
        import torch
        from qwen_asr import Qwen3ASRModel

        global _runtime
        self.torch = torch
        self._loader = Qwen3ASRModel
        self.model_name = os.environ.get("VOXDEN_QWEN_ASR_MODEL") or DEFAULT_QWEN_MODEL
        self.max_tokens = max(64, int(os.environ.get("VOXDEN_ASR_MAX_TOKENS") or 512))
        self._offline = os.environ.get("VOXDEN_OFFLINE") == "1"
        started = time.perf_counter()
        runtime = pick_torch_runtime()
        try:
            self.model = self._load(runtime)
            runtime["init_passed"] = True
        except Exception as exc:
            qwen_accel.mark_session_gpu_failed(runtime.get("backend"), exc)
            qwen_accel.release_gpu_state(torch)
            if (runtime.get("backend") or "cpu") == "cpu":
                raise
            sys.stderr.write("Qwen could not start on the GPU; retrying as CPU Qwen.\n")
            sys.stderr.flush()
            cpu_env = dict(os.environ)
            cpu_env["VOXDEN_QWEN_FORCE_CPU"] = "1"
            runtime = pick_torch_runtime(cpu_env)
            runtime["fallback_reason"] = qwen_accel.friendly_user_error(exc)
            self.model = self._load(runtime)
            runtime["init_passed"] = True
            runtime["backend"] = "cpu"
            runtime["device"] = "cpu"
            runtime["device_map"] = "cpu"
        qwen_accel.record_timings("cold_start_sec", time.perf_counter() - started)
        self.runtime = runtime
        _runtime = _qwen_runtime_record(runtime, self.model_name, init_passed=True)

    def _load(self, runtime):
        return self._loader.from_pretrained(
            self.model_name,
            dtype=runtime["dtype"],
            device_map=runtime["device_map"],
            max_inference_batch_size=1,
            max_new_tokens=self.max_tokens,
            local_files_only=self._offline,
        )

    def _fallback_to_cpu(self, exc):
        global _runtime
        qwen_accel.mark_session_gpu_failed(self.runtime.get("backend"), exc)
        qwen_accel.release_gpu_state(self.torch)
        cpu_env = dict(os.environ)
        cpu_env["VOXDEN_QWEN_FORCE_CPU"] = "1"
        runtime = pick_torch_runtime(cpu_env)
        runtime["fallback_reason"] = qwen_accel.friendly_user_error(exc)
        self.model = self._load(runtime)
        self.runtime = runtime
        _runtime = _qwen_runtime_record(runtime, self.model_name, init_passed=True)
        _runtime["fallback_reason"] = runtime["fallback_reason"]

    def transcribe(self, path, prompt=None, vad=None, language="en", quality=None):
        """Recognise one clip, with the caller's vocabulary actually applied.

        `context` is Qwen3-ASR's documented contextual-biasing input: qwen_asr
        puts the string straight into the system message of the chat template
        (see Qwen3ASRModel._build_messages). This method used to open with
        `del prompt`, so every custom word a user had added was discarded here
        -- on the engine the shipping build defaults to. Wiring the one keyword
        argument is the whole fix.

        CPU, CUDA and ROCm all receive that same stripped context string.
        A GPU failure retries once as CPU Qwen with the same arguments.

        VAD is Whisper's; Qwen chunks internally. `quality` has no knob here --
        there is no beam size to trade -- so it stays unused rather than being
        faked.
        """
        del vad, quality
        context = qwen_accel.record_context(prompt)
        audio_sec = wav_duration_sec(path)
        started = time.perf_counter()

        def run():
            with self.torch.inference_mode():
                return self.model.transcribe(
                    audio=path,
                    context=context,
                    language=language_name(language),
                )

        try:
            results = run()
        except Exception as exc:
            if (self.runtime.get("backend") or "cpu") == "cpu" or not qwen_accel.is_accel_error(exc):
                raise
            sys.stderr.write("Qwen GPU recognition failed; retrying as CPU Qwen.\n")
            sys.stderr.flush()
            self._fallback_to_cpu(exc)
            results = run()
        elapsed = time.perf_counter() - started
        qwen_accel.record_timings("recognition_sec", elapsed, audio_sec)
        text = str(getattr(results[0], "text", "") or "").strip() if results else ""
        device = _runtime.get("device", "")
        if _runtime.get("backend") == "rocm":
            device = "rocm"
        return transcription(
            text,
            "qwen3-asr",
            device,
            vocabulary="context" if context else "none",
            language=language,
            extra=qwen_result_extra(context),
        )


def wav_duration_sec(path):
    import wave
    try:
        with wave.open(path, "rb") as wf:
            rate = float(wf.getframerate() or 16000)
            if rate <= 0:
                return 0.0
            return wf.getnframes() / rate
    except Exception:
        return 0.0


def join_parakeet_result(result):
    if result is None:
        return ""
    if isinstance(result, str):
        return result.strip()
    if hasattr(result, "text") and not isinstance(result, (list, tuple)):
        return str(getattr(result, "text", "") or "").strip()
    try:
        parts = []
        for item in result:
            if item is None:
                continue
            if isinstance(item, str):
                parts.append(item.strip())
            elif hasattr(item, "text"):
                parts.append(str(item.text or "").strip())
            else:
                parts.append(str(item or "").strip())
        return " ".join(p for p in parts if p)
    except TypeError:
        return str(result or "").strip()


def _dir_has_onnx(path):
    if not path or not os.path.isdir(path):
        return False
    try:
        names = os.listdir(path)
    except OSError:
        return False
    return any(name.lower().endswith(".onnx") for name in names)


def parakeet_cache_dir(quantization="int8"):
    """Where a given precision of the Parakeet weights lives.

    One directory per precision, because the two are different downloads and
    prepare_parakeet_cache_dir deletes whatever does not match what it was
    asked for. Sharing a path meant that moving the processor setting between
    the CPU and a GPU threw away 660 MB of int8 weights to fetch 2.5 GB of
    float32, and moving it back threw those away again -- a setting nobody
    would touch twice.

    int8 keeps the original path so weights already downloaded are still
    found; float32 gets the sibling.
    """
    configured = os.environ.get("VOXDEN_PARAKEET_INT8_DIR" if quantization == "int8"
                                else "VOXDEN_PARAKEET_FP32_DIR")
    if configured:
        return configured
    root = os.environ.get("VOXDEN_MODEL_DIR")
    if not root:
        return None
    name = "parakeet-tdt-0.6b-v2" if quantization == "int8" else "parakeet-tdt-0.6b-v2-fp32"
    return os.path.join(root, name)


def provider_device(providers):
    """Which of the three devices a provider list actually resolves to.

    Order matters and matches onnx_providers: whatever is first is what
    ONNX Runtime will place the graph on, and CPU is only ever last.
    """
    if "CUDAExecutionProvider" in providers:
        return "cuda"
    if "DmlExecutionProvider" in providers:
        return "directml"
    return "cpu"


def parakeet_quantization(providers):
    """int8 weights on the CPU, full precision on a GPU.

    The int8 build is a QDQ graph -- a quantize/dequantize pair wrapped round
    every matmul. That trade wins on a CPU, where the integer kernels are the
    point. On DirectML it is the wrong side of the trade: the card runs float
    natively, the extra nodes are pure overhead, and any GPU that can run
    DirectML at all has room for the float weights.
    """
    return None if provider_device(providers) != "cpu" else "int8"


def parakeet_onnx_filename(stem, quantization=None):
    suffix = "?" + quantization if quantization else ""
    name = stem + suffix + ".onnx"
    if os.name == "nt":
        name = name.replace("?", ".")
    return name


def parakeet_required_files(quantization=None):
    names = [
        parakeet_onnx_filename("encoder-model", quantization),
        parakeet_onnx_filename("decoder_joint-model", quantization),
        "vocab.txt",
        "config.json",
    ]
    if not quantization:
        # The float32 encoder is 42 MB of graph pointing at 2.4 GB of weights
        # in a separate file. Counting the graph alone as a complete download
        # calls an interrupted 2.4 GB transfer finished, and the load fails
        # somewhere far less legible than a missing-file check.
        names.append("encoder-model.onnx.data")
    return tuple(names)


def parakeet_cache_ready(cache_dir, quantization=None):
    if not cache_dir or not os.path.isdir(cache_dir):
        return False
    return all(os.path.isfile(os.path.join(cache_dir, name)) for name in parakeet_required_files(quantization))


def prepare_parakeet_cache_dir(providers):
    """Return VOXDEN_MODEL_DIR cache path; drop stale empty dirs that block Hub download."""
    quantization = parakeet_quantization(providers)
    cache_dir = parakeet_cache_dir(quantization)
    if os.environ.get("VOXDEN_OFFLINE") == "1":
        if not parakeet_cache_ready(cache_dir, quantization):
            raise RuntimeError("Parakeet setup is incomplete. Finish speech setup in Settings.")
        return cache_dir
    if not cache_dir:
        return None
    if os.path.isdir(cache_dir) and not parakeet_cache_ready(cache_dir, quantization):
        shutil.rmtree(cache_dir, ignore_errors=True)
    return cache_dir


def parakeet_weights_present():
    for quantization in ("int8", None):
        cache_dir = parakeet_cache_dir(quantization)
        if cache_dir and parakeet_cache_ready(cache_dir, quantization):
            return True
    hf = os.environ.get("HF_HOME") or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    hub = os.path.join(hf, "hub")
    if not os.path.isdir(hub):
        return False
    try:
        for name in os.listdir(hub):
            if "parakeet-tdt-0.6b-v2" not in name.lower():
                continue
            root = os.path.join(hub, name)
            if _dir_has_onnx(root):
                return True
            snapshots = os.path.join(root, "snapshots")
            if not os.path.isdir(snapshots):
                continue
            for snap in os.listdir(snapshots):
                if _dir_has_onnx(os.path.join(snapshots, snap)):
                    return True
    except OSError:
        return False
    return False


def find_self_test_wav():
    here = os.path.dirname(os.path.abspath(__file__))
    pending = os.path.join(os.path.dirname(here), "data", "audio", "pending")
    if not os.path.isdir(pending):
        return None
    try:
        names = sorted(os.listdir(pending))
    except OSError:
        return None
    for name in names:
        if name.lower().endswith(".wav"):
            return os.path.join(pending, name)
    return None


def load_onnx_asr_model(model_name, cache_dir, providers, quantization, sess_options=None):
    import onnx_asr

    def attempt(kwargs):
        if cache_dir:
            return onnx_asr.load_model(model_name, cache_dir, **kwargs)
        return onnx_asr.load_model(model_name, **kwargs)

    kwargs = {"providers": providers}
    if quantization:
        kwargs["quantization"] = quantization
    if sess_options is not None:
        kwargs["sess_options"] = sess_options
    # Older onnx-asr releases take fewer of these, and the runtime Voxden
    # downloads is pinned to whatever was current when it was built. Shed one
    # argument at a time, least important first: session options are tuning,
    # quantization decides which weights get fetched, providers decide which
    # chip runs them.
    for drop in (None, "sess_options", "quantization", "providers"):
        if drop:
            kwargs.pop(drop, None)
        try:
            return attempt(kwargs)
        except TypeError:
            if not kwargs:
                raise
    return attempt({})


def available_providers():
    try:
        import onnxruntime as ort
        return list(ort.get_available_providers() or [])
    except Exception:
        return []


def onnx_providers(requested, available=None):
    """The execution providers Parakeet may use, in the order ORT will try them.

    DirectML is the AMD path for Parakeet, and on Windows it is the only one
    Parakeet has. CTranslate2 (Whisper) has CUDA only. Qwen3-ASR can use a
    separate CUDA or Windows ROCm PyTorch pack; DirectML is not a Qwen path.
    A Radeon that is not on AMD's published Windows ROCm list stays on CPU Qwen.

    An explicit choice is never quietly served by the other vendor's backend:
    asking for CUDA on a machine without it lands on the CPU, not on DirectML.

    "auto" deliberately does not reach for DirectML, and this is the one place
    where a GPU is left on the table on purpose. Every machine with a DirectX
    12 card answers to it -- which is very nearly every machine -- so ranking
    it above the CPU would move most users onto it without their asking. It
    would cost them a 2.5 GB download in place of a 0.7 GB one, because
    DirectML wants the float32 weights, and buy nothing they can feel: on a
    24-thread CPU the two measured 15.9x against 17.0x realtime. DirectML
    earns its place where the CPU is the weak part, and the user is the one
    who knows that. So auto stays CUDA-or-CPU, and the AMD path is a setting
    somebody chooses.
    """
    if available is None:
        available = available_providers()
    providers = []
    if requested in ("auto", "cuda") and "CUDAExecutionProvider" in available:
        providers.append("CUDAExecutionProvider")
    if requested == "directml" and "DmlExecutionProvider" in available:
        providers.append("DmlExecutionProvider")
    providers.append("CPUExecutionProvider")
    return providers


def onnx_session_options(providers, env=None):
    """Per-provider session settings ONNX Runtime needs rather than prefers.

    DirectML allocates and schedules its own GPU resources, so ORT's memory
    pattern planner and its parallel executor both work against it -- the
    DirectML docs call for them off, and leaving them on is a documented way
    to get wrong results or a crash rather than a slow run.

    The CPU list gets the thread count instead, so one environment variable
    moves Whisper and Parakeet together.
    """
    try:
        import onnxruntime as ort
    except Exception:
        return None
    options = ort.SessionOptions()
    if "DmlExecutionProvider" in providers:
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        return options
    if provider_device(providers) == "cpu":
        options.intra_op_num_threads = cpu_thread_count(env)
        return options
    return None


def parakeet_probe():
    missing = []
    if not module_available("onnx_asr"):
        missing.append("onnx-asr")
    if not module_available("onnxruntime"):
        missing.append("onnxruntime")
    model = os.environ.get("VOXDEN_PARAKEET_MODEL") or DEFAULT_PARAKEET_MODEL
    probe = {
        "available": not missing,
        "engine": "parakeet",
        "label": "Parakeet",
        "model": model,
        "missing": missing,
        "error": "",
    }
    if missing:
        probe["error"] = install_error(probe)
    return probe


def resolved_device(engine, env=None):
    """The device this engine will actually land on, worked out without
    loading anything.

    --check answers before a model exists, and what it says is what the
    settings hint renders as "is active on the ...". Reporting the *request*
    there produced a flat contradiction on any PC whose card cannot serve it:
    "DirectML is missing, so the AMD or Intel GPU cannot be used. Whisper
    large-v3 is active on the AMD or Intel GPU." A request is not a
    resolution, and only the resolution is true.

    Whisper and Parakeet both resolve cheaply -- one counts CUDA devices, the
    other asks ONNX Runtime which providers exist. Qwen3-ASR would need torch
    imported, which costs seconds against a 20s budget, so it answers CPU
    unless the accelerator pack has already been verified in this process.
    """
    env = env or os.environ
    engine = normalize_engine(engine)
    requested = requested_device(env)
    try:
        if engine == "parakeet":
            return provider_device(onnx_providers(requested))
        if engine == "qwen3-asr":
            if qwen_accel.force_cpu(env) or requested == "cpu":
                return "cpu"
            if env.get("VOXDEN_QWEN_ACCEL_READY") == "1":
                accel = qwen_accel.requested_accel(env)
                if accel == "rocm":
                    return "rocm"
                if accel == "cuda":
                    return "cuda"
            # Unverified GPU packs stay on CPU in --check. --serve is the
            # authority after a real tensor probe.
            if requested == "directml":
                return "cpu"
            if env.get("VOXDEN_TORCH_DEVICE") == "cpu":
                return "cpu"
            return "cpu"
        return pick_runtime(env)["device"]
    except Exception:
        return "cpu"


def gpu_mismatch_note(engine, env=None, available=None):
    """Why choosing a GPU did not accelerate this engine, said once, up front.

    Parakeet is the DirectML path. The Whisper cuBLAS pack is CUDA for
    CTranslate2 only. Qwen uses a separate CUDA or ROCm PyTorch pack, and
    until that pack is verified the honest answer is CPU Qwen.
    """
    env = env or os.environ
    engine = normalize_engine(engine)
    requested = requested_device(env)
    accel = qwen_accel.requested_accel(env)
    ready = env.get("VOXDEN_QWEN_ACCEL_READY") == "1"
    if engine == "qwen3-asr":
        if requested == "directml" and not (accel == "rocm" and ready):
            return (
                "Qwen3-ASR has no AMD or Intel GPU backend; only Parakeet does. "
                "Listed AMD GPUs can use a separate Qwen ROCm acceleration pack."
            )
        if qwen_accel.force_cpu(env) or (env.get("VOXDEN_TORCH_DEVICE") == "cpu" and not ready):
            if requested in ("cuda", "auto") and accel != "cuda":
                return (
                    "Qwen CUDA acceleration is not active, so Qwen3-ASR runs as CPU Qwen. "
                    "The Whisper cuBLAS pack does not accelerate Qwen."
                )
            if env.get("VOXDEN_TORCH_DEVICE") == "cpu" and accel != "cuda":
                return (
                    "Qwen uses CPU PyTorch in this build; the NVIDIA processor setting does not accelerate it."
                )
        return ""
    if requested != "directml":
        return ""
    if available is None:
        available = available_providers()
    if "DmlExecutionProvider" not in available:
        return (
            "DirectML is missing from this PC's speech engine, so the AMD or Intel"
            " GPU cannot be used. Reinstall the speech engine in Settings to add it."
        )
    if engine == "parakeet":
        return ""
    label = "Whisper"
    return label + " has no AMD or Intel GPU backend; only Parakeet does."


def pick_fast_backend(primary, fast, quality, language="en"):
    """Which backend takes this clip.

    The language guard is the important half. Parakeet is English-only, and
    handed Hindi it does not fail -- it returns confident English-shaped
    nonsense, which is worse than an error because nothing downstream can tell
    it went wrong. So the check lives here, at the point the backend is
    actually chosen, rather than in whichever caller happened to ask for the
    fast path.
    """
    if fast is None:
        return primary
    if str(language or "en").strip().lower() != "en":
        return primary
    return fast if str(quality or "").strip().lower() == "fast" else primary


class ParakeetBackend:
    engine_id = "parakeet"

    def __init__(self, as_primary=False):
        global _fast_runtime, _runtime
        probe = parakeet_probe()
        if not probe["available"]:
            raise RuntimeError(probe["error"])
        model_name = probe["model"]
        providers = onnx_providers(requested_device())
        cache_dir = prepare_parakeet_cache_dir(providers)
        quantization = parakeet_quantization(providers)
        device = provider_device(providers)
        sys.stderr.write(
            "Loading Parakeet " + model_name + " on the " + device_label(device) + ".\n"
        )
        sys.stderr.flush()
        try:
            self.model = load_onnx_asr_model(
                model_name, cache_dir, providers, quantization, onnx_session_options(providers)
            )
        except Exception:
            # A GPU that will not take the model is a slow dictation, not a
            # broken one. The CPU list is rebuilt rather than filtered, so the
            # int8 weights and the CPU thread count come back with it.
            if device == "cpu":
                raise
            sys.stderr.write(
                "Parakeet could not start on the " + device_label(device)
                + "; retrying on the CPU.\n"
            )
            sys.stderr.flush()
            providers = ["CPUExecutionProvider"]
            cache_dir = prepare_parakeet_cache_dir(providers)
            device = "cpu"
            self.model = load_onnx_asr_model(
                model_name, cache_dir, providers, "int8", onnx_session_options(providers)
            )
        self._vad_wrapped = None
        _fast_runtime = {
            "engine": "parakeet",
            "model": model_name,
            "device": device,
        }
        if as_primary:
            _runtime = {
                "engine": "parakeet",
                "model": model_name,
                "device": device,
                # Not float16: the GPU path drops quantization altogether and
                # runs the weights as they ship, which is float32.
                "compute_type": "int8" if device == "cpu" else "float32",
                "cpu_threads": cpu_thread_count(),
            }

    def _model_for_clip(self, path):
        if wav_duration_sec(path) <= 20:
            return self.model
        if self._vad_wrapped is not None:
            return self._vad_wrapped
        try:
            import onnx_asr
            self._vad_wrapped = self.model.with_vad(onnx_asr.load_vad("silero"))
        except Exception:
            self._vad_wrapped = self.model
        return self._vad_wrapped

    def transcribe(self, path, prompt=None, vad=None, language="en", quality=None):
        """Recognise one clip. Parakeet has no context input and says so.

        onnx-asr exposes recognize(path); the TDT graph has no biasing entry
        point, so a prompt genuinely cannot be honoured here. What changed is
        that the reply now reports "unsupported" instead of nothing, which is
        what lets src/main.js apply the dictionary to the transcript and tell
        the user it did that rather than leaving the request to evaporate.

        The model is English-only. A non-English request reaching this backend
        is a routing bug upstream, not something to paper over: it is reported
        so it can be seen rather than mistaken for a bad recognition.
        """
        del vad, quality
        code = str(language or "en").strip().lower()
        if code and code != "en":
            raise RuntimeError(
                "Parakeet recognises English only; "
                + str(language)
                + " needs Whisper or Qwen3-ASR."
            )
        result = self._model_for_clip(path).recognize(path)
        return transcription(
            join_parakeet_result(result),
            "parakeet",
            _fast_runtime.get("device", ""),
            vocabulary="unsupported" if prompt else "none",
            language="en",
        )


def _engine_id_of(backend):
    named = getattr(backend, "engine_id", None)
    if named in ENGINE_IDS:
        return named
    if isinstance(backend, QwenBackend):
        return "qwen3-asr"
    if isinstance(backend, ParakeetBackend):
        return "parakeet"
    return "whisper"


# Whether a vocabulary request outranks the speed swap. The app sets this from
# the user's own setting; the default keeps the dictionary, because a term
# somebody typed in by hand is a stronger signal than a heuristic about which
# model is quicker.
def _require_vocabulary(env=None):
    env = env or os.environ
    return str(env.get("VOXDEN_REQUIRE_VOCABULARY") or "1").strip() != "0"


class RouterBackend:
    def __init__(self, primary, fast=None):
        self.primary = primary
        self.fast = fast

    def transcribe(
        self,
        path,
        prompt=None,
        vad=None,
        language="en",
        quality=None,
        term_count=0,
        require_vocabulary=None,
    ):
        """Route the clip, and never lose a capability without saying so.

        The engine is chosen from the term count and the caller's
        require_vocabulary flag -- not from whether an engine-specific prompt
        string is already empty. Building the prompt for Parakeet first produced
        an empty string, which this router used to treat as "no vocabulary", so
        a Qwen dictation with a full dictionary stayed on Parakeet and dropped
        every term.

        Explicit Fast English still takes the fast backend. Auto and Accurate
        keep the primary when it can honour the dictionary and the fast engine
        cannot.
        """
        backend = pick_fast_backend(self.primary, self.fast, quality, language)
        try:
            terms = int(term_count or 0)
        except (TypeError, ValueError):
            terms = 0
        if terms < 0:
            terms = 0
        # A nonempty prompt is still a vocabulary request, for callers that
        # have not started sending term_count. An empty prompt is not evidence
        # that there were no terms -- that is the circular bug above.
        if terms <= 0 and prompt:
            terms = 1
        want_vocab = _require_vocabulary() if require_vocabulary is None else bool(require_vocabulary)
        if backend is not self.primary and terms and want_vocab:
            primary_mech = vocabulary_mechanism(_engine_id_of(self.primary))
            fast_mech = vocabulary_mechanism(_engine_id_of(backend))
            if primary_mech and not fast_mech:
                backend = self.primary
        result = backend.transcribe(path, prompt, vad, language, quality)
        if isinstance(result, dict):
            result["routed"] = "fast" if backend is not self.primary else "primary"
        return result


def compact_error(exc):
    text = re.sub(r"\s+", " ", str(exc or "")).strip()
    return text[:220] if text else exc.__class__.__name__


def release_failed_torch_load():
    qwen_accel.release_gpu_state()


def load_selected_backend():
    global _backend_warning, _backend_fix, _backend_fix_engine
    requested = selected_engine()
    probe = backend_probe(requested)
    if not probe["available"]:
        if requested == "whisper":
            raise RuntimeError(probe["error"])
        _backend_warning = missing_note(probe)
        _backend_fix = install_command(probe["missing"])
        _backend_fix_engine = probe["engine"]
        return WhisperBackend()

    try:
        if requested == "qwen3-asr":
            backend = QwenBackend()
        elif requested == "parakeet":
            backend = ParakeetBackend(as_primary=True)
        else:
            backend = WhisperBackend()
        _backend_warning = gpu_mismatch_note(requested)
        _backend_fix = ""
        _backend_fix_engine = ""
        return backend
    except Exception as exc:
        if requested == "whisper":
            raise
        release_failed_torch_load()
        label = "Parakeet" if requested == "parakeet" else "Qwen3-ASR"
        # It is installed, just broken. No install command would help here.
        _backend_warning = label + " could not load (" + compact_error(exc) + ")."
        _backend_fix = ""
        _backend_fix_engine = ""
        return WhisperBackend()


def load_parakeet_backend():
    """Parakeet as the Fast-dictation accelerator, not as the chosen engine.

    Only reached when the user selected something else, so its absence is not a
    problem to report: Fast dictation falls back to the selected engine and
    nothing is broken. Warning about it put a permanent "run pip install..."
    next to every engine the user actually picked, for a component they never
    asked for and, on the runtime Voxden installs itself, cannot install.
    """
    global _backend_warning, _fast_runtime
    probe = parakeet_probe()
    if not probe["available"]:
        _fast_runtime = {"engine": "", "model": "", "device": ""}
        return None
    try:
        return ParakeetBackend()
    except Exception as exc:
        # Installed and still broken is worth saying; the user went out of their
        # way to put it there. No install command -- it is already installed.
        _backend_warning = join_warning(
            _backend_warning, "Parakeet could not load (" + compact_error(exc) + ")."
        )
        _fast_runtime = {"engine": "", "model": "", "device": ""}
        return None


def assert_fast_parakeet_is_silent():
    """A missing Fast-dictation accelerator must not report anything.

    It used to, which put a permanent "Parakeet is not installed... run pip
    install..." beside whichever engine the user had actually chosen -- for a
    component they never selected and, on the runtime Voxden installs, cannot
    install. Locked here because the symptom appears two layers away, in the
    settings hint, where it is easy to mistake for a UI bug.
    """
    global _backend_warning, _backend_fix, _backend_fix_engine, parakeet_probe
    saved = (_backend_warning, _backend_fix, _backend_fix_engine, parakeet_probe)
    try:
        _backend_warning = ""
        _backend_fix = ""
        _backend_fix_engine = ""
        parakeet_probe = lambda: {
            "available": False,
            "engine": "parakeet",
            "label": "Parakeet",
            "model": "x",
            "missing": ["onnx-asr"],
            "error": "Parakeet is not installed on this PC (missing onnx-asr). Run: x",
        }
        assert load_parakeet_backend() is None
        assert _backend_warning == "", "an unselected accelerator must stay quiet"
        assert _backend_fix == "", "and must not advertise an install command"
        assert _fast_runtime.get("engine") == ""
        # The engine the user did select still reports itself.
        assert backend_probe("parakeet")["error"], "a selected engine still warns"
    finally:
        _backend_warning, _backend_fix, _backend_fix_engine, parakeet_probe = saved


def load_router_backend():
    requested = selected_engine()
    primary = load_selected_backend()
    if isinstance(primary, ParakeetBackend) or requested == "parakeet":
        return RouterBackend(primary, None)
    fast = load_parakeet_backend()
    return RouterBackend(primary, fast)


def parse_request(line):
    out = {
        "path": line,
        "prompt": None,
        "vad": None,
        "language": "en",
        "id": None,
        "quality": None,
        "term_count": 0,
        "require_vocabulary": None,
    }
    if line.startswith("{") and line.endswith("}"):
        try:
            req = json.loads(line)
            out["path"] = req.get("path") or ""
            out["prompt"] = req.get("prompt") or None
            if "vad" in req:
                out["vad"] = bool(req.get("vad"))
            if req.get("language"):
                out["language"] = str(req.get("language"))
            if req.get("id") is not None and str(req.get("id")).strip() != "":
                out["id"] = str(req.get("id"))
            quality = str(req.get("quality") or "").strip().lower()
            if quality in ("fast", "accurate"):
                out["quality"] = quality
            raw_count = req.get("termCount")
            if raw_count is None:
                raw_count = req.get("term_count")
            try:
                out["term_count"] = max(0, int(raw_count or 0))
            except (TypeError, ValueError):
                out["term_count"] = 0
            if "requireVocabulary" in req:
                out["require_vocabulary"] = bool(req.get("requireVocabulary"))
            elif "require_vocabulary" in req:
                out["require_vocabulary"] = bool(req.get("require_vocabulary"))
        except Exception:
            out["path"] = line
            out["prompt"] = None
            out["vad"] = None
            out["language"] = "en"
            out["id"] = None
            out["quality"] = None
            out["term_count"] = 0
            out["require_vocabulary"] = None
    return out


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
        warning_fix = ""
        warning_fix_engine = ""
        if not probe["available"] and requested != "whisper":
            fallback = backend_probe("whisper")
            if not fallback["available"]:
                emit({"ok": False, "error": missing_note(probe) + " " + fallback["error"]})
                return 1
            warning = missing_note(probe)
            warning_fix = install_command(probe["missing"])
            warning_fix_engine = probe["engine"]
            probe = fallback
        elif not probe["available"]:
            emit({"ok": False, "error": probe["error"]})
            return 1
        # Said here as well as at load time, because --check is what paints the
        # settings hint. Waiting for --serve leaves the AMD case reading
        # "active on the CPU" with no reason given for however long a cold
        # model download takes.
        warning = join_warning(warning, gpu_mismatch_note(probe["engine"]))
        # What this PC can actually run, engine by engine. The picker used to
        # offer every engine unconditionally, so Qwen3-ASR -- which needs torch
        # and qwen_asr, and which no Voxden download has ever supplied -- was
        # advertised at "~3.4 GB" to people who had no way to get it. Probing is
        # a find_spec per module, so it is cheap enough to answer for all three.
        engines = {}
        for engine_id in sorted(ENGINE_IDS):
            try:
                engines[engine_id] = bool(backend_probe(engine_id)["available"])
            except Exception:
                engines[engine_id] = False
        emit({
            "ok": True,
            "selected_engine": requested,
            "engine": "faster-whisper" if probe["engine"] == "whisper" else probe["engine"],
            "model": probe["model"],
            # What will run, not what was asked for.
            "device": resolved_device(probe["engine"]),
            "backend": (
                qwen_accel.requested_accel()
                if normalize_engine(probe["engine"]) == "qwen3-asr"
                and os.environ.get("VOXDEN_QWEN_ACCEL_READY") == "1"
                else "cpu"
            ) if normalize_engine(probe["engine"]) == "qwen3-asr" else "",
            "engines": engines,
            "capabilities": ENGINE_CAPABILITIES,
            "warning": warning,
            "warning_fix": warning_fix,
            "warning_fix_engine": warning_fix_engine,
        })
        return 0

    if args[0] == "--probe-qwen-accel":
        try:
            import torch
            from qwen_asr import Qwen3ASRModel
        except Exception as exc:
            emit({
                "ok": False,
                "importOk": False,
                "tensorProbeOk": False,
                "qwenProbeOk": False,
                "error": qwen_accel.compact_error(exc),
            })
            return 1
        props = qwen_accel.gpu_properties(torch)
        build = qwen_accel.torch_build_kind(torch)
        wanted = qwen_accel.requested_accel()
        if wanted == "cpu":
            wanted = "cuda" if build == "cuda" else ("rocm" if build == "rocm" else "cpu")
        compute = qwen_accel.pick_compute(wanted if wanted in ("cuda", "rocm") else "cpu", torch)
        dtype = qwen_accel.dtype_for(compute, torch)
        tensor_ok, tensor_detail = (False, "no GPU")
        if torch.cuda.is_available():
            tensor_ok, tensor_detail = qwen_accel.probe_tensor_device(torch, "cuda:0", dtype)
        qwen_ok = False
        qwen_error = ""
        wav = os.environ.get("VOXDEN_QWEN_PROBE_WAV") or find_self_test_wav()
        if tensor_ok and wav and os.path.isfile(wav):
            try:
                model_name = os.environ.get("VOXDEN_QWEN_ASR_MODEL") or DEFAULT_QWEN_MODEL
                model = Qwen3ASRModel.from_pretrained(
                    model_name,
                    dtype=dtype,
                    device_map="cuda:0",
                    max_inference_batch_size=1,
                    max_new_tokens=64,
                    local_files_only=os.environ.get("VOXDEN_OFFLINE") == "1",
                )
                context = qwen_accel.record_context(os.environ.get("VOXDEN_QWEN_PROBE_CONTEXT") or "Voxden")
                with torch.inference_mode():
                    produced = model.transcribe(
                        audio=wav,
                        context=context,
                        language=language_name("en"),
                    )
                text = str(getattr(produced[0], "text", "") or "").strip() if produced else ""
                qwen_ok = True
                emit({
                    "ok": True,
                    "importOk": True,
                    "tensorProbeOk": True,
                    "qwenProbeOk": True,
                    "backend": wanted,
                    "compute_type": compute,
                    "gpu_name": props.get("gpu_name") or "",
                    "gpu_arch": props.get("gpu_arch") or "",
                    "torch_version": getattr(torch, "__version__", ""),
                    "text": text,
                    "context_sha256": qwen_accel.last_context_sha256(),
                })
                return 0
            except Exception as exc:
                qwen_error = qwen_accel.compact_error(exc)
                qwen_accel.release_gpu_state(torch)
        emit({
            "ok": bool(tensor_ok),
            "importOk": True,
            "tensorProbeOk": bool(tensor_ok),
            "qwenProbeOk": qwen_ok,
            "backend": wanted if tensor_ok else "cpu",
            "compute_type": compute,
            "gpu_name": props.get("gpu_name") or "",
            "gpu_arch": props.get("gpu_arch") or "",
            "torch_version": getattr(torch, "__version__", ""),
            "build": build,
            "error": "" if tensor_ok else str(tensor_detail),
            "qwen_error": qwen_error,
        })
        return 0 if tensor_ok else 1

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
        assert kw["beam_size"] == 3 and kw["best_of"] == 3
        assert kw["multilingual"] is False
        assert kw["vad_filter"] is True
        req = parse_request(
            '{"path":"a.wav","prompt":"Voxden","language":"en","id":"7"}'
        )
        assert req["path"] == "a.wav" and req["prompt"] == "Voxden" and req["language"] == "en"
        assert req["id"] == "7"
        fast = transcribe_kwargs(None, "en", False, "fast")
        assert fast["beam_size"] == 1 and fast["best_of"] == 1
        assert fast["temperature"] == 0.0
        path, prompt, vad, language = req["path"], req["prompt"], req["vad"], req["language"]
        assert path == "a.wav" and prompt == "Voxden" and language == "en"
        gpu = pick_runtime({"VOXDEN_DEVICE": "auto", "VOXDEN_MODEL": "large-v3"}, cuda_count=1, cublas_ok=True)
        assert gpu["device"] == "cuda" and gpu["compute_type"] == "float16"
        cpu = pick_runtime({"VOXDEN_DEVICE": "auto", "VOXDEN_MODEL": "large-v3"}, cuda_count=0, cublas_ok=False)
        assert cpu["device"] == "cpu" and cpu["compute_type"] == "int8"
        missing = pick_runtime({"VOXDEN_DEVICE": "auto", "VOXDEN_MODEL": "large-v3"}, cuda_count=1, cublas_ok=False)
        assert missing["device"] == "cpu"
        forced = pick_runtime({"VOXDEN_DEVICE": "cpu", "VOXDEN_MODEL": "large-v3"}, cuda_count=8, cublas_ok=True)
        assert forced["device"] == "cpu"
        # CTranslate2 has no DirectML, so the AMD selection resolves to the CPU
        # rather than erroring -- and takes the thread count with it, which is
        # the part that makes the CPU landing bearable.
        amd = pick_runtime({"VOXDEN_DEVICE": "directml"}, cuda_count=8, cublas_ok=True)
        assert amd["device"] == "cpu" and amd["compute_type"] == "int8"
        assert amd["cpu_threads"] >= 4
        assert pick_runtime({"VOXDEN_CPU_THREADS": "7"}, cuda_count=0)["cpu_threads"] == 7
        assert cpu_thread_count({"VOXDEN_CPU_THREADS": "9"}) == 9
        assert cpu_thread_count({"VOXDEN_CPU_THREADS": "0"}) >= 4
        assert cpu_thread_count({"VOXDEN_CPU_THREADS": "junk"}) >= 4
        # Never below the four CTranslate2 would have used on its own, never so
        # many that dictating takes the machine with it.
        assert 4 <= cpu_thread_count({}) <= 16
        assert requested_device({"VOXDEN_DEVICE": "DirectML"}) == "directml"
        assert requested_device({"VOXDEN_DEVICE": "rocm"}) == "auto"
        assert requested_device({}) == "auto"
        assert device_label("directml") == "AMD or Intel GPU"
        assert device_label("cuda") == "NVIDIA GPU"
        assert device_label("rocm") == "supported AMD GPU"
        assert device_label("") == "CPU"

        both = ["CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"]
        dml_only = ["DmlExecutionProvider", "CPUExecutionProvider"]
        cpu_only = ["CPUExecutionProvider"]
        # An explicit pick is never quietly served by the other vendor's
        # backend -- it falls to the CPU instead. And auto never reaches for
        # DirectML: nearly every PC offers it, and taking it would put most
        # users on a 2.5 GB download for no measured gain.
        assert onnx_providers("auto", both)[0] == "CUDAExecutionProvider"
        assert onnx_providers("auto", dml_only) == cpu_only
        assert onnx_providers("directml", both)[0] == "DmlExecutionProvider"
        assert onnx_providers("cuda", dml_only) == cpu_only
        assert onnx_providers("directml", cpu_only) == cpu_only
        assert onnx_providers("cpu", both) == cpu_only
        assert provider_device(onnx_providers("directml", dml_only)) == "directml"
        assert provider_device(cpu_only) == "cpu"
        assert parakeet_quantization(dml_only) is None
        assert parakeet_quantization(cpu_only) == "int8"
        amd_env = {"VOXDEN_DEVICE": "directml"}
        assert gpu_mismatch_note("parakeet", amd_env, both) == ""
        assert "only Parakeet does" in gpu_mismatch_note("whisper", amd_env, both)
        assert "only Parakeet does" in gpu_mismatch_note("qwen3-asr", amd_env, both)
        # A speech engine with no DirectML in it is a reinstall, not a re-pick:
        # switching engines cannot conjure a provider that is not there.
        assert "Reinstall" in gpu_mismatch_note("parakeet", amd_env, cpu_only)
        assert gpu_mismatch_note("whisper", {"VOXDEN_DEVICE": "auto"}, cpu_only) == ""
        # A device that cannot carry the engine must never be reported as the
        # one carrying it. Asking Whisper for DirectML resolves to the CPU, so
        # the hint cannot claim otherwise two sentences after saying DirectML
        # is unavailable.
        assert resolved_device("whisper", {"VOXDEN_DEVICE": "directml"}) == "cpu"
        assert resolved_device("qwen3-asr", {"VOXDEN_DEVICE": "directml"}) == "cpu"
        assert resolved_device("qwen3-asr", {"VOXDEN_DEVICE": "cpu"}) == "cpu"
        assert resolved_device("whisper", {"VOXDEN_DEVICE": "cpu"}) == "cpu"
        assert resolved_device("parakeet", {"VOXDEN_DEVICE": "cpu"}) == "cpu"
        # And it is never the literal request string, which is what leaked out.
        assert resolved_device("whisper", {"VOXDEN_DEVICE": "auto"}) in ("cpu", "cuda")
        assert resolved_device("parakeet", {"VOXDEN_DEVICE": "directml"}) in ("cpu", "directml")
        if module_available("onnxruntime"):
            import onnxruntime as ort
            dml_opts = onnx_session_options(dml_only)
            assert dml_opts is not None and dml_opts.enable_mem_pattern is False
            assert dml_opts.execution_mode == ort.ExecutionMode.ORT_SEQUENTIAL
            cpu_opts = onnx_session_options(cpu_only, {"VOXDEN_CPU_THREADS": "6"})
            assert cpu_opts is not None and cpu_opts.intra_op_num_threads == 6
        assert_fast_parakeet_is_silent()
        assert install_command(["onnx-asr"]) == "pip install onnx-asr[hub]"
        # Never told to install onnxruntime when it is already importable --
        # onnxruntime-gpu shares the module name, and adding the CPU build
        # beside it is the one combination the docs rule out.
        assert "onnxruntime" not in install_command(["onnx-asr"]).split()
        assert install_command(["onnx-asr", "onnxruntime"]) == "pip install onnx-asr[hub] onnxruntime"
        assert install_command(["faster-whisper"]) == "pip install faster-whisper"
        assert install_command(["torch", "qwen_asr"]) == REQUIREMENTS_HINT
        assert normalize_engine("QWEN3-ASR") == "qwen3-asr"
        assert normalize_engine("parakeet") == "parakeet"
        assert normalize_engine("PARAKEET") == "parakeet"
        assert normalize_engine("voxtral") == "whisper"
        assert normalize_engine("bad") == "whisper"
        assert language_name("en") == "English"
        assert selected_engine({"VOXDEN_ASR_ENGINE": "parakeet"}) == "parakeet"
        assert backend_probe("parakeet")["engine"] == "parakeet"
        assert pick_fast_backend("primary", "parakeet", "fast") == "parakeet"
        assert pick_fast_backend("primary", "parakeet", "accurate") == "primary"
        assert pick_fast_backend("primary", None, "fast") == "primary"
        # English-only means English-only. Parakeet returns fluent nonsense for
        # other languages rather than failing, so nothing downstream would
        # notice the mistake.
        assert pick_fast_backend("primary", "parakeet", "fast", "hi") == "primary"
        assert pick_fast_backend("primary", "parakeet", "fast", "de") == "primary"
        assert pick_fast_backend("primary", "parakeet", "fast", "EN") == "parakeet"
        assert pick_fast_backend("primary", "parakeet", "fast", None) == "parakeet"

        class _Named:
            def __init__(self, name):
                self.name = name
                self.engine_id = name if name in ENGINE_IDS else "whisper"

            def transcribe(self, path, prompt=None, vad=None, language="en", quality=None):
                del path, prompt, vad, language, quality
                return transcription(self.name, self.name, "cpu")

        def routed_name(backend, **kw):
            return backend.transcribe("a.wav", **kw)["text"]

        routed = RouterBackend(_Named("primary"), _Named("parakeet"))
        assert routed_name(routed, quality="fast") == "parakeet"
        assert routed_name(routed, quality="accurate") == "primary"
        assert routed_name(RouterBackend(_Named("primary"), None), quality="fast") == "primary"
        solo = RouterBackend(_Named("parakeet"), None)
        assert routed_name(solo, quality="fast") == "parakeet"
        assert routed_name(solo, quality="accurate") == "parakeet"

        # A vocabulary request must not be handed to a backend that cannot take
        # one. _Named reports its own name as its engine id, so the router sees
        # a Whisper primary and a Parakeet fast path here.
        biased = RouterBackend(_Named("whisper"), _Named("parakeet"))
        assert biased.transcribe("a.wav", "Voxden", quality="fast")["text"] == "whisper"
        assert biased.transcribe("a.wav", None, quality="fast")["text"] == "parakeet"
        # Term count is what decides this, not an already-empty prompt.
        assert biased.transcribe(
            "a.wav", None, quality="fast", term_count=12, require_vocabulary=True
        )["text"] == "whisper"
        assert biased.transcribe(
            "a.wav", None, quality="fast", term_count=12, require_vocabulary=False
        )["text"] == "parakeet"
        qwen_named = RouterBackend(_Named("qwen3-asr"), _Named("parakeet"))
        assert qwen_named.transcribe(
            "a.wav", None, quality="fast", term_count=97, require_vocabulary=True
        )["text"] == "qwen3-asr"
        assert qwen_named.transcribe(
            "a.wav", None, quality="fast", language="hi", term_count=0
        )["text"] == "qwen3-asr"

        # Qwen3-ASR's vocabulary is the context= keyword. The shipping install
        # used to open transcribe() with `del prompt` and never pass context.
        import inspect as _inspect
        qwen_src = _inspect.getsource(QwenBackend.transcribe)
        assert "context=context" in qwen_src.replace(" ", "")
        assert not re.search(r"^\s*del prompt\b", qwen_src, re.M)
        assert "qwen_accel.record_context" in qwen_src
        cpu_ctx = qwen_accel.normalize_context("  Voxden, नमस्ते, Café ")
        cuda_ctx = qwen_accel.normalize_context("  Voxden, नमस्ते, Café ")
        rocm_ctx = qwen_accel.normalize_context("  Voxden, नमस्ते, Café ")
        assert cpu_ctx == cuda_ctx == rocm_ctx == "Voxden, नमस्ते, Café"
        assert qwen_accel.record_context(cpu_ctx) == cpu_ctx
        assert qwen_accel.pick_compute("cpu") == "float32"
        assert qwen_accel.pick_compute("rocm") == "float16"
        assert qwen_accel.pick_compute("cuda") == "float16"
        assert qwen_accel.is_oom_error(RuntimeError("CUDA out of memory"))
        assert qwen_accel.is_oom_error(RuntimeError("HIP out of memory"))
        assert not qwen_accel.is_oom_error(RuntimeError("zoom room"))
        assert qwen_accel.is_accel_error(RuntimeError("CUDA error: device-side assert"))
        assert not qwen_accel.is_accel_error(RuntimeError("chipset mismatch"))
        qwen_accel.reset_session_guard()
        qwen_accel.mark_session_gpu_failed("cuda", "simulated OOM")
        assert qwen_accel.session_gpu_failed() == "cuda"
        blocked = qwen_accel.choose_backend({"VOXDEN_QWEN_ACCEL": "cuda"}, None)
        assert blocked["backend"] == "cpu"
        qwen_accel.reset_session_guard()
        forced = qwen_accel.choose_backend({"VOXDEN_QWEN_FORCE_CPU": "1", "VOXDEN_QWEN_ACCEL": "cuda"})
        assert forced["backend"] == "cpu"
        assert resolved_device("qwen3-asr", {"VOXDEN_DEVICE": "cuda", "VOXDEN_QWEN_ACCEL": "cuda"}) == "cpu"
        assert resolved_device(
            "qwen3-asr",
            {"VOXDEN_DEVICE": "cuda", "VOXDEN_QWEN_ACCEL": "cuda", "VOXDEN_QWEN_ACCEL_READY": "1"},
        ) == "cuda"
        assert resolved_device(
            "qwen3-asr",
            {"VOXDEN_DEVICE": "directml", "VOXDEN_QWEN_ACCEL": "rocm", "VOXDEN_QWEN_ACCEL_READY": "1"},
        ) == "rocm"

        # The capability table is the contract; nothing may quietly drop out of it.
        assert vocabulary_mechanism("whisper") == "initial_prompt"
        assert vocabulary_mechanism("qwen3-asr") == "context"
        assert vocabulary_mechanism("parakeet") is None
        assert set(ENGINE_CAPABILITIES) == set(ENGINE_IDS)
        record = transcription(" hi ", "whisper", "cuda", vocabulary="initial_prompt")
        assert record["text"] == "hi" and record["vocabulary"] == "initial_prompt"
        assert join_parakeet_result("hello") == "hello"
        assert join_parakeet_result(["one", "two"]) == "one two"
        assert parse_request('{"path":"a.wav","quality":"fast"}')["quality"] == "fast"
        assert parse_request('{"path":"a.wav","quality":"accurate"}')["quality"] == "accurate"
        counted = parse_request('{"path":"a.wav","quality":"fast","termCount":97,"requireVocabulary":true}')
        assert counted["term_count"] == 97 and counted["require_vocabulary"] is True
        wav = find_self_test_wav()
        if (
            module_available("onnx_asr")
            and module_available("onnxruntime")
            and parakeet_weights_present()
        ):
            loaded = ParakeetBackend()
            assert _fast_runtime.get("engine") == "parakeet"
            if wav:
                produced = loaded.transcribe(wav, quality="fast")
                assert str(produced["text"] or "").strip(), "Parakeet returned empty transcript"
                assert produced["engine"] == "parakeet"
                # Asking Parakeet for a language it does not have must be an
                # error, not a wrong-language transcript nobody can explain.
                try:
                    loaded.transcribe(wav, language="hi")
                    raise AssertionError("Parakeet accepted a non-English request")
                except RuntimeError:
                    pass
        emit({"ok": True, "self_test": True})
        return 0

    try:
        backend = load_router_backend()
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1

    if args[0] == "--serve":
        serve_device = _runtime["device"]
        if _runtime.get("backend") == "rocm":
            serve_device = "rocm"
        emit({
            "ok": True,
            "ready": True,
            "engine": _runtime["engine"],
            "model": _runtime["model"],
            "device": serve_device,
            "backend": _runtime.get("backend") or ("cpu" if serve_device == "cpu" else ""),
            "compute_type": _runtime["compute_type"],
            "gpu_name": _runtime.get("gpu_name") or "",
            "gpu_arch": _runtime.get("gpu_arch") or "",
            "torch_version": _runtime.get("torch_version") or "",
            "pack_id": _runtime.get("pack_id") or "",
            "pack_version": _runtime.get("pack_version") or "",
            "probe_passed": bool(_runtime.get("probe_passed")),
            "init_passed": bool(_runtime.get("init_passed")),
            "fallback_reason": _runtime.get("fallback_reason") or "",
            "selected_engine": selected_engine(),
            "fast_engine": _fast_runtime.get("engine") or "",
            "fast_model": _fast_runtime.get("model") or "",
            "fast_device": _fast_runtime.get("device") or "",
            # The contract, shipped with the handshake. src/main.js must never
            # have to guess whether the engine it just started can take a
            # vocabulary -- guessing is what produced a year of silently
            # discarded dictionaries.
            "capabilities": ENGINE_CAPABILITIES,
            "vocabulary": vocabulary_mechanism(_runtime.get("engine") or "whisper") or "unsupported",
            "fast_vocabulary": (
                vocabulary_mechanism(_fast_runtime.get("engine")) or "unsupported"
            ) if _fast_runtime.get("engine") else "",
            "warning": _backend_warning,
            "warning_fix": _backend_fix,
            "warning_fix_engine": _backend_fix_engine,
        })
        for line in sys.stdin:
            raw = line.strip()
            if not raw:
                continue
            if raw == "QUIT":
                break
            req = parse_request(raw)
            result = {}
            try:
                recognition_started = time.perf_counter()
                produced = backend.transcribe(
                    req["path"],
                    req["prompt"],
                    req["vad"],
                    req["language"],
                    req.get("quality"),
                    req.get("term_count") or 0,
                    req.get("require_vocabulary"),
                )
                # Backends return the full record now. A bare string is still
                # accepted so a third-party or older backend keeps working --
                # it just cannot report which engine ran or whether the
                # vocabulary was honoured.
                if isinstance(produced, dict):
                    result = dict(produced)
                    result["ok"] = True
                    # Qwen reports model-only inference time itself. Give
                    # Whisper, Parakeet, and older third-party backends the
                    # same field by timing the backend call at this boundary.
                    if not float(result.get("recognition_sec") or 0):
                        result["recognition_sec"] = round(
                            time.perf_counter() - recognition_started, 4
                        )
                else:
                    result = {
                        "ok": True,
                        "text": str(produced or ""),
                        "recognition_sec": round(
                            time.perf_counter() - recognition_started, 4
                        ),
                    }
            except Exception as exc:
                sys.stderr.write(compact_error(exc) + "\n")
                sys.stderr.flush()
                message = qwen_accel.friendly_user_error(exc) if qwen_accel.is_accel_error(exc) else compact_error(exc)
                result = {
                    "ok": False,
                    "error": message,
                    "backend": _runtime.get("backend") or "",
                    "fallback_reason": _runtime.get("fallback_reason") or message,
                }
            if req.get("id") is not None:
                result["id"] = req["id"]
            emit(result)
        return 0

    try:
        produced = backend.transcribe(args[0])
        if isinstance(produced, dict):
            emit(dict(produced, ok=True))
        else:
            emit({"ok": True, "text": str(produced or "")})
        return 0
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
