"""Measure ORT idle worker cost with its bundled six-number multiplication toy.

No speech model, downloads, microphone, or persistent settings are used. This
measures CPU spent after inference, not transcription speed or accuracy.
"""
import gc
import importlib.util
import json
import os
from pathlib import Path
import time

import numpy as np
import onnxruntime as ort

try:
    import psutil
    process = psutil.Process()
    if os.name == "nt":
        process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
except ImportError:
    process = None

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("voxden_benchmark", ROOT / "sidecar" / "transcribe.py")
sidecar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sidecar)
model = Path(ort.__file__).parent / "datasets" / "mul_1.onnx"
if not model.is_file():
    raise SystemExit("This runtime does not include the ORT multiplication toy; no model was downloaded.")

results = []
reference = None
for policy in ("runtime-default", "four-workers-spinning", "four-workers-passive", "production-spinning", "production-passive"):
    if policy == "production-passive":
        options = sidecar.onnx_session_options(["CPUExecutionProvider"], {"VOXDEN_CPU_THREADS": ""})
    elif policy == "four-workers-passive":
        options = sidecar.onnx_session_options(["CPUExecutionProvider"], {"VOXDEN_CPU_THREADS": "4"})
    else:
        options = ort.SessionOptions()
        if policy == "four-workers-spinning":
            options.intra_op_num_threads = 4
        elif policy == "production-spinning":
            options.intra_op_num_threads = sidecar.cpu_thread_count({"VOXDEN_CPU_THREADS": ""})
    baseline = process.num_threads() if process else None
    started = time.perf_counter()
    session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
    extra_threads = process.num_threads() - baseline if process else None
    output = session.run(None, {"X": np.ones((3, 2), np.float32)})[0]
    if reference is None:
        reference = output
    np.testing.assert_array_equal(output, reference)
    build_ms = (time.perf_counter() - started) * 1000
    cpu_started = time.process_time()
    time.sleep(0.3)
    results.append({
        "policy": policy,
        "intra_op_threads": options.intra_op_num_threads,
        "extra_threads": extra_threads,
        "build_ms": round(build_ms, 2),
        "post_inference_300ms_cpu_ms": round((time.process_time() - cpu_started) * 1000, 2),
        "identical_output": True,
    })
    del session
    gc.collect()
    time.sleep(0.1)

print(json.dumps({"onnxruntime": ort.__version__, "logical_processors": os.cpu_count(), "toy_only": True, "results": results}))
