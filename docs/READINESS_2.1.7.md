# Prospective v2.1.7 readiness review

Review date: 2026-09-30. Work is on [draft PR #31](https://github.com/sounak1125/voxden/pull/31).
The application version remains 2.1.6. No release tag, merge or publication is
authorized or performed by this review.

**Recommendation: NO-GO until the macOS support-floor decision and the
interactive Mac acceptance gates below are completed.** Automated checks can establish specific behavior; they
cannot establish that every bug is fixed. Consult the PR's exact-head checks and
attached reports for final CI outcomes, rather than older successful release runs.

## Defects fixed and safeguards added

- Apple-silicon Parakeet expected a literal `?int8.onnx` filename where the
  managed catalog installs `.int8.onnx`. All platforms now use catalog names.
- Missing fallback weights no longer hide the original selected-engine failure.
- Real Whisper audio revealed that PyAV 19 removed `metadata_errors`, still
  passed by Faster-Whisper 1.2.1. Runtime/training/GPU-pack builds now pin PyAV
  18.1.0; real WAV decoding and invalid-audio regression tests cover this path.
- macOS theme saving avoids the unsupported caption-overlay setter.
- Native Mac paste now refuses vanished/wrong targets, raises the captured
  window within the same app, and verifies focus again immediately before input.
- Electron only grants explicit audio permission to trusted top-level app pages.
  Camera, other permissions, subframes and foreign files are rejected; synthetic
  microphone enumeration/capture is tested through real Electron.
- Windows installer instructions now name the actual default `Ctrl+Win` chord.
- Reduced-motion styling no longer introduces unintended position transitions
  on history menus. Immediate anchoring and real pointer hit tests cover the
  bug at 125% and 150% display scaling.
- OAuth callback error HTML is escaped and constrained by CSP.
- Electron/build dependencies and bundled 7-Zip were updated; archive downloads
  verify pinned SHA-256 before extraction. npm audit found zero known advisories.
- Base Python runtime uses patched torch 2.13.0 and setuptools 83.0.0. Runtime
  IDs advance to v4 with an offline replacement regression. Qwen loading rejects
  unsafe configuration metadata/shard paths and uses fixed model/processor
  classes. Optional training moves to Transformers 5.10.0.
- Removed only the uncalled sidecar prefetch/progress path and obsolete wrapper
  notice. The original dirty checkout and its seven changed files were preserved.

## Coverage and evidence

The [repository inventory](READINESS_INVENTORY_2.1.7.json) classifies every tracked
file and records hashes and static-check results. It excludes ignored dependency trees, generated installers,
downloaded model weights and personal profiles. A textual test reference is a
navigation aid, not measured line/branch coverage. Artwork and documentation are
not executable files; release/deployment tools are inspected without publishing.

| Area | Verification | Meaning and limits |
| --- | --- | --- |
| All tracked source/configuration | JavaScript syntax; Python AST; PowerShell AST; JSON/YAML/XML/plist/SVG parsing; HTML local asset references | Detects parse/reference errors, not every semantic or visual defect. Binary assets are inventoried/hash-recorded. |
| Main, renderer, account/service, hotkeys, settings, history, recovery, downloads, security | Full default regression chain, each command recorded separately by `test-report.js` | Mixture of unit/integration/source assertions; see per-command logs. Production account health/config is separately read-only tested; real OAuth consent, email delivery and billing are not exercised. |
| Desktop UI and speakbar | `test-desktop-readiness.js` runs 43 sequential Node/Electron checks with per-test logs, timeouts and recorded skips | Disposable profiles, local service fixtures and synthetic recording. Covers repeated/interrupted flows, stale audio requests, track cleanup, frame/animation recovery, themes, onboarding and settings. |
| Sleep/lock recovery | Production power-event subscriptions and functions tested across six HUD states and 20 repeated cycles | Simulated suspend/resume/lock/unlock; no lid-close, physical sleep or microphone re-enumeration claim. |
| Mac paste | Native Swift helper builds; 15 focus/paste cases execute helper logic with simulated OS calls; real helper protocol/invalid-target checks | Does not grant Accessibility or successfully paste into a real third-party app. |
| Permissions | 41 request/check cases plus native Chromium fake-device capture | Confirms permission boundary and synthetic audio. OS microphone/Accessibility prompts and grant/revoke behavior remain manual. |
| Parakeet V3 | Opt-in production downloader + full asset hashing, actual offline model load, public sample transcription, repeated requests, invalid language/path recovery, process restart and absent-model fallback | 10 checks. Requires native Windows or Mac ARM runtime; CI asserts actual platform/architecture. A short English synthetic sample does not establish multilingual or long-dictation accuracy. |
| Qwen | Real cached 1.7B model transcribes the public fixture on Windows CPU; custom vocabulary reaches its real chat template; tiny weights reload/generate on supported CI | Actual audio evidence is separate from tiny random-weight mechanics. No private audio or paid service. GPU inference remains unqualified for the new dependency versions. |
| Whisper | Cached production large-v3 weights pass five file-integrity checks and transcribe the public fixture on Windows CPU/int8, with and without VAD/vocabulary; real file and in-memory WAV decoding regressions | Separate from the tiny training model. Turbo-specific weights/inference and the complete multi-engine installation smoke are not exercised. |
| Packaging | Rebuild self-contained Windows/Mac runtime, Windows installer and Apple-silicon app; strict ad-hoc signature check; packaged `app.asar` fresh/existing-profile startup; actual signed Mac executable smoke | Not a Windows installer execution, notarization, Gatekeeper first-launch acceptance or upgrade/uninstall UI test. Existing-profile fixture verifies history/dictionary retention only. |
| Optional training | 70 tests under patched Torch/Transformers/setuptools, including LoRA reload/merge and actual CTranslate2 inference | 69 pass on CPU; CUDA FP16 case is skipped. No large-v3 fine-tune/accuracy or new CUDA-stack qualification. |
| Website/docs/assets | Syntax, local references, hashes and relevant release instructions | No full browser/device/visual/accessibility review or factual verification of every historical document. |

Reproduction commands and execution evidence:

```text
npm ci
npm audit --audit-level=low
npm run prepare:asr-runtime
node scripts/test-report.js --strict --json dist-test-report/results.json
node scripts/test-desktop-readiness.js
node scripts/test-parakeet-inference.js --json dist-test-report/parakeet.json
python -m unittest discover -s training -p 'test_*.py' -v
```

Set `VOXDEN_PYTHON` to the built runtime before speech checks. Parakeet downloads
approximately 670 MB to an isolated test cache. On Mac, add
`--expect-platform darwin --expect-arch arm64`. The workflow also packages and
checks actual app resources. Its `desktop-checks-<platform>` artifacts contain
per-command JSON and detailed desktop logs. The separate training job uses its
own environment, never Qwen's pinned runtime.

The signed-app smoke now bounds native commands and DevTools discovery,
records native main/GPU stacks on failure, and cleans up only its own process
group. A previous run stalled before producing pages; a passing signature alone
does not establish successful application startup. The current PR check must
confirm the actual executable's result before this area can be marked passed.

Native Apple-silicon evidence: [run 36686339710](https://github.com/sounak1125/voxden/actions/runs/36686339710)
on commit `984362d` passed all 10 real Parakeet checks on `darwin/arm64`, Python
3.12.14, ONNX Runtime 1.30.0. All four sample transcriptions had zero word error
rate (0.48–0.58 seconds recognition for a 3.375-second fixture). All four catalog
assets were SHA-256 verified. That run also exposed cross-platform desktop-test
assumptions; its overall result is not a passing release check. The current PR
check and artifacts are authoritative for the subsequent corrected fixtures.

Qwen also transcribed the public fixture and accepted vocabulary through the
guarded loader using the existing developer CUDA 12.8 environment (torch 2.11,
RTX 4070). This is backward-compatibility evidence only: the new CUDA 13 / torch
2.13 stack has not been qualified. Trying Qwen 0.0.6 with Transformers 5.10 failed
at import (`check_model_inputs` decorator API), confirming that removing its
older Transformers pin requires a coordinated upstream change or maintained port.

## Remaining security scope

See [the scoped security audit](SECURITY_AUDIT_2026-09-30.md) for exact versions,
advisory sources, reachability and mitigations. Transformers and Accelerate remain
flagged in Qwen's upstream-pinned environment; application guards do not change
that package fact. Accelerate 1.15 still has vulnerable source despite clean
metadata. Optional published CUDA/ROCm packs retain older torch and dependencies.

Removing the legacy GPU torch finding needs a product/support decision:
retain documented low-severity local JIT debt or qualify an additional CUDA 13
pack with newer driver/GPU gates. Silently replacing CUDA 12.8 or AMD's matched
ROCm binaries would break the current support contract. New GPU asset publication
requires separate authorization. No claim of zero vulnerabilities is made.

## macOS compatibility decision

The current bundle cannot substantiate the advertised macOS 12+ requirement:
official Torch 2.13, ONNX Runtime 1.30 and current PyAV ARM wheels require macOS
14+. Electron and the native helper still permit 12. Native Parakeet inference
was tested on macOS 26.6.2 ARM; neither 12/13 nor the proposed 14 floor was
exercised. See the [dependency-by-dependency evidence and primary sources](MACOS_SUPPORT_AUDIT_2026-09-30.md).

The product decision is pending: accurately declare/enforce 14+ for the bundle,
or engineer and qualify a separate compatible runtime for 12/13. The README,
website and installation floor have deliberately not been changed without that
decision. Retaining 12/13 requires several dependency changes and target-OS
verification; reverting only Torch would also restore a known advisory.

## Required interactive release acceptance

1. On a physical M1 Mac, install the candidate from a clean profile and exercise
   microphone/Accessibility permission deny, allow and revoke. Verify actual
   microphone selection, speech capture, repeated short/long sessions and engine
   switching, including Parakeet V3 on real speech.
2. Paste into representative apps and multiple windows of the same app; close
   or switch the target during transcription and confirm safe clipboard recovery.
3. Sleep/wake, lock/unlock, change audio devices, and move between displays while
   idle/recording/transcribing. Confirm the speakbar recovers without unexpected
   capture, lost controls or wrong-window paste.
4. Exercise OS-level fresh install, upgrade from 2.1.6, rollback/error handling,
   uninstall/reinstall and Gatekeeper behavior. Verify retained history/settings.
5. Review remaining dependency findings and GPU support choice; qualify any
   optional GPU/training change on the corresponding hardware before publishing.

Native Mac ARM CI is real Apple-silicon execution, but it is not the user's M1,
an interactive permission session or a physical microphone. These distinctions
are release gates, not failures to be hidden by a green unit-test count.
