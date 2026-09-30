"""Constrain Qwen's pinned Transformers loader to local, built-in model code.

Qwen 0.0.6 requires Transformers 4.57.6. These entry-point checks mitigate
untrusted attention configuration and shard paths without overriding that
dependency contract. They are not a patch to the installed libraries.
"""
import json
import re
from pathlib import Path, PureWindowsPath


def _model_file(path, directory):
    root = Path(directory).resolve()
    candidate = Path(path)
    if not candidate.is_file():
        return False
    resolved = candidate.resolve()
    if resolved.is_relative_to(root):
        return True
    # The Hub's own snapshots use links into a sibling blobs directory. Allow
    # precisely that layout, not arbitrary links from developer model folders.
    blobs = root.parent.parent / "blobs"
    return (root.parent.name == "snapshots" and root.parent.parent.name.startswith("models--")
            and not blobs.is_symlink() and not getattr(blobs, "is_junction", lambda: False)()
            and resolved.parent == blobs and re.fullmatch(r"[a-fA-F0-9]{40,64}", resolved.name) is not None)


def _public_config(value):
    if isinstance(value, dict):
        # Serialized sub_configs can override Transformers' class metadata and
        # defeat its recursive attention setter. Internal fields are never
        # authority for executable attention kernels, even on nested configs.
        return {key: _public_config(item) for key, item in value.items()
                if not key.startswith("_") and key not in {"sub_configs", "attribute_map", "trust_remote_code"}}
    if isinstance(value, list):
        return [_public_config(item) for item in value]
    return value


def validate_shards(index, directory=None):
    weights = index.get("weight_map")
    if not isinstance(weights, dict) or not weights:
        raise ValueError("Qwen checkpoint has no valid weight_map")
    for name in weights.values():
        if (not isinstance(name, str) or not name or "\\" in name
                or ":" in name or "\x00" in name or name.startswith("/")
                or PureWindowsPath(name).is_absolute() or ".." in name.split("/")
                or not name.endswith(".safetensors")):
            raise ValueError("Unsafe Qwen checkpoint shard path")
        # stat follows normal Hub-cache symlinks to blobs, but rejects FIFOs,
        # devices and directories before any tensor loader can open them.
        if directory is not None and not _model_file(Path(directory) / name, directory):
            raise ValueError("Qwen checkpoint shard is missing or not a regular file")


def load_options(model_name, offline):
    from qwen_asr.core.transformers_backend import Qwen3ASRConfig
    from transformers.utils.hub import cached_file

    data, _ = Qwen3ASRConfig.get_config_dict(model_name, local_files_only=offline)
    if data.get("model_type") != "qwen3_asr":
        raise ValueError("The Qwen engine requires a Qwen3-ASR model")
    # Avoid model-type dispatch from untrusted config (including LightGlue),
    # and override attention on every nested config before model construction.
    config = Qwen3ASRConfig.from_dict(_public_config(data))
    config._attn_implementation = "sdpa"
    if data.get("transformers_weights"):
        raise ValueError("Custom Qwen checkpoint filenames are not supported")
    index_path = cached_file(model_name, "model.safetensors.index.json",
                             local_files_only=offline,
                             _raise_exceptions_for_missing_entries=False)
    if index_path:
        if not _model_file(index_path, Path(index_path).parent):
            raise ValueError("Qwen checkpoint index is not a regular file")
        with open(index_path, encoding="utf-8") as stream:
            index = json.load(stream)
        validate_shards(index)
        if not Path(model_name).is_dir():
            # Fetch only names validated above, then check actual cache files
            # before the tensor loader. Hub cache links are supported below.
            for name in set(index["weight_map"].values()):
                cached_file(model_name, name, local_files_only=offline,
                            revision=data.get("_commit_hash"))
        validate_shards(index, Path(index_path).parent)
    else:
        weights = cached_file(model_name, "model.safetensors", local_files_only=offline,
                              _raise_exceptions_for_missing_entries=False)
        if weights and not _model_file(weights, Path(weights).parent):
            raise ValueError("Qwen checkpoint is not a regular model file")
    return {"config": config, "attn_implementation": "sdpa",
            "trust_remote_code": False, "use_safetensors": True}


def load_model(wrapper, model_name, *, offline, dtype, device_map, max_new_tokens):
    from qwen_asr.core.transformers_backend import Qwen3ASRForConditionalGeneration, Qwen3ASRProcessor

    options = load_options(model_name, offline)
    model = Qwen3ASRForConditionalGeneration.from_pretrained(
        model_name, dtype=dtype, device_map=device_map, local_files_only=offline, **options)
    # Upstream's generic factory drops local_files_only/trust_remote_code on
    # its separate AutoProcessor load. Fixed Qwen classes avoid that dispatch.
    processor = Qwen3ASRProcessor.from_pretrained(
        model_name, local_files_only=offline, trust_remote_code=False, fix_mistral_regex=True)
    return wrapper(backend="transformers", model=model, processor=processor,
                   max_inference_batch_size=1, max_new_tokens=max_new_tokens)
