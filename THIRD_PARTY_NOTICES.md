# Third-party notices

## 7-Zip archive extractor

Voxden includes 7-Zip 26.03, copyright (c) 1999–2026 Igor Pavlov, as a separate
extractor: the unmodified upstream Windows x64 `7za.exe`, or on macOS an Apple
silicon (ARM64 only) `7zz` that Voxden compiles from the unmodified upstream
source with a macOS 14.0 deployment target and installs as `7za`.
`scripts/prepare-pack-tools.js` verifies the pinned archive SHA-256 before it
extracts or compiles anything. Its license, the GNU LGPL 2.1 text and the Mac
build recipe (`7zip-BUILD.txt`) are installed in `resources/pack-tools/licenses/`.

Corresponding upstream source: https://github.com/ip7z/7zip/tree/26.03
Mac source archive (the one built): https://github.com/ip7z/7zip/releases/download/26.03/7z2603-src.tar.xz
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
