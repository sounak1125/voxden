# macOS support-floor audit — 2026-09-30

Dependency audit begun while commit `63197a5` CI was running. The user approved changing the requirement to **macOS 14+ on Apple silicon** on 2026-09-30 at 09:19 UTC. The original mismatch and alternative below record the basis for that decision; final implementation and qualification are tracked in draft PR #31.

## Material finding

The documented **macOS 12+ on Apple silicon** promise does not match the currently resolved speech runtime. Its **ONNX Runtime 1.30.0 requires macOS 14+**, and the newly pinned **PyTorch 2.13.0 also requires macOS 14+** in the official CPython 3.12 ARM wheels. Current PyAV native wheels independently have the same floor. Passing CI on a newer native ARM Mac does not establish compatibility with macOS 12 or 13.

The narrow verified regression from the security upgrade is the Torch wheel requirement changing from 11 to 14. The complete application gap cannot be attributed entirely to this PR: the v2.1.6 build already resolved ONNX Runtime and PyAV transitively without version or deployment-target constraints.

## Evidence by component

| Component | Evidence | Declared minimum |
| --- | --- | --- |
| Electron 43.7.6 | Versioned upstream README states Monterey and newer; 43.7.5 says the same | macOS 12 |
| Swift native helper | Previously targeted 12; `scripts/build-mac-helper.js` now invokes `swiftc -target arm64-apple-macos14.0` | macOS 14 |
| CPython 3.12.14, python-build-standalone 20260929 | CI log selects this exact release; upstream aarch64 Darwin target has `-mmacosx-version-min=11.0` in compiler and linker flags | macOS 11 |
| Torch 2.11.0, prior pin | `torch-2.11.0-cp312-cp312-macosx_11_0_arm64.whl` | macOS 11 |
| Torch 2.13.0, new pin | Only official CP312 Mac wheel: `torch-2.13.0-cp312-cp312-macosx_14_0_arm64.whl` | macOS 14 |
| ONNX Runtime 1.30.0, actual Mac inference artifact | `onnxruntime-1.30.0-cp312-cp312-macosx_14_0_arm64.whl` | macOS 14 |
| CTranslate2 4.8.2, current resolver candidate | `ctranslate2-4.8.2-cp312-cp312-macosx_11_0_arm64.whl` | macOS 11 |
| Tokenizers 0.22.2, compatible with pinned Transformers 4.57.6 | `tokenizers-0.22.2-cp39-abi3-macosx_11_0_arm64.whl` | macOS 11 |
| Tokenizers 0.23.2, latest queried | `tokenizers-0.23.2-cp310-abi3-macosx_11_0_arm64.whl` | macOS 11 |
| PyAV 19.0.0, current resolver candidate | `av-19.0.0-cp312-abi3-macosx_14_0_arm64.whl` | macOS 14 |
| NumPy 2.5.3, actual Mac inference artifact | Both `numpy-2.5.3-cp312-cp312-macosx_11_0_arm64.whl` and `numpy-2.5.3-cp312-cp312-macosx_14_0_arm64.whl` exist | Depends on selected wheel |
| Published 7-Zip 26.03 Mac executable | Inspected ARM64 `LC_BUILD_VERSION` declares 26.0; its archive hash matched the upstream pin | macOS 26; rejected for this product |
| 7-Zip 26.03 source build | Mac preparation now compiles the same verified upstream source with `-mmacosx-version-min=14.0` and audits the resulting binary before running/copying it | macOS 14 target; native CI verifies the build |
| orjson 3.12.0, Mac universal2 wheel | ARM64 Mach-O slice inspected after verifying the PyPI SHA-256; selected explicitly by the Mac runtime builder | macOS 11 |
| orjson 3.12.0, separate ARM64 wheel | Newer Mac hosts prefer its macOS 15 wheel; the native audit rejected this dependency in commit `877c295` | macOS 15; rejected for this product |

Sources:

- [Electron 43.7.6 platform support](https://github.com/electron/electron/blob/v43.7.6/README.md#platform-support); [43.7.5 comparison](https://github.com/electron/electron/blob/v43.7.5/README.md#platform-support).
- [Pinned python-build-standalone target configuration](https://github.com/astral-sh/python-build-standalone/blob/20260929/cpython-unix/targets.yml#L64-L103).
- [Torch 2.13.0 official package metadata](https://pypi.org/pypi/torch/2.13.0/json); [Torch 2.11.0](https://pypi.org/pypi/torch/2.11.0/json).
- [ONNX Runtime 1.30.0 official package metadata](https://pypi.org/pypi/onnxruntime/1.30.0/json).
- [CTranslate2 4.8.2](https://pypi.org/pypi/ctranslate2/4.8.2/json).
- [Tokenizers 0.22.2](https://pypi.org/pypi/tokenizers/0.22.2/json); [Tokenizers 0.23.2](https://pypi.org/pypi/tokenizers/0.23.2/json).
- [PyAV 19.0.0](https://pypi.org/pypi/av/19.0.0/json); [NumPy 2.5.3](https://pypi.org/pypi/numpy/2.5.3/json).

The initial Mac inference report is `task/mac-readiness-ci/parakeet.json`: Darwin ARM64, Python 3.12.14, ONNX ASR 0.12.0, ONNX Runtime 1.30.0, NumPy 2.5.3. It does not record the selected NumPy wheel tag or CTranslate2/PyAV distribution versions, so those selections must not be described as verified installed versions solely from this report. `task/mac-ci-failed.log` records the exact Python build and Torch 2.13.0 installation command. Those initial checks established wheel declarations, not execution on the minimum supported OS.

Subsequent [commit 877c295 CI](https://github.com/sounak1125/voxden/actions/runs/36698537633) executed on **macOS 14.8.9, Apple M1 (Virtual), ARM64**. Its Parakeet artifact passed all 10 checks, including four actual sample transcriptions with zero word error rate. Native header scans verified 418 runtime binaries and 17 packaged-app binaries, each with a highest declared minimum of 14.0.0. Packaging, strict signature verification and actual signed-app startup passed. That run still failed two UI assertions and credential-fixture cleanup; the latest Mac rejected the separate orjson macOS 15 wheel. Refer to the PR's latest exact-head results for the corrected fixtures and artifact pin. Header checks and a 14.8.9 runner do not prove every runtime path on exact macOS 14.0.

## Prior release and application paths

The same-version orjson wheel ambiguity is fixed with a Mac-only direct requirement for `orjson-3.12.0-cp312-cp312-macosx_10_15_x86_64.macosx_11_0_arm64.macosx_10_15_universal2.whl`, including SHA-256 `aa3e43a6846e91d7bde3d5a9c66090fcd8744f569a9b6cffc5e1ca38f6a461c0`. [Official PyPI 3.12.0 metadata](https://pypi.org/pypi/orjson/3.12.0/json) lists both artifacts; PyPI and OSV reported no known advisories for 3.12.0 on September 30, 2026. This keeps the current version and normal interpreter-local installation layout while ensuring new build hosts use the compatible artifact. The complete native deployment-target audit remains mandatory for all other dependencies; this pin is not a claim that unbounded future dependency updates will remain compatible.

Before this change, `README.md`, `site/download.html` and `site/index.html` advertised macOS 12+, and package metadata had no explicit `minimumSystemVersion` correcting the speech-runtime floor. These current support statements and package metadata now require 14+. Startup and runtime installation reject older macOS versions before speech initialization/downloads. Setting the helper target alone does not establish compatibility of its independent Python extension dependencies; the new runtime and packaged-binary audits inspect their ARM64 Mach-O deployment targets.

The earlier PyAV 19 resolver candidate above was subsequently replaced by an explicit 18.1.0 pin after actual Whisper decoding exposed an API incompatibility. The native binary audit checks the selected runtime rather than relying on that historical candidate's filename.

The [official 7-Zip 26.03 source archive](https://github.com/ip7z/7zip/releases/download/26.03/7z2603-src.tar.xz) is pinned to SHA-256 `9cbde5099c6deb73691b0579063da5827522ccbbcba3f0020fd04e8c8c16c0d4`. Both Mac CI jobs compile and inspect it. Windows retains its verified upstream executable. `build/pack-tools-licenses/7zip-BUILD.txt` records the rebuild method; native compatibility reports are retained with CI artifacts. Header checks inspect declared targets, not every possible runtime API path, and symlink entries are counted separately from regular binary payloads.

The v2.1.6 runtime builder pins Torch 2.11.0, Qwen ASR 0.0.6, Faster Whisper 1.2.1, and ONNX ASR 0.12.0, but not ONNX Runtime or PyAV. [Faster Whisper 1.2.1 metadata](https://pypi.org/pypi/faster-whisper/1.2.1/json) allows `onnxruntime>=1.14,<2`, `av>=11`, `ctranslate2>=4.0,<5`, and `tokenizers>=0.13,<1`. Consequently a build on a modern runner can silently select newer native OS requirements even with unchanged top-level pins.

`task/runtime-installed.json` inventories the user's **Windows** runtime, including ONNX Runtime DirectML 1.24.4, Torch 2.11.0+cpu, CTranslate2 4.8.1, and PyAV 18.1.0. It is not evidence of the released Mac runtime's resolved versions. No archived released Mac distribution inventory was available in the inspected artifacts.

Parakeet uses ONNX Runtime, so ORT's floor directly affects the requested Mac local dictation path. Whisper imports PyAV and CTranslate2. Qwen is not exposed in the Mac product UI, but its Torch and other dependencies are still bundled by the common runtime builder; removing that unused Mac stack alone would not fix the ORT/PyAV gap.

## Approved decision and considered alternative

1. **Require macOS 14+ for the current bundled product (approved).** Align package `build.mac.minimumSystemVersion`, README/site support statements, and the readiness report. Add a build-time check that selected native package/Mach-O minimum versions do not exceed the declared floor. Keep the current patched dependencies. Test on the minimum supported macOS version separately from current `macos-latest`. The user explicitly approved this support change; qualification is required before release.

2. **Preserve macOS 12/13 with a separately validated legacy-compatible runtime.** Official Torch 2.13.0 has no CP312 Mac wheel for 12/13. Either omit the Mac-unused Qwen/Torch stack or maintain a patched source build; do not silently revert to vulnerable Torch. ONNX Runtime 1.19.2 is the latest queried official version with a compatible macOS 11 universal wheel; 1.20.1 through 1.23.2 require 13, while 1.24.4 and each queried later series through 1.30.0 require 14. PyAV 13.1.0 has a CP312 macOS 11 ARM wheel; 15.0/15.1 require 13 and 16.0.1 requires 14. PyPI reported no advisories for these older ORT/PyAV versions on the audit date, which does not establish continuing upstream support or bundled FFmpeg-library safety. Resolve every native wheel for the legacy target, then run actual Parakeet and Whisper inference, long recordings, packaged startup/upgrade, and physical Mac acceptance on the target OS. This is substantially more than changing one pin.

Historical sources: [ORT 1.19.2](https://pypi.org/pypi/onnxruntime/1.19.2/json), [ORT 1.20.1](https://pypi.org/pypi/onnxruntime/1.20.1/json), [ORT 1.23.2](https://pypi.org/pypi/onnxruntime/1.23.2/json), [ORT 1.24.4](https://pypi.org/pypi/onnxruntime/1.24.4/json), [PyAV 13.1.0](https://pypi.org/pypi/av/13.1.0/json), [PyAV 15.1.0](https://pypi.org/pypi/av/15.1.0/json), [PyAV 16.0.1](https://pypi.org/pypi/av/16.0.1/json).

Option 1 is approved. The release remains **NO-GO until the 14+ checks and required acceptance tests pass**; 12/13 support is no longer the intended promise. The CI matrix now includes a separate native `macos-14` ARM job and asserts the actual OS major and architecture. Its available image is 14.8.9, not exact 14.0, and the [runner retires on November 2, 2026](https://github.com/actions/runner-images/issues/13518). Final exact-head results, including actual Parakeet inference and signed-app startup, remain authoritative.
