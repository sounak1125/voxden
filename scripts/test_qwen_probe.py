"""Offline speech verification and GPU-to-CPU startup fallback regression tests."""
import contextlib
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "sidecar"))
import qwen_probe
import transcribe


class SpeechProbeTests(unittest.TestCase):
    def test_bundled_audio_is_real_mono_speech_input(self):
        (samples, rate), text = qwen_probe.probe_input()
        self.assertEqual(rate, 16000)
        self.assertGreater(len(samples), rate)
        self.assertGreater(float(abs(samples).max()), 0.01)
        self.assertLessEqual(float(abs(samples).max()), 1.0)
        self.assertIn("quick brown fox", text)

    def test_failed_decoder_is_not_a_success(self):
        for text in ["", "   ", "123", "unrelated unrelated unrelated"]:
            with self.assertRaises(RuntimeError):
                qwen_probe.verify_text(text, "The quick brown fox jumps over the lazy dog.")
        self.assertTrue(qwen_probe.verify_text("The quick brown fox jumps over a lazy dog!",
                                              "The quick brown fox jumps over the lazy dog."))

    def test_transcription_uses_the_fixture_with_inference_mode(self):
        model = types.SimpleNamespace(transcribe=lambda **kwargs: [types.SimpleNamespace(
            text="The quick brown fox jumps over the lazy dog.")])
        torch = types.SimpleNamespace(inference_mode=contextlib.nullcontext)
        self.assertIn("quick brown fox", qwen_probe.run_probe(model, torch))
        model.transcribe = lambda **kwargs: []
        with self.assertRaises(RuntimeError):
            qwen_probe.run_probe(model, torch)

    def test_model_presence_requires_every_shard(self):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            self.assertFalse(qwen_probe.local_model_available(folder))
            (root / "config.json").write_text("{}")
            (root / "model.safetensors.index.json").write_text(json.dumps(
                {"weight_map": {"a": "part1.safetensors", "b": "part2.safetensors"}}))
            (root / "part1.safetensors").write_bytes(b"1")
            self.assertFalse(qwen_probe.local_model_available(folder))
            (root / "part2.safetensors").write_bytes(b"2")
            self.assertTrue(qwen_probe.local_model_available(folder))

    def test_gpu_speech_failure_loads_cpu_qwen(self):
        loaded = []
        fake_torch = types.SimpleNamespace()
        fake_qwen = types.SimpleNamespace(Qwen3ASRModel=object())
        def pick(env=None):
            return {"backend": "cpu" if env else "cuda"}
        def load(_self, runtime):
            loaded.append(runtime["backend"])
            return object()
        with patch.dict(sys.modules, {"torch": fake_torch, "qwen_asr": fake_qwen}), \
                patch.object(transcribe, "cap_torch_threads"), \
                patch.object(transcribe, "pick_torch_runtime", side_effect=pick), \
                patch.object(transcribe.QwenBackend, "_load", load), \
                patch.object(transcribe, "_qwen_runtime_record", return_value={}), \
                patch.object(transcribe.qwen_accel, "mark_session_gpu_failed") as failed, \
                patch.object(transcribe.qwen_accel, "release_gpu_state"), \
                patch.object(qwen_probe, "run_probe", side_effect=RuntimeError("speech failed")):
            backend = transcribe.QwenBackend()
            self.assertEqual(loaded, ["cuda", "cpu"])
            self.assertEqual(backend.runtime["backend"], "cpu")
            self.assertTrue(backend.runtime["init_passed"])
            failed.assert_called_once()


if __name__ == "__main__":
    unittest.main()
