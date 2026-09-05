"""Offline installation check; independent of user recordings and system Python."""
import base64
import json
import os
import re


def local_model_available(directory):
    if not directory or not os.path.isdir(directory):
        return False
    if not os.path.isfile(os.path.join(directory, "config.json")):
        return False
    index = os.path.join(directory, "model.safetensors.index.json")
    if os.path.isfile(index):
        with open(index, encoding="utf-8") as handle:
            shards = set(json.load(handle)["weight_map"].values())
        return bool(shards) and all(os.path.isfile(os.path.join(directory, name)) for name in shards)
    return os.path.isfile(os.path.join(directory, "model.safetensors"))


def probe_input(override=None):
    if override:
        if not os.path.isfile(override):
            raise ValueError("The requested Qwen test recording is missing.")
        return override, None
    import numpy as np
    fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qwen-probe-audio.json")
    with open(fixture, encoding="utf-8") as handle:
        data = json.load(handle)
    if data.get("schemaVersion") != 1 or data.get("encoding") != "pcm_s16le":
        raise ValueError("The bundled Qwen speech check is invalid.")
    pcm = base64.b64decode(data["pcmBase64"], validate=True)
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    return (samples, int(data["sampleRate"])), data["text"]


def verify_text(text, expected=None):
    words = re.findall(r"[a-z]+", str(text or "").lower())
    if not words:
        raise RuntimeError("Qwen returned no speech in the GPU transcription check.")
    if expected:
        wanted = set(re.findall(r"[a-z]+", expected.lower()))
        # Permit punctuation/minor acoustic differences, but not a nonempty
        # hallucination or a broken decoder repeating an unrelated phrase.
        if len(set(words) & wanted) / max(1, len(wanted)) < 0.75:
            raise RuntimeError("Qwen could not recognize the bundled GPU test sentence.")
    return str(text).strip()


def run_probe(model, torch_module, override=None, context=""):
    audio, expected = probe_input(override)
    with torch_module.inference_mode():
        results = model.transcribe(audio=audio, context=context, language="English")
    text = str(getattr(results[0], "text", "") or "") if results else ""
    return verify_text(text, expected)
