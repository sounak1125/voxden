# macOS support-floor audit — 2026-09-30

Dependency audit while commit `63197a5` CI was running. The support promise has not been changed; the decision below remains pending.

## Material finding

The documented **macOS 12+ on Apple silicon** promise does not match the currently resolved speech runtime. Its **ONNX Runtime 1.30.0 requires macOS 14+**, and the newly pinned **PyTorch 2.13.0 also requires macOS 14+** in the official CPython 3.12 ARM wheels. Current PyAV native wheels independently have the same floor. Passing CI on a newer native ARM Mac does not establish compatibility with macOS 12 or 13.

The narrow verified regression from the security upgrade is the Torch wheel requirement changing from 11 to 14. The complete application gap cannot be attributed entirely to this PR: the v2.1.6 build already resolved ONNX Runtime and PyAV transitively without version or deployment-target constraints.

## Evidence by component

| Component | Evidence | Declared minimum |
| --- | --- | --- |
| Electron 43.7.6 | Versioned upstream README states Monterey and newer; 43.7.5 says the same | macOS 12 |
| Swift native helper | Repository `scripts/build-mac-helper.js` invokes `swiftc -target arm64-apple-macos12.0` | macOS 12 |
| CPython 3.12.14, python-build-standalone 20260929 | CI log selects this exact release; upstream aarch64 Darwin target has `-mmacosx-version-min=11.0` in compiler and linker flags | macOS 11 |
| Torch 2.11.0, prior pin | `torch-2.11.0-cp312-cp312-macosx_11_0_arm64.whl` | macOS 11 |
| Torch 2.13.0, new pin | Only official CP312 Mac wheel: `torch-2.13.0-cp312-cp312-macosx_14_0_arm64.whl` | macOS 14 |
| ONNX Runtime 1.30.0, actual Mac inference artifact | `onnxruntime-1.30.0-cp312-cp312-macosx_14_0_arm64.whl` | macOS 14 |
| CTranslate2 4.8.2, current resolver candidate | `ctranslate2-4.8.2-cp312-cp312-macosx_11_0_arm64.whl` | macOS 11 |
| Tokenizers 0.22.2, compatible with pinned Transformers 4.57.6 | `tokenizers-0.22.2-cp39-abi3-macosx_11_0_arm64.whl` | macOS 11 |
| Tokenizers 0.23.2, latest queried | `tokenizers-0.23.2-cp310-abi3-macosx_11_0_arm64.whl` | macOS 11 |
| PyAV 19.0.0, current resolver candidate | `av-19.0.0-cp312-abi3-macosx_14_0_arm64.whl` | macOS 14 |
| NumPy 2.5.3, actual Mac inference artifact | Both `numpy-2.5.3-cp312-cp312-macosx_11_0_arm64.whl` and `numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl` exist | Depends on selected wheel |

Sources:

- [Electron 43.7.6 platform support](https://github.com/electron/electron/blob/v43.7.6/README.md#platform-support); [43.7.5 comparison](https://github.com/electron/electron/blob/v43.7.5/README.md#platform-support).
- [Pinned python-build-standalone target configuration](https://github.com/astral-sh/python-build-standalone/blob/20260929/cpython-unix/targets.yml#L64-L103).
- [Torch 2.13.0 official package metadata](https://pypi.org/pypi/torch/2.13.0/json); [Torch 2.11.0](https://pypi.org/pypi/torch/2.11.0/json).
- [ONNX Runtime 1.30.0 official package metadata](https://pypi.org/pypi/onnxruntime/1.30.0/json).
- [CTranslate2 4.8.2](https://pypi.org/pypi/ctranslate2/4.8.2/json).
- [Tokenizers 0.22.2](https://pypi.org/pypi/tokenizers/0.22.2/json); [Tokenizers 0.23.2](https://pypi.org/pypi/tokenizers/0.23.2/json).
- [PyAV 19.0.0](https://pypi.org/pypi/av/19.0.0/json); [NumPy 2.5.3](https://pypi.org/pypi/numpy/2.5.3/json).

The actual Mac inference report is `task/mac-readiness-ci/parakeet.json`: Darwin ARM64, Python 3.12.14, ONNX ASR 0.12.0, ONNX Runtime 1.30.0, NumPy 2.5.3. It does not record the selected NumPy wheel tag or CTranslate2/PyAV distribution versions, so those selections must not be described as verified installed versions solely from this report. `task/mac-ci-failed.log` records the exact Python build and Torch 2.13.0 installation command. Wheel tags and upstream build configuration establish declared compatibility; this audit did not inspect every Mach-O load command or execute on the oldest supported OS.

## Prior release and application paths

Repository `README.md` lines 16 and 70, `site/download.html` lines 82 and 276, and `site/index.html` line 454 advertise macOS 12+. The package's Mac build configuration has no explicit `minimumSystemVersion` correcting the speech-runtime floor. Setting the Swift helper's target to 12 does not make its independent Python extension dependencies compatible with 12.

The v2.1.6 runtime builder pins Torch 2.11.0, Qwen ASR 0.0.6, Faster Whisper 1.2.1, and ONNX ASR 0.12.0, but not ONNX Runtime or PyAV. [Faster Whisper 1.2.1 metadata](https://pypi.org/pypi/faster-whisper/1.2.1/json) allows `onnxruntime>=1.14,<2`, `av>=11`, `ctranslate2>=4.0,<5`, and `tokenizers>=0.13,<1`. Consequently a build on a modern runner can silently select newer native OS requirements even with unchanged top-level pins.

`task/runtime-installed.json` inventories the user's **Windows** runtime, including ONNX Runtime DirectML 1.24.4, Torch 2.11.0+cpu, CTranslate2 4.8.1, and PyAV 18.1.0. It is not evidence of the released Mac runtime's resolved versions. No archived released Mac distribution inventory was available in the inspected artifacts.

Parakeet uses ONNX Runtime, so ORT's floor directly affects the requested Mac local dictation path. Whisper imports PyAV and CTranslate2. Qwen is not exposed in the Mac product UI, but its Torch and other dependencies are still bundled by the common runtime builder; removing that unused Mac stack alone would not fix the ORT/PyAV gap.

## Bounded product choices

1. **Require macOS 14+ for the current bundled product (smallest change).** Align package `build.mac.minimumSystemVersion`, README/site support statements, and the readiness report. Add a build-time check that selected native package/Mach-O minimum versions do not exceed the declared floor. Keep the current patched dependencies. Test on the minimum supported macOS version separately from current `macos-latest`. This changes an advertised support promise and needs the user's product decision; no such change has been made here.

2. **Preserve macOS 12/13 with a separately validated legacy-compatible runtime.** Official Torch 2.13.0 has no CP312 Mac wheel for 12/13. Either omit the Mac-unused Qwen/Torch stack or maintain a patched source build; do not silently revert to vulnerable Torch. ONNX Runtime 1.19.2 is the latest queried official version with a compatible macOS 11 universal wheel; 1.20.1 through 1.23.2 require 13, while 1.24.4 and each queried later series through 1.30.0 require 14. PyAV 13.1.0 has a CP312 macOS 11 ARM wheel; 15.0/15.1 require 13 and 16.0.1 requires 14. PyPI reported no advisories for these older ORT/PyAV versions on the audit date, which does not establish continuing upstream support or bundled FFmpeg-library safety. Resolve every native wheel for the legacy target, then run actual Parakeet and Whisper inference, long recordings, packaged startup/upgrade, and physical Mac acceptance on the target OS. This is substantially more than changing one pin.

Historical sources: [ORT 1.19.2](https://pypi.org/pypi/onnxruntime/1.19.2/json), [ORT 1.20.1](https://pypi.org/pypi/onnxruntime/1.20.1/json), [ORT 1.23.2](https://pypi.org/pypi/onnxruntime/1.23.2/json), [ORT 1.24.4](https://pypi.org/pypi/onnxruntime/1.24.4/json), [PyAV 13.1.0](https://pypi.org/pypi/av/13.1.0/json), [PyAV 15.1.0](https://pypi.org/pypi/av/15.1.0/json), [PyAV 16.0.1](https://pypi.org/pypi/av/16.0.1/json).

Until the support policy and runtime are aligned, the current bundle is **NO-GO for the advertised macOS 12+ range**. This does not negate the successful real ARM Parakeet inference on the newer CI operating system.
