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

## Remaining Python dependency findings

The existing Windows CPU runtime's 99 installed distributions were queried
against PyPI's version-specific vulnerability metadata. All 99 queries succeeded;
four distributions had advisories (duplicate PYSEC/GHSA aliases are not separate
bugs). This inspected the existing local runtime, not every published GPU pack
or a newly rebuilt macOS runtime.

| Distribution | Version inspected | Finding and disposition |
| --- | --- | --- |
| `accelerate` | 1.12.0 | [CVE-2026-69112](https://github.com/advisories/GHSA-4j2p-28q2-5m79): untrusted checkpoint shard paths; advisory lists no patched release. Qwen requires this exact version. |
| `transformers` | 4.57.6 | Advisories include untrusted model/config loading, conversion and tokenizer saving ([GHSA-29pf-2h5f-8g72](https://github.com/advisories/GHSA-29pf-2h5f-8g72), [GHSA-fgcw-684q-jj6r](https://github.com/advisories/GHSA-fgcw-684q-jj6r), [GHSA-xrqw-3rrv-vx5w](https://github.com/advisories/GHSA-xrqw-3rrv-vx5w), PYSEC-2025-217). Published fixes for several require Transformers 5.x; Qwen 0.0.6 requires exactly 4.57.6. The separate [Trainer RNG-state issue](https://github.com/advisories/GHSA-69w3-r845-3855) requires torch below 2.6, unlike this runtime. |
| `torch` | 2.11.0+cpu | [CVE-2025-3000](https://github.com/advisories/GHSA-rrmf-rvhw-rf47), `torch.jit.script` memory corruption; metadata names 2.13.0 as fixed. Voxden has no direct `torch.jit.script` calls; transitive reachability has not been proven absent. CPU/CUDA/ROCm model integration must be validated before a runtime migration. |
| `setuptools` | 81.0.0 | [CVE-2026-59890](https://github.com/advisories/GHSA-h35f-9h28-mq5c), Unicode exclusions when building Python source distributions; fixed in 83.0.0. Voxden does not build/publish Python sdists during dictation. The existing runtime was not modified. |

The exact Qwen requirements were confirmed from its installed distribution
metadata, not inferred from Voxden's requirements file. Do not override them
with an untested major Transformers upgrade. Resolve these in a coordinated
speech-runtime update, validating Qwen's custom-vocabulary context, real model
loading, CPU and supported GPU packs, and the separate training environment.
Only use trusted model/config/checkpoint inputs in the meantime. The app's
managed catalog verifies hashes, which reduces exposure to arbitrary remote
models but does not erase these dependency findings or protect developer
overrides and locally modified files.

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
