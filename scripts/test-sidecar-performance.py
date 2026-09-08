"""Resource-budget regressions without importing an engine or reading weights."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("voxden_performance", ROOT / "sidecar" / "transcribe.py")
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)


class SessionOptions:
    def __init__(self):
        self.intra_op_num_threads = 0
        self.enable_mem_pattern = True
        self.execution_mode = "sequential"
        self.entries = {}

    def add_session_config_entry(self, name, value):
        self.entries[name] = value


ORT = types.SimpleNamespace(
    SessionOptions=SessionOptions,
    ExecutionMode=types.SimpleNamespace(ORT_SEQUENTIAL="sequential"),
)


class SidecarPerformanceTests(unittest.TestCase):
    def test_default_worker_budget_respects_small_machines(self):
        for logical, expected in [(1, 1), (2, 1), (3, 1), (4, 2), (6, 3),
                                  (8, 4), (12, 6), (16, 8), (24, 12), (32, 16), (64, 16)]:
            with self.subTest(logical=logical), patch.object(sidecar.os, "cpu_count", return_value=logical):
                self.assertEqual(sidecar.cpu_thread_count({"VOXDEN_CPU_THREADS": ""}), expected)

    def test_explicit_thread_overrides_are_preserved(self):
        with patch.object(sidecar.os, "cpu_count", return_value=2):
            for value in (1, 4, 37):
                self.assertEqual(sidecar.cpu_thread_count({"VOXDEN_CPU_THREADS": str(value)}), value)
            for invalid in ("0", "-1", "invalid"):
                self.assertEqual(sidecar.cpu_thread_count({"VOXDEN_CPU_THREADS": invalid}), 1)

    def test_every_onnx_provider_uses_bounded_sleeping_cpu_workers(self):
        for providers in [["CPUExecutionProvider"], ["CUDAExecutionProvider", "CPUExecutionProvider"],
                          ["DmlExecutionProvider", "CPUExecutionProvider"]]:
            with self.subTest(providers=providers), patch.dict(sys.modules, {"onnxruntime": ORT}):
                original = providers[:]
                options = sidecar.onnx_session_options(providers, {"VOXDEN_CPU_THREADS": "6"})
                self.assertEqual(options.intra_op_num_threads, 6)
                self.assertEqual(options.entries, {
                    "session.intra_op.allow_spinning": "0",
                    "session.inter_op.allow_spinning": "0",
                })
                self.assertEqual(providers, original, "resource tuning cannot change device selection")
                if "DmlExecutionProvider" in providers:
                    self.assertFalse(options.enable_mem_pattern)
                    self.assertEqual(options.execution_mode, ORT.ExecutionMode.ORT_SEQUENTIAL)

    def test_onnx_unavailable_keeps_existing_fallback(self):
        with patch.dict(sys.modules, {"onnxruntime": None}):
            self.assertIsNone(sidecar.onnx_session_options(["CPUExecutionProvider"]))

    def backend(self):
        wrapped = object()
        backend = object.__new__(sidecar.ParakeetBackend)
        backend.model = types.SimpleNamespace(with_vad=lambda vad: wrapped)
        backend._vad_wrapped = None
        return backend, wrapped

    def test_long_clip_vad_receives_budget_and_is_loaded_once(self):
        calls = []
        module = types.SimpleNamespace(load_vad=lambda *args, **kwargs: calls.append((args, kwargs)) or object())
        backend, wrapped = self.backend()
        with patch.dict(sys.modules, {"onnxruntime": ORT, "onnx_asr": module}), \
                patch.object(sidecar, "wav_duration_sec", return_value=21), \
                patch.object(sidecar, "available_providers", return_value=["DmlExecutionProvider", "CPUExecutionProvider"]), \
                patch.object(sidecar, "cpu_thread_count", return_value=2):
            self.assertIs(backend._model_for_clip("synthetic.wav"), wrapped)
            self.assertIs(backend._model_for_clip("synthetic.wav"), wrapped)
        self.assertEqual(len(calls), 1)
        args, kwargs = calls[0]
        self.assertEqual(args, ("silero",))
        self.assertEqual(set(kwargs), {"sess_options"}, "VAD provider selection stays with its runtime")
        options = kwargs["sess_options"]
        self.assertEqual(options.intra_op_num_threads, 2)
        self.assertEqual(options.entries["session.intra_op.allow_spinning"], "0")
        self.assertFalse(options.enable_mem_pattern)
        with patch.object(sidecar, "wav_duration_sec", return_value=20):
            self.assertIs(backend._model_for_clip("synthetic.wav"), backend.model)

    def test_legacy_vad_loader_keeps_its_supported_signature(self):
        calls = []

        def legacy_load(name):
            calls.append(name)
            return object()

        backend, wrapped = self.backend()
        with patch.dict(sys.modules, {"onnxruntime": ORT, "onnx_asr": types.SimpleNamespace(load_vad=legacy_load)}), \
                patch.object(sidecar, "wav_duration_sec", return_value=21), \
                patch.object(sidecar, "available_providers", return_value=["CPUExecutionProvider"]):
            self.assertIs(backend._model_for_clip("synthetic.wav"), wrapped)
        self.assertEqual(calls, ["silero"])

    def test_vad_model_failure_is_not_retried_as_an_old_signature(self):
        calls = []

        def broken_load(*args, **kwargs):
            calls.append((args, kwargs))
            raise TypeError("Invalid model metadata")

        backend, _wrapped = self.backend()
        with patch.dict(sys.modules, {"onnxruntime": ORT, "onnx_asr": types.SimpleNamespace(load_vad=broken_load)}), \
                patch.object(sidecar, "wav_duration_sec", return_value=21), \
                patch.object(sidecar, "available_providers", return_value=["CPUExecutionProvider"]):
            self.assertIs(backend._model_for_clip("synthetic.wav"), backend.model)
            self.assertIs(backend._model_for_clip("synthetic.wav"), backend.model)
        self.assertEqual(len(calls), 1, "a broken VAD preserves recognition without repeated loading")

    def test_no_engine_or_model_was_loaded(self):
        self.assertFalse(any(name in sys.modules for name in ("torch", "onnxruntime", "onnx_asr", "numpy", "faster_whisper")))


if __name__ == "__main__":
    unittest.main()
