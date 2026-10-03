# Voxden 2.1.7 verification — 3 October 2026

The app ships one new notification: “Faster dictation, more reliable pasting and refreshed sounds.” GitHub and the website use `release-notes/current.md`; the website is generated with `scripts/build-changelog.js`. The previous notes are preserved in `release-notes/2.1.6.md`.

## Tested builds

- App source: tag `v2.1.7`, commit `ba666f6cf5d4e169bdeb8271d173ebd4cdd29e4c`.
- [Windows build and smoke tests](https://github.com/sounak1125/voxden/actions/runs/37104439299/job/111150111308): passed. Includes the full regression suite, native helpers, game shortcuts, administrator settings, in-app dictation, theme saving, speech setup, music, sound cues, capture reuse, changelog and release UI, flow bar, notifications, account persistence, and packaged startup.
- Windows package verification compared 97 source files, five sidecar files, helper resources, app version and bundled runtime hash. Fresh and existing-profile startup passed, including history totals and dictionary preservation.
- [Mac build and smoke tests](https://github.com/sounak1125/voxden/actions/runs/37104902172/job/111151393060): passed. All 103 regression commands passed, along with native theme saving, in-app dictation, sounds, capture reuse, changelog and release UI. ZIP and DMG architecture/signature checks, bundled speech-runtime installation and probes, and the packaged app startup smoke test passed.
- The original Mac test run could not read the synthetic microphone WAV through the audio-service sandbox. Commit `ba63eff` fixes only that test fixture. The Mac rerun contains identical app source to the tag; production sandbox settings are unchanged.
- Local Windows validation: all 103 regression commands passed, plus capture, changelog, release and notification UI tests. Production dependency audit reported zero known vulnerabilities; the public account service check passed.

## Download verification

- Downloaded Windows installer and Mac ZIP source were compared against all 97 tagged app source files, normalizing checkout line endings. The installer’s Windows paste helper also matched.
- Both update manifests name version 2.1.7 and contain exactly the release-notes source. Package sizes and SHA-512 hashes were verified against those manifests.
- Windows installer: 547,024,473 bytes; Mac DMG: 508,590,158 bytes; Mac ZIP: 514,035,950 bytes.
- Website notes and the one-line app highlight were compared in a real renderer at desktop and mobile widths; previous release history remains present.

The first Windows asset upload created two unpublished drafts concurrently. The blockmap was downloaded and hash-verified before consolidating it into the installer’s draft. The workflow now creates one draft before parallel uploads and refuses to modify an already published release.

Mac packages remain Apple Silicon builds signed ad hoc, with manual updates and the existing first-run instructions. Windows remains unsigned. These tests do not replace live microphone testing across every device and destination app.
