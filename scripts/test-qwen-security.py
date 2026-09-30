"""Offline regressions against real Qwen/Transformers configuration APIs."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sidecar"))
import qwen_security


class QwenSecurityTests(unittest.TestCase):
    def test_shards_reject_escape_and_pickle_before_loading(self):
        for name in ["../outside.safetensors", "/tmp/outside.safetensors",
                     "C:/outside.safetensors", "C:outside.safetensors",
                     "sub/../../outside.safetensors", "sub\\outside.safetensors",
                     "weights.bin", None, "", "file\x00.safetensors"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                qwen_security.validate_shards({"weight_map": {"a": name}})

    def test_shards_require_regular_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            name = "part.safetensors"
            with self.assertRaises(ValueError):
                qwen_security.validate_shards({"weight_map": {"a": name}}, root)
            (root / name).mkdir()
            with self.assertRaises(ValueError):
                qwen_security.validate_shards({"weight_map": {"a": name}}, root)
            (root / name).rmdir()
            if hasattr(os, "mkfifo"):
                os.mkfifo(root / name)
                with self.assertRaises(ValueError):
                    qwen_security.validate_shards({"weight_map": {"a": name}}, root)
                (root / name).unlink()
            (root / "shards").mkdir()
            (root / "shards" / name).write_bytes(b"fixture")
            qwen_security.validate_shards({"weight_map": {"a": "shards/" + name}}, root)

    def test_config_cannot_select_remote_attention_or_other_model_types(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "config.json"
            payload = {"model_type": "qwen3_asr", "_attn_implementation_internal": "attacker/kernel", "sub_configs": {},
                       "attribute_map": {"_attn_implementation_internal": "attacker_field"},
                       "thinker_config": {"_attn_implementation_internal": "attacker/kernel", "sub_configs": {},
                         "text_config": {"_attn_implementation_internal": "attacker/kernel"},
                         "audio_config": {"_attn_implementation_internal": "attacker/kernel"}}}
            config.write_text(json.dumps(payload), encoding="utf-8")
            with patch("huggingface_hub.hf_hub_download", side_effect=AssertionError("network forbidden")):
                options = qwen_security.load_options(folder, True)
            actual = options["config"]
            for item in [actual, actual.thinker_config, actual.thinker_config.text_config,
                         actual.thinker_config.audio_config]:
                self.assertEqual(item._attn_implementation, "sdpa")
            self.assertFalse(options["trust_remote_code"])
            self.assertTrue(options["use_safetensors"])
            payload["model_type"] = "lightglue"
            config.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "requires a Qwen3-ASR"):
                qwen_security.load_options(folder, True)

    def test_only_same_repo_hub_blob_symlinks_are_allowed(self):
        with tempfile.TemporaryDirectory() as folder:
            repo = Path(folder) / "models--fixture--qwen"
            snapshot = repo / "snapshots" / ("a" * 40)
            blobs = repo / "blobs"
            snapshot.mkdir(parents=True)
            blobs.mkdir()
            blob = blobs / ("b" * 64)
            blob.write_bytes(b"fixture")
            shard = snapshot / "part.safetensors"
            try:
                shard.symlink_to(blob)
            except OSError:
                self.skipTest("OS does not grant symlink creation to this test account")
            self.assertTrue(qwen_security._model_file(shard, snapshot))
            shard.unlink()
            outside = Path(folder) / "outside.safetensors"
            outside.write_bytes(b"outside")
            shard.symlink_to(outside)
            self.assertFalse(qwen_security._model_file(shard, snapshot))
            plain = Path(folder) / "local-model"
            plain.mkdir()
            (plain / "part.safetensors").symlink_to(blob)
            self.assertFalse(qwen_security._model_file(plain / "part.safetensors", plain))

    def test_malicious_index_rejected_at_real_loader_boundary(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "config.json").write_text('{"model_type":"qwen3_asr"}')
            (root / "model.safetensors.index.json").write_text(json.dumps(
                {"weight_map": {"weight": "../outside.safetensors"}}))
            with self.assertRaisesRegex(ValueError, "Unsafe Qwen"):
                qwen_security.load_options(folder, True)

    def test_real_qwen_weights_reload_and_decode_with_patched_torch(self):
        import torch
        from qwen_asr.core.transformers_backend import Qwen3ASRConfig, Qwen3ASRForConditionalGeneration
        torch.set_num_threads(2)
        config = Qwen3ASRConfig(thinker_config={
            "audio_config": {"d_model": 16, "encoder_layers": 1, "encoder_attention_heads": 2,
                             "encoder_ffn_dim": 32, "output_dim": 16, "num_mel_bins": 16},
            "text_config": {"vocab_size": 32, "hidden_size": 16, "intermediate_size": 32,
                            "num_hidden_layers": 1, "num_attention_heads": 2,
                            "num_key_value_heads": 2, "head_dim": 8,
                            "rope_scaling": {"rope_type": "default", "mrope_section": [2, 1, 1]}},
            "audio_token_id": 29, "audio_start_token_id": 30, "user_token_id": 31})
        config._attn_implementation = "sdpa"
        with tempfile.TemporaryDirectory() as folder:
            Qwen3ASRForConditionalGeneration(config).save_pretrained(folder, safe_serialization=True)
            options = qwen_security.load_options(folder, True)
            with patch("accelerate.load_checkpoint_and_dispatch", side_effect=AssertionError("unsafe loader")), \
                    patch("accelerate.utils.modeling.load_checkpoint_in_model", side_effect=AssertionError("unsafe loader")):
                model = Qwen3ASRForConditionalGeneration.from_pretrained(
                    folder, local_files_only=True, dtype=torch.float32, device_map="cpu", **options)
                tokens = model.generate(input_ids=torch.tensor([[1, 2]]), max_new_tokens=2,
                                        eos_token_id=3, pad_token_id=0, do_sample=False).sequences
            self.assertGreater(tokens.shape[-1], 2)
            self.assertTrue(torch.isfinite(tokens).all())


if __name__ == "__main__":
    unittest.main()
