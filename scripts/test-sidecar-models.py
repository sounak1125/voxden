"""Managed-model regressions using catalog filenames and an empty Hub cache."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("voxden_models", ROOT / "sidecar" / "transcribe.py")
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)
CATALOG = json.loads((ROOT / "src" / "speech-model-catalog.json").read_text(encoding="utf-8"))


class ManagedModelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="voxden-model-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {
            "VOXDEN_ASR_ENGINE": "parakeet", "VOXDEN_DEVICE": "cpu",
            "VOXDEN_OFFLINE": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
            "HF_HOME": str(self.root / "empty-hub"),
            "VOXDEN_MODEL_DIR": str(self.root / "models"),
            "VOXDEN_MODEL": "large-v3",
        }

    def install_fixture(self, pack_id="parakeet"):
        directory = self.root / pack_id
        directory.mkdir()
        pack = next(pack for pack in CATALOG["packs"] if pack["id"] == pack_id)
        for file in pack["files"]:
            (directory / file["path"]).write_bytes(b"fixture")
        self.env["VOXDEN_PARAKEET_INT8_DIR" if pack_id == "parakeet"
                 else "VOXDEN_PARAKEET_FP32_DIR"] = str(directory)
        return str(directory)

    def test_catalog_pack_loads_offline_on_mac_and_windows_without_whisper(self):
        directory = self.install_fixture()
        for platform, os_name in [("darwin", "posix"), ("win32", "nt")]:
            with self.subTest(platform=platform):
                model = object()
                loader = Mock(return_value=model)
                # No Whisper model was installed on this fresh Parakeet setup.
                fallback = Mock(side_effect=RuntimeError(
                    "Cannot find an appropriate cached snapshot folder and outgoing traffic has been disabled"
                ))
                with patch.dict(sidecar.os.environ, self.env, clear=True), \
                        patch.object(sidecar.os, "name", os_name), \
                        patch.object(sidecar.sys, "platform", platform), \
                        patch.object(sidecar, "module_available", return_value=True), \
                        patch.object(sidecar, "available_providers", return_value=["CPUExecutionProvider"]), \
                        patch.object(sidecar, "onnx_session_options", return_value=None), \
                        patch.object(sidecar, "WhisperBackend", fallback), \
                        patch.object(sidecar, "release_failed_torch_load"), \
                        patch.dict(sys.modules, {"onnx_asr": types.SimpleNamespace(load_model=loader)}):
                    self.assertTrue(sidecar.parakeet_cache_ready(directory, "int8"))
                    backend = sidecar.load_selected_backend()
                    self.assertIs(backend.model, model)
                    self.assertEqual(backend.engine_id, "parakeet")
                    self.assertEqual(sidecar._runtime["device"], "cpu")
                    self.assertTrue(sidecar.parakeet_weights_present())
                loader.assert_called_once_with(
                    sidecar.DEFAULT_PARAKEET_MODEL, directory,
                    providers=["CPUExecutionProvider"], quantization="int8",
                )
                fallback.assert_not_called()

    def test_missing_model_file_is_still_rejected_without_removing_weights(self):
        directory = self.install_fixture()
        (Path(directory) / "vocab.txt").unlink()
        with patch.dict(sidecar.os.environ, self.env, clear=True):
            self.assertFalse(sidecar.parakeet_cache_ready(directory, "int8"))
            with self.assertRaisesRegex(RuntimeError, "Parakeet setup is incomplete"):
                sidecar.prepare_parakeet_cache_dir(["CPUExecutionProvider"])
        self.assertTrue((Path(directory) / "encoder-model.int8.onnx").is_file())

    def test_float32_pack_requires_external_encoder_weights(self):
        directory = self.install_fixture("parakeet-fp32")
        self.assertTrue(sidecar.parakeet_cache_ready(directory))
        (Path(directory) / "encoder-model.onnx.data").unlink()
        self.assertFalse(sidecar.parakeet_cache_ready(directory))

    def test_unavailable_whisper_fallback_preserves_the_parakeet_failure(self):
        with patch.dict(sidecar.os.environ, self.env, clear=True), \
                patch.object(sidecar, "backend_probe", return_value={"available": True}), \
                patch.object(sidecar, "ParakeetBackend", side_effect=RuntimeError("encoder is damaged")), \
                patch.object(sidecar, "release_failed_torch_load"), \
                patch.object(sidecar, "WhisperBackend", side_effect=RuntimeError("missing Hub snapshot")):
            with self.assertRaisesRegex(RuntimeError, "Parakeet could not load.*encoder is damaged.*Settings") as raised:
                sidecar.load_selected_backend()
            self.assertEqual(str(raised.exception.__cause__), "missing Hub snapshot")

    def test_installed_whisper_remains_a_working_fallback(self):
        fallback = object()
        with patch.dict(sidecar.os.environ, self.env, clear=True), \
                patch.object(sidecar, "backend_probe", return_value={"available": True}), \
                patch.object(sidecar, "ParakeetBackend", side_effect=RuntimeError("encoder is damaged")), \
                patch.object(sidecar, "release_failed_torch_load"), \
                patch.object(sidecar, "WhisperBackend", return_value=fallback):
            self.assertIs(sidecar.load_selected_backend(), fallback)
            self.assertIn("encoder is damaged", sidecar._backend_warning)


if __name__ == "__main__":
    unittest.main()
