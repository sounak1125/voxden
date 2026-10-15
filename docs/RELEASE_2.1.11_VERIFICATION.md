# Voxden 2.1.11 release verification

Published 2026-10-15 at 10:04 UTC from the annotated tag `v2.1.11` at
`62aedaf`.

## Before the tag

- Measured on the owner's clips before building (temp/speed-2026-10-12, not
  committed): 4 s pieces with MAI and an AssemblyAI tail had 8.0% word errors
  against 8.9% for AssemblyAI alone; 2 s pieces had 9.7% and about twice the
  stray stops, so pieces stay at 4 s. A live real-time replay of 24 clips
  gave a wait after stop of p50 0.87 s and p90 1.17 s against 0.92 s and
  1.32 s, at $0.18 against $0.30 per hour of speech.
- One code review of the lanes diff. Its findings were fixed before the
  commit: the stop rule's Hinglish lists firing for Spanish, Italian,
  Portuguese, French and Turkish; "Of course" and short exclamations losing a
  real stop; more tail requests at stop than the relay's tail pool allowed;
  the lane decision drifting mid-recording; urgent calls from accounts
  without lanes being logged; a quadratic match on long unspaced text.
- `node temp/speed-2026-10-12/run-tests-clean.js`: 111 commands, 0 failed.
- A local run of the release job's Windows steps passed all 25 steps,
  including the installer build (546,220,009 bytes) and the packaged startup
  test on a fresh and an existing profile (version 2.1.11).
- Account service CI run 38715050608 green (tests and image).
- The account service was deployed with lanes off before publishing: both
  containers run the new image, `/app/app.js` has the urgent route, and the
  start line reads `cloud=assemblyai/universal-3-5-pro
  rescue=openai/gpt-4o-mini-transcribe warmup=on lanes=off`.

## Release run

- Run 38715864791: `mac`, `release` and `mac-release` succeeded on the first
  attempt.

## Published release

- `gh api .../releases/latest` returns `v2.1.11` with 6 assets:
  `Voxden-Setup-2.1.11.exe` (547,119,473 bytes) and its blockmap,
  `Voxden-2.1.11-mac-arm64.dmg` (508,302,732), `.zip` (513,651,231),
  `latest.yml`, `latest-mac.yml`.
- Both feeds served from `releases/latest/download/` say `version: 2.1.11`,
  and their sizes match the uploaded files.
- The release body is `release-notes/current.md` without its Version and
  Released lines.

## Not verified

- The 2.1.10 to 2.1.11 auto-update on a real install.
- Any Mac behaviour on a real Mac.
- Lanes in production beyond the owner's accounts, and on a slow MAI day.
