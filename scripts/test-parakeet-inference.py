"""Launch the actual sidecar with Python network access forbidden for this test.

The Node harness downloads and verifies the public catalog first. No recognizer,
model, audio, device, or platform APIs are mocked here.
"""
import importlib.metadata
import json
import platform
import runpy
import sys
from pathlib import Path


def deny_network(event, _args):
    if event in {"socket.connect", "socket.getaddrinfo", "socket.sendto"}:
        raise RuntimeError("Parakeet inference test forbids network access after model setup")


if __name__ == "__main__":
    if sys.argv[1:] == ["--runtime-info"]:
        distributions = {}
        for name in ("onnx-asr", "onnxruntime", "onnxruntime-directml", "numpy"):
            try:
                distributions[name] = importlib.metadata.version(name)
            except importlib.metadata.PackageNotFoundError:
                pass
        print(json.dumps({"platform": sys.platform, "machine": platform.machine(),
                          "osVersion": platform.mac_ver()[0] if sys.platform == "darwin" else platform.version(),
                          "kernelRelease": platform.release(),
                          "python": platform.python_version(), "packages": distributions}))
    elif sys.argv[1:] == ["--serve"]:
        sys.addaudithook(deny_network)
        sidecar = Path(__file__).resolve().parents[1] / "sidecar" / "transcribe.py"
        sys.path.insert(0, str(sidecar.parent))
        sys.argv = [str(sidecar), "--serve"]
        runpy.run_path(str(sidecar), run_name="__main__")
    else:
        raise SystemExit("Use --runtime-info or --serve through test-parakeet-inference.js")
