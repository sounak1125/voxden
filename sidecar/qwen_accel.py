"""Qwen3-ASR accelerator selection, probes, and CPU fallback.

The JavaScript resolver in src/qwen-accel.js decides which pack, if any, is
allowed. This module is the sidecar half: it trusts a real torch import and a
real tensor op, never the UI processor setting. A GPU failure must return to
CPU Qwen with the same audio, language, and dictionary context.
"""
from __future__ import annotations

import gc
import hashlib
import os
import re
import sys
import time


BACKENDS = ("cpu", "cuda", "rocm")
COMPUTE_CPU = "float32"
COMPUTE_FP16 = "float16"
COMPUTE_BF16 = "bfloat16"

_session_gpu_failed = ""
_session_gpu_reason = ""
_last_context = ""
_last_context_sha256 = ""
_last_timings = {}


def reset_session_guard():
    global _session_gpu_failed, _session_gpu_reason
    _session_gpu_failed = ""
    _session_gpu_reason = ""


def session_gpu_failed():
    return _session_gpu_failed


def session_gpu_reason():
    return _session_gpu_reason


def mark_session_gpu_failed(backend, reason):
    global _session_gpu_failed, _session_gpu_reason
    kind = str(backend or "").strip().lower()
    if kind in ("cuda", "rocm"):
        _session_gpu_failed = kind
        _session_gpu_reason = compact_error(reason)


def last_context():
    return _last_context


def last_context_sha256():
    return _last_context_sha256


def last_timings():
    return dict(_last_timings)


def compact_error(exc):
    text = re.sub(r"\s+", " ", str(exc or "")).strip()
    return text[:220] if text else (exc.__class__.__name__ if exc is not None else "")


def normalize_context(prompt):
    """The exact string Qwen receives as context=, identical on every backend."""
    return str(prompt or "").strip()


def record_context(prompt):
    global _last_context, _last_context_sha256
    text = normalize_context(prompt)
    _last_context = text
    _last_context_sha256 = hashlib.sha256(text.encode("utf-8")).hexdigest() if text else ""
    return text


def requested_accel(env=None):
    env = env or os.environ
    value = str(env.get("VOXDEN_QWEN_ACCEL") or "cpu").strip().lower()
    return value if value in BACKENDS else "cpu"


def force_cpu(env=None):
    env = env or os.environ
    if str(env.get("VOXDEN_QWEN_FORCE_CPU") or "").strip() == "1":
        return True
    if str(env.get("VOXDEN_TORCH_DEVICE") or "").strip().lower() == "cpu":
        if str(env.get("VOXDEN_QWEN_ACCEL_READY") or "").strip() != "1":
            return True
    requested = str(env.get("VOXDEN_DEVICE") or "auto").strip().lower()
    return requested == "cpu"


def torch_build_kind(torch_mod=None):
    """cpu, cuda, or rocm, from the imported torch, not from the UI."""
    try:
        torch = torch_mod
        if torch is None:
            import torch
    except Exception:
        return "cpu"
    hip = getattr(getattr(torch, "version", None), "hip", None)
    if hip:
        return "rocm"
    cuda = getattr(getattr(torch, "version", None), "cuda", None)
    if cuda:
        return "cuda"
    return "cpu"


def is_oom_error(exc):
    text = str(exc or "").lower()
    needles = (
        "out of memory",
        "cuda oom",
        "hipoom",
        "hip out of memory",
        "cudaerror_outofmemory",
        "cudnn_status_alloc_failed",
        "not enough memory",
        "insufficient memory",
    )
    return any(n in text for n in needles)


def is_accel_error(exc):
    if is_oom_error(exc):
        return True
    text = str(exc or "").lower()
    needles = (
        "cuda",
        "cublas",
        "cudnn",
        "device-side assert",
        "invalid device",
        "no kernel image",
        "not compiled with cuda",
        "miopen",
        "hipblas",
        "hiperror",
        "hip error",
        "rocm",
    )
    if any(n in text for n in needles):
        return True
    return bool(re.search(r"\bhip\b", text))


def enable_stable_sdpa(torch_mod):
    """Prefer PyTorch SDPA. FlashAttention is optional and must not be required."""
    backends = getattr(getattr(torch_mod, "backends", None), "cuda", None)
    if backends is None:
        return "none"
    enabled = []
    for name, prefer in (
        ("enable_flash_sdp", False),
        ("enable_mem_efficient_sdp", True),
        ("enable_math_sdp", True),
    ):
        fn = getattr(backends, name, None)
        if not callable(fn):
            continue
        try:
            fn(prefer)
            if prefer:
                enabled.append(name.replace("enable_", "").replace("_sdp", ""))
        except Exception:
            pass
    return ",".join(enabled) or "default"


def probe_tensor_device(torch_mod, device, dtype=None):
    """Allocate and execute a tiny matmul. Importing torch is not enough."""
    if dtype is None:
        dtype = torch_mod.float16 if str(device).startswith(("cuda", "hip")) else torch_mod.float32
    try:
        a = torch_mod.randn((32, 32), device=device, dtype=dtype)
        b = torch_mod.randn((32, 32), device=device, dtype=dtype)
        c = torch_mod.matmul(a, b)
        torch_mod.synchronize(device) if hasattr(torch_mod, "synchronize") else None
        if hasattr(c, "cpu"):
            value = float(c.detach().cpu().reshape(-1)[0])
        else:
            value = 0.0
        del a, b, c
        return True, value
    except Exception as exc:
        return False, compact_error(exc)


def gpu_properties(torch_mod):
    info = {
        "gpu_name": "",
        "gpu_arch": "",
        "total_memory_mb": 0,
        "device_count": 0,
        "bf16": False,
        "torch_version": getattr(torch_mod, "__version__", ""),
        "cuda_version": getattr(getattr(torch_mod, "version", None), "cuda", None) or "",
        "hip_version": getattr(getattr(torch_mod, "version", None), "hip", None) or "",
    }
    try:
        if not torch_mod.cuda.is_available():
            return info
        info["device_count"] = int(torch_mod.cuda.device_count() or 0)
        if info["device_count"] < 1:
            return info
        props = torch_mod.cuda.get_device_properties(0)
        info["gpu_name"] = str(getattr(props, "name", "") or torch_mod.cuda.get_device_name(0))
        major = int(getattr(props, "major", 0) or 0)
        minor = int(getattr(props, "minor", 0) or 0)
        info["gpu_arch"] = "sm_%d%d" % (major, minor) if major else ""
        total = int(getattr(props, "total_memory", 0) or 0)
        info["total_memory_mb"] = total // (1024 * 1024)
        info["bf16"] = bool(getattr(torch_mod.cuda, "is_bf16_supported", lambda: False)())
    except Exception:
        pass
    return info


def pick_compute(backend, torch_mod=None, env=None):
    env = env or os.environ
    override = str(env.get("VOXDEN_QWEN_COMPUTE") or "").strip().lower()
    if override in (COMPUTE_CPU, COMPUTE_FP16, COMPUTE_BF16):
        return override
    if backend == "cpu":
        return COMPUTE_CPU
    if backend == "rocm":
        return COMPUTE_FP16
    if torch_mod is not None:
        try:
            if getattr(torch_mod.cuda, "is_bf16_supported", lambda: False)():
                return COMPUTE_BF16
        except Exception:
            pass
    return COMPUTE_FP16


def dtype_for(compute, torch_mod):
    if compute == COMPUTE_BF16:
        return torch_mod.bfloat16
    if compute == COMPUTE_FP16:
        return torch_mod.float16
    return torch_mod.float32


def release_gpu_state(torch_mod=None):
    try:
        gc.collect()
        torch = torch_mod
        if torch is None:
            import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
    except Exception:
        pass


def choose_backend(env=None, torch_mod=None):
    """Decide cpu/cuda/rocm from env + actual torch, then probe.

    Returns a dict. backend is what will be used, never what the UI asked for
    if the probe failed.
    """
    env = env or os.environ
    wanted = requested_accel(env)
    result = {
        "backend": "cpu",
        "device": "cpu",
        "device_map": "cpu",
        "compute_type": COMPUTE_CPU,
        "dtype_name": COMPUTE_CPU,
        "probe_passed": False,
        "init_passed": False,
        "fallback_reason": "",
        "gpu_name": "",
        "gpu_arch": "",
        "torch_version": "",
        "pack_id": str(env.get("VOXDEN_QWEN_PACK_ID") or ""),
        "pack_version": str(env.get("VOXDEN_QWEN_PACK_VERSION") or ""),
        "sdpa": "",
        "build": "cpu",
    }
    if force_cpu(env):
        result["fallback_reason"] = "CPU Qwen was selected or forced."
        return result
    # Packaged installs always set VOXDEN_QWEN_ACCEL. An unset value is the
    # developer interpreter: use CUDA/ROCm if this torch build actually has it.
    if wanted == "cpu" and not str(env.get("VOXDEN_QWEN_ACCEL") or "").strip():
        wanted = "auto"
    if wanted == "cpu":
        result["fallback_reason"] = ""
        return result
    failed = session_gpu_failed()
    if failed:
        result["fallback_reason"] = session_gpu_reason() or (failed + " failed earlier in this session.")
        return result

    try:
        torch = torch_mod
        if torch is None:
            import torch
    except Exception as exc:
        result["fallback_reason"] = "PyTorch could not be imported (" + compact_error(exc) + ")."
        return result

    result["torch_version"] = getattr(torch, "__version__", "")
    result["build"] = torch_build_kind(torch)
    props = gpu_properties(torch)
    result["gpu_name"] = props["gpu_name"]
    result["gpu_arch"] = props["gpu_arch"]

    have_gpu = bool(torch.cuda.is_available()) and int(props["device_count"] or 0) > 0
    if not have_gpu:
        result["fallback_reason"] = "PyTorch did not detect a GPU in this accelerator pack."
        return result

    build = result["build"]
    requested = str(env.get("VOXDEN_DEVICE") or "auto").strip().lower()
    if wanted == "auto":
        if requested == "directml":
            result["fallback_reason"] = "DirectML is not a Qwen backend."
            return result
        if build == "rocm":
            wanted = "rocm"
        elif build == "cuda":
            wanted = "cuda"
        else:
            result["fallback_reason"] = "This PyTorch build has no GPU runtime."
            return result
    if wanted == "cuda" and build != "cuda":
        result["fallback_reason"] = "The accelerator pack is not a CUDA PyTorch build."
        return result
    if wanted == "rocm" and build != "rocm":
        result["fallback_reason"] = "The accelerator pack is not a ROCm PyTorch build."
        return result

    backend = wanted if wanted in ("cuda", "rocm") else ("rocm" if build == "rocm" else "cuda")
    compute = pick_compute(backend, torch, env)
    dtype = dtype_for(compute, torch)
    ok, detail = probe_tensor_device(torch, "cuda:0", dtype)
    if not ok:
        mark_session_gpu_failed(backend, detail)
        release_gpu_state(torch)
        result["fallback_reason"] = "GPU tensor probe failed (" + str(detail) + ")."
        return result

    result["backend"] = backend
    result["device"] = "cuda"
    result["device_map"] = "cuda:0"
    result["compute_type"] = compute
    result["dtype_name"] = compute
    result["probe_passed"] = True
    result["sdpa"] = enable_stable_sdpa(torch)
    result["torch"] = torch
    result["dtype"] = dtype
    return result


def record_timings(kind, seconds, audio_sec=0.0):
    global _last_timings
    entry = dict(_last_timings)
    entry[kind] = round(float(seconds or 0.0), 4)
    if audio_sec:
        entry["audio_sec"] = round(float(audio_sec), 4)
        rec = float(entry.get("recognition_sec") or seconds or 0.0)
        entry["rtf"] = round(rec / float(audio_sec), 4) if audio_sec > 0 else 0.0
    _last_timings = entry
    return entry


def friendly_user_error(exc):
    """Short UI text. Full details stay in logs."""
    if is_oom_error(exc):
        return "The GPU ran out of memory. Dictation will continue as CPU Qwen."
    text = compact_error(exc)
    if not text:
        return "The GPU accelerator could not finish. Dictation will continue as CPU Qwen."
    if is_accel_error(exc):
        return "The GPU accelerator failed. Dictation will continue as CPU Qwen."
    return "Speech recognition failed."
