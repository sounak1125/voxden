# Desktop security review, 30 September 2026

This is a bounded source and dependency review, not a claim that Voxden has no
vulnerabilities. No production service was probed or deployed. Existing local
work was preserved in its original checkout.

## Fixed in this change

- The OAuth loopback callback interpolated the provider's error parameter into
  HTML after validating state. Escape that text and add a restrictive CSP and
  `nosniff`. A real HTTP-listener regression sends HTML/script markup with a valid
  state and checks that the page contains escaped text. State/PKCE, cancellation,
  successful login, and listener shutdown remain covered.
- Upgrade Electron 43.7.5 to 43.7.6 and electron-builder 25.1.8 to 26.15.3;
  regenerate the dependency lock. `npm audit --json` changed from 14 affected
  packages (1 critical, 12 high, 1 moderate) to zero on this date. These are
  package findings, not 14 independent application exploits. The old build tree
  included vulnerable `tar`, `brace-expansion`, `ip-address`, and
  `builder-util-runtime` versions. The latter's credential-redirect issue is
  described in [GHSA-p2f4-r6v6-j797](https://github.com/advisories/GHSA-p2f4-r6v6-j797).
- Replace the implicitly supplied 7-Zip 21.07 executable with upstream 26.03.
  `npm install` now stages the correct platform binary from a pinned upstream
  archive, checks SHA-256 before extraction, and checks the executable version.
  Windows uses the builder's older extractor only to bootstrap this verified
  archive; that bootstrap is not shipped. Tampered-download and real archive
  extraction tests cover the new preparation and existing GPU-pack paths.
  Update the bundled upstream license and source links; remove the obsolete
  npm-wrapper MIT notice.
- Remove the unreachable sidecar `prefetch_hub_model`, its private tqdm/progress
  helpers, and their two state variables. Repository reference searches found no
  caller. Managed downloads remain in `speech-models.js`/`release-download.js`,
  with catalog SHA-256 checks. No engine, model, migration, or user data was deleted.

## Python remediation and remaining findings

The original Windows CPU runtime's 99 installed distributions were queried
against PyPI's version-specific vulnerability metadata. All queries succeeded;
four distributions had advisories. The follow-up changes below address the
shipped base runtime, application loading boundary and separate training stack.
They do not modify previously published installers or optional GPU archives.

| Distribution | Original version | Finding and current disposition |
| --- | --- | --- |
| `accelerate` | 1.12.0 | [CVE-2026-69112](https://github.com/advisories/GHSA-4j2p-28q2-5m79), moderate 6.9: malicious checkpoint shard paths can read files or block on special files. No listed patched release. Inspected 1.15.0 source still performs unchecked joins despite clean PyPI metadata, so merely upgrading is not a verified fix. Qwen pins 1.12.0. |
| `transformers` | 4.57.6 | Qwen still pins this release. Application guards described below constrain its relevant configuration/shard inputs; the package advisory remains. Optional training now uses **5.10.0**, covering attention RCE (fixed 5.3), LightGlue (5.5), and tokenizer/processor save-path traversal (5.10). |
| `torch` | 2.11.0+cpu | [CVE-2025-3000](https://github.com/advisories/GHSA-rrmf-rvhw-rf47), JIT memory corruption. Base Windows/Mac runtime now pins **2.13.0**; training requires >=2.13. Reviewed GitHub severity is **low 1.9**, local attack; the historical description's word “critical” is not the reviewed severity. Existing optional CUDA/ROCm packs remain affected versions. |
| `setuptools` | 81.0.0 | [CVE-2026-59890](https://github.com/advisories/GHSA-h35f-9h28-mq5c), moderate 6.1: Unicode filename exclusions can leak files when publishing a Python sdist. Base runtime and training now pin patched **83.0.0**. Desktop dictation does not build/publish sdists. |

### Exposure and application safeguards

`sidecar/qwen_security.py` uses fixed Qwen model/processor classes, strips
serialized internal configuration and class metadata (`sub_configs`,
`attribute_map`), and forces built-in SDPA attention on nested configs. This
mitigates the high-severity [attention-kernel RCE](https://github.com/advisories/GHSA-29pf-2h5f-8g72)
and avoids [LightGlue dispatch](https://github.com/advisories/GHSA-fgcw-684q-jj6r).
Both model and processor loading receive offline/security flags; Qwen's
upstream generic factory had dropped them on its processor call. Checkpoint
loads require safetensors and validate shard paths/file types, with a narrow
exception for normal same-repository Hub blob links. These are application
mitigations, not a patched Transformers/Accelerate distribution.

The desktop never saves tokenizers/processors and never runs the X-CLIP
conversion utility (PYSEC-2025-217). The separate training workflow does save
processors, so its Transformers upgrade addresses the relevant
[save-path advisory](https://github.com/advisories/GHSA-xrqw-3rrv-vx5w).
The [Trainer RNG-state advisory](https://github.com/advisories/GHSA-69w3-r845-3855)
requires torch <2.6; neither tested stack satisfies that condition.

No direct calls to Accelerate's affected checkpoint loaders or
`torch.jit.script` were found in Voxden/Qwen. Instrumented real Qwen loading and
speech recognition also succeeded with the affected Accelerate entry points
replaced by failures. This bounds evidence for that CPU inference path; it does
not prove every GPU/training/transitive path unreachable. Training starts fresh
and does not provide a resume-from-untrusted-checkpoint workflow. Use trusted
models/checkpoints; managed-model hashes remain the primary trust boundary.

### Compatibility evidence and unresolved decisions

- Patched CPU torch + setuptools passed `pip check`, tiny real Qwen weight
  save/reload/generation, and a cached 1.7B model's actual recognition of the
  public synthetic sentence “The quick brown fox jumps over the lazy dog.”
  Custom vocabulary reached Qwen's real chat template. No private audio was used.
- Training with torch 2.13.0+cpu, Transformers 5.10.0 and setuptools 83.0.0
  passed 69 of 70 tests; the CUDA FP16 test was explicitly skipped. Tests include
  LoRA gradients, adapter reload/merge, CTranslate2 conversion and inference.
- Base runtime IDs advance to v4 so a future installer replaces v3; the output
  directory keeps its historical `dist-runtime-v3` name. An offline upgrade
  regression verifies replacement, and runtime rollback remains covered.
- Qwen 0.0.6 is still the latest upstream release and requires exactly
  Transformers 4.57.6/Accelerate 1.12.0. Removing those package findings needs
  upstream compatible releases or a separately maintained Qwen port/fork. No
  untested dependency override or misleading advisory suppression was added.
- Current CUDA 12.8 has no Windows torch 2.13 wheel. CUDA 13 does, but requires
  R580+ drivers and Turing+ GPUs, changing the existing optional pack's support
  floor. Smallest decision: retain the legacy pack's documented low-severity JIT
  debt, or qualify an additional CUDA 13 pack with explicit hardware gates.
  AMD's ABI-matched Windows ROCm 7.2.1 pack similarly cannot take a CPU wheel as
  a substitute. New GPU pack publication is outside this PR's authorization.
  See [NVIDIA CUDA 13 compatibility](https://docs.nvidia.com/cuda/archive/13.0.0/cuda-toolkit-release-notes/index.html).

## Other paths reviewed

- Electron windows keep sandboxing, context isolation, no Node integration,
  navigation restrictions, and microphone permission handling.
- Account token storage/service selection, Google state and PKCE, server body
  limits/authentication/billing checks, release download integrity and ZIP path
  validation were inspected; their existing automated regressions are included
  in the full suite. This was not an exhaustive penetration test.
- No repository TypeScript compiler or lint command is configured. JavaScript
  syntax checks, Python sidecar compilation and the app regression suite provide
  the applicable automated checks.

## Mac regressions and verification scope

Parakeet previously treated onnx-asr's `?int8` glob as a literal macOS filename,
despite the managed catalog installing `.int8.onnx`. The fix uses the catalog
filename on every platform. A fresh Parakeet-only setup must load without a
Whisper snapshot; if fallback also fails, the original selected-engine error
must remain visible. Fixtures exercise both macOS and Windows and incomplete
packs. Theme saving now avoids `setTitleBarOverlay` on macOS, where Electron
does not expose that Windows/Linux setter.

Both regressions and the OAuth regression were reproduced against committed
main before checking the corrected source. The PR adds Windows/macOS checks and
a macOS runtime/package/signature check that never publishes. Native automated
UI tests simulate recording: real M1 microphone, Accessibility paste, sleep/wake
and long-session dictation still need hardware acceptance before release.
