# Third-party notices

## 7-Zip archive extractor

Voxden includes upstream 7-Zip 26.03: Windows x64 `7za.exe` or the macOS
universal `7zz` binary (installed as `7za`). Copyright (c) 1999–2026 Igor Pavlov.
`scripts/prepare-pack-tools.js` verifies the pinned archive SHA-256. Its license
and GNU LGPL 2.1 text are installed in `resources/pack-tools/licenses/`.

Corresponding upstream source: https://github.com/ip7z/7zip/tree/26.03
Source archive: https://github.com/ip7z/7zip/releases/download/26.03/7z2603-src.7z
The extractor is a separate executable and can be replaced with a compatible build.

## Qwen3-ASR

Copyright Alibaba Cloud. Qwen3-ASR model materials and the `qwen-asr` runtime are provided under their upstream Apache License 2.0 terms. Verify and preserve the exact model-card and package notices when distributing model files or a bundled Python runtime.

Source: https://github.com/QwenLM/Qwen3-ASR

## NVIDIA Parakeet

Copyright NVIDIA Corporation. Parakeet TDT 0.6B v3 model materials are licensed under CC-BY-4.0 according to the upstream model card. Voxden uses Ilya Stupakov's ONNX conversion. Verify and preserve the exact model-card notices when distributing model files.

Source: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3

ONNX conversion: https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx

## onnx-asr

Copyright Ilya Stupakov and onnx-asr contributors. Licensed under the MIT License.

Source: https://github.com/istupakov/onnx-asr

Voxden does not claim ownership of these third-party components. This notice is informational and does not replace the complete license files distributed with the corresponding components.
