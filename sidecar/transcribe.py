#!/usr/bin/env python3
"""Local ASR sidecar with Whisper, Qwen3-ASR, and Parakeet Fast-chat backends."""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
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
DEFAULT_PARAKEET_MODEL = "nemo-parakeet-tdt-0.6b-v2"
ENGINE_IDS = frozenset({"whisper", "qwen3-asr", "parakeet"})
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


def transcribe_file(model, path, initial_prompt=None, vad_filter=None, language="en", quality=None):
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
    kwargs = transcribe_kwargs(initial_prompt, language, False, quality)
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
    def __init__(self):
        self.model = load_model()

    def transcribe(self, path, prompt=None, vad=None, language="en", quality=None):
        return transcribe_file(self.model, path, prompt, vad, language, quality)


class QwenBackend:
    def __init__(self):
        import torch
        from qwen_asr import Qwen3ASRModel

        global _runtime
        runtime = pick_torch_runtime()
        model_name = os.environ.get("VOXDEN_QWEN_ASR_MODEL") or DEFAULT_QWEN_MODEL
        max_tokens = max(64, int(os.environ.get("VOXDEN_ASR_MAX_TOKENS") or 512))
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

    def transcribe(self, path, prompt=None, vad=None, language="en", quality=None):
        del prompt, vad, quality
        with self.torch.inference_mode():
            results = self.model.transcribe(audio=path, language=language_name(language))
        if not results:
            return ""
        return str(getattr(results[0], "text", "") or "").strip()


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


def parakeet_cache_dir():
    root = os.environ.get("VOXDEN_MODEL_DIR")
    if root:
        return os.path.join(root, "parakeet-tdt-0.6b-v2")
    return None


def parakeet_quantization(providers):
    return None if "CUDAExecutionProvider" in providers else "int8"


def parakeet_onnx_filename(stem, quantization=None):
    suffix = "?" + quantization if quantization else ""
    name = stem + suffix + ".onnx"
    if os.name == "nt":
        name = name.replace("?", ".")
    return name


def parakeet_required_files(quantization=None):
    return (
        parakeet_onnx_filename("encoder-model", quantization),
        parakeet_onnx_filename("decoder_joint-model", quantization),
        "vocab.txt",
        "config.json",
    )


def parakeet_cache_ready(cache_dir, quantization=None):
    if not cache_dir or not os.path.isdir(cache_dir):
        return False
    return all(os.path.isfile(os.path.join(cache_dir, name)) for name in parakeet_required_files(quantization))


def prepare_parakeet_cache_dir(providers):
    """Return VOXDEN_MODEL_DIR cache path; drop stale empty dirs that block Hub download."""
    cache_dir = parakeet_cache_dir()
    if not cache_dir:
        return None
    quantization = parakeet_quantization(providers)
    if os.path.isdir(cache_dir) and not parakeet_cache_ready(cache_dir, quantization):
        shutil.rmtree(cache_dir, ignore_errors=True)
    return cache_dir


def parakeet_weights_present():
    cache_dir = parakeet_cache_dir()
    if cache_dir and (
        parakeet_cache_ready(cache_dir, None) or parakeet_cache_ready(cache_dir, "int8")
    ):
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


def load_onnx_asr_model(model_name, cache_dir, providers, quantization):
    import onnx_asr

    kwargs = {"providers": providers}
    if quantization:
        kwargs["quantization"] = quantization
    try:
        if cache_dir:
            return onnx_asr.load_model(model_name, cache_dir, **kwargs)
        return onnx_asr.load_model(model_name, **kwargs)
    except TypeError:
        kwargs.pop("quantization", None)
        try:
            if cache_dir:
                return onnx_asr.load_model(model_name, cache_dir, **kwargs)
            return onnx_asr.load_model(model_name, **kwargs)
        except TypeError:
            if cache_dir:
                return onnx_asr.load_model(model_name, cache_dir)
            return onnx_asr.load_model(model_name)


def onnx_providers(want_cuda):
    providers = []
    try:
        import onnxruntime as ort
        available = list(ort.get_available_providers() or [])
    except Exception:
        available = []
    if want_cuda and "CUDAExecutionProvider" in available:
        providers.append("CUDAExecutionProvider")
    providers.append("CPUExecutionProvider")
    return providers


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


def pick_fast_backend(primary, fast, quality):
    if str(quality or "").strip().lower() == "fast" and fast is not None:
        return fast
    return primary


class ParakeetBackend:
    def __init__(self, as_primary=False):
        global _fast_runtime, _runtime
        probe = parakeet_probe()
        if not probe["available"]:
            raise RuntimeError(probe["error"])
        model_name = probe["model"]
        requested = str(os.environ.get("VOXDEN_DEVICE") or "auto").strip().lower()
        want_cuda = requested != "cpu"
        providers = onnx_providers(want_cuda)
        cache_dir = prepare_parakeet_cache_dir(providers)
        quantization = parakeet_quantization(providers)
        sys.stderr.write("Loading Parakeet " + model_name + ".\n")
        sys.stderr.flush()
        try:
            self.model = load_onnx_asr_model(model_name, cache_dir, providers, quantization)
            device = "cuda" if "CUDAExecutionProvider" in providers else "cpu"
        except Exception:
            if not want_cuda or "CUDAExecutionProvider" not in providers:
                raise
            sys.stderr.write("Parakeet CUDA load failed; retrying on CPU.\n")
            sys.stderr.flush()
            providers = ["CPUExecutionProvider"]
            cache_dir = prepare_parakeet_cache_dir(providers)
            self.model = load_onnx_asr_model(model_name, cache_dir, providers, "int8")
            device = "cpu"
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
                "compute_type": "int8" if device == "cpu" else "float16",
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
        del prompt, vad, language, quality
        result = self._model_for_clip(path).recognize(path)
        return join_parakeet_result(result)


class RouterBackend:
    def __init__(self, primary, fast=None):
        self.primary = primary
        self.fast = fast

    def transcribe(self, path, prompt=None, vad=None, language="en", quality=None):
        backend = pick_fast_backend(self.primary, self.fast, quality)
        return backend.transcribe(path, prompt, vad, language, quality)


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
        _backend_warning = ""
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
        except Exception:
            out["path"] = line
            out["prompt"] = None
            out["vad"] = None
            out["language"] = "en"
            out["id"] = None
            out["quality"] = None
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
        emit({
            "ok": True,
            "selected_engine": requested,
            "engine": "faster-whisper" if probe["engine"] == "whisper" else probe["engine"],
            "model": probe["model"],
            "device": str(os.environ.get("VOXDEN_DEVICE") or "auto"),
            "warning": warning,
            "warning_fix": warning_fix,
            "warning_fix_engine": warning_fix_engine,
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

        class _Named:
            def __init__(self, name):
                self.name = name

            def transcribe(self, path, prompt=None, vad=None, language="en", quality=None):
                del path, prompt, vad, language, quality
                return self.name

        routed = RouterBackend(_Named("primary"), _Named("parakeet"))
        assert routed.transcribe("a.wav", quality="fast") == "parakeet"
        assert routed.transcribe("a.wav", quality="accurate") == "primary"
        assert RouterBackend(_Named("primary"), None).transcribe("a.wav", quality="fast") == "primary"
        solo = RouterBackend(_Named("parakeet"), None)
        assert solo.transcribe("a.wav", quality="fast") == "parakeet"
        assert solo.transcribe("a.wav", quality="accurate") == "parakeet"
        assert join_parakeet_result("hello") == "hello"
        assert join_parakeet_result(["one", "two"]) == "one two"
        assert parse_request('{"path":"a.wav","quality":"fast"}')["quality"] == "fast"
        assert parse_request('{"path":"a.wav","quality":"accurate"}')["quality"] == "accurate"
        wav = find_self_test_wav()
        if (
            module_available("onnx_asr")
            and module_available("onnxruntime")
            and parakeet_weights_present()
        ):
            loaded = ParakeetBackend()
            assert _fast_runtime.get("engine") == "parakeet"
            if wav:
                text = loaded.transcribe(wav, quality="fast")
                assert str(text or "").strip(), "Parakeet returned empty transcript"
        emit({"ok": True, "self_test": True})
        return 0

    try:
        backend = load_router_backend()
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
            "fast_engine": _fast_runtime.get("engine") or "",
            "fast_model": _fast_runtime.get("model") or "",
            "fast_device": _fast_runtime.get("device") or "",
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
                text = backend.transcribe(
                    req["path"],
                    req["prompt"],
                    req["vad"],
                    req["language"],
                    req.get("quality"),
                )
                result = {"ok": True, "text": text}
            except Exception as exc:
                result = {"ok": False, "error": str(exc)}
            if req.get("id") is not None:
                result["id"] = req["id"]
            emit(result)
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
