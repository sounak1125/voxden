# Voxden 2.2.0 release verification

Published 2026-10-21 at 06:17 UTC from the annotated tag `v2.2.0` at
`5cb33ee`.

## Before the tag

- Four report-only audits of 2.1.11..HEAD (renderer, CSS, main and server,
  security), then an independent review of the fixes. Reports are in
  temp/release-audit-2-1-12/ (not committed).
- App fixes landed in 3cb0d4d and e946637:
  - search highlight on a dotted capital I and on long histories;
  - the elevated restart passes no switches;
  - escaped shortcut keycaps and the Google callback page;
  - capped window titles;
  - stricter CSP;
  - dead code removed.
- The server fixes (rate limits, uploads admitted before they are read,
  checkout reuse, one hurry per dictation, the credit month from the
  provider's period start, strict warm-up parsing) landed in ae6cec7 and
  were deployed on 2026-10-19.
- d2e99fd removes 711 dead or overridden CSS lines.
  - Proof: a replay of the real app.html over 416 page states (both
    themes, widths 560-1500, reduced motion, dialogs, plans), with
    1,683,917 elements times 525 computed properties plus every
    pseudo-element. Before and after are identical, with equal element
    counts.
  - The same commit makes four rules take effect: the Polish shimmer,
    reduced motion on the island ring, the sign-in button size, and the
    finite bell and Insights mascot animations. After them, an idle
    dashboard with an unread notification and an idle Insights page both
    draw 0 frames a second, down from ~20 and ~162.
- The full local release check (temp/release-2-2-0/final-check.sh) passed
  all 30 steps. They include the installer build and the packaged startup
  test on a fresh and an existing profile, both at version 2.2.0.
- The Mac-only Release run 39536829572 on e946637 was green. The Swift
  key-watch helper changed in aac4376 builds there, and every packaged
  smoke check passes.

## Release runs

- Run 39544159743 (tag at 23a7ede) failed on both runners in
  test-flow-bar-audio-ui.js, because the test's fixed 20 ms wait was too
  short on loaded runners. It was reproduced locally with the overlay
  CPU-throttled 6x. On macOS the failed assertion also hung the job until
  its 45-minute limit, behind a modal error box. Fixed in 813e541. The tag
  was moved; no draft had been created.
- Run 39548867993 (tag at 813e541) passed the audio test on Windows.
  - The packaged startup test then hit an uncaught `write EPIPE`: QUIT went
    to a PowerShell helper that had already exited, and nothing listened
    for errors on its stdin. That is a latent app bug, which could show
    Electron's error box at quit.
  - macOS failed at another fixed-wait assertion.
  - Both were fixed in 5cb33ee: stdin errors retire the helper, and all 15
    positive count assertions wait for their report. The test passes at
    6x and 8x throttle. The tag was moved again.
- Run 39552065394 (tag at 5cb33ee): `release`, `mac` and `mac-release`
  succeeded.

## Published release

- `gh api .../releases/latest` returns `v2.2.0` with 6 assets:
  - `Voxden-Setup-2.2.0.exe` (547,185,613 bytes) and its blockmap;
  - `Voxden-2.2.0-mac-arm64.dmg` (508,316,513);
  - `Voxden-2.2.0-mac-arm64.zip` (513,786,155);
  - `latest.yml` and `latest-mac.yml`.
- Both feeds served from `releases/latest/download/` say `version: 2.2.0`.
  Their sizes match the uploaded files, and the installer downloads at
  that size.
- The release body is `release-notes/current.md` without its Version and
  Released lines. The in-app bell entry `island-redesign-2-2-0` uses the
  same opening paragraph.
- The site's home and download pages show 2.2.0. The installer sizes still
  round to 522 MB and 485 MB. The changelog has the #v2-2-0 entry.

## Not verified

- The 2.1.11 to 2.2.0 auto-update on a real install.
- Any Mac behaviour on a real Mac.
- The quit-time EPIPE fix in the field: it was reproduced only by the CI
  race, never on a real install.
