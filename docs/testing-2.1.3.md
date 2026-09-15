# Voxden 2.1.3 local test build

Verified on Windows on 15 September 2026. This build is not a public release.
`npm run dist` uses `--publish never`. Do not create a `v2.1.3` tag until the
local testing is accepted and `release-notes/current.md` is finalized.

## Build and installation

- Installer: `dist/Voxden-Setup-2.1.3.exe`, 528,989,367 bytes.
- SHA-256: `7c3ccc362f921392e3afdf4d4d2fbdf5f2ac656367f27f84b4c0e8fc4d2af762`.
- Executable version: 2.1.3; packaged app version: 2.1.3.
- All 119 bundled source and asset files matched the workspace byte for byte.
- Clean startup and upgrade from a 2.1.2 fixture passed using the built
  `app.asar`, with no installed speech models or Python in the test profile.
- The local installer upgraded the installed 2.1.2 app successfully. Installed
  history, dictionary and settings matched their backups before the local-test
  cloud selection was enabled. The installed archive matched the tested build.

## Automated checks

- `npm test` — passed, including packaged speech resources, Python sidecar,
  cloud segment recovery, word boundaries, account and release safety checks.
- `npm run test:app-theme` — passed: both palettes, contrast, keyboard selection,
  persistence, save rollback, native chrome, sidebar resizing and simulated
  recording with Classic, Ribbon and Orb.
- `npm run test:general-settings` and `npm run test:system-settings` — passed.
- `npm run test:changelog` — passed for normal releases, developer builds and
  installed local-test routing, including browser-open failure handling.
- `electron scripts/test-refinement-ui.js` — passed for the original Voxden
  theme; White is also covered by the app-theme suite.
- `electron scripts/test-notifications-ui.js` — passed, including current
  release highlights and both palettes' native caption color contract.
- `npm run test:flow-bar-regression` — passed. One stationary-pointer drift
  assertion was skipped because the cursor moved during that test; placement,
  resizing, frame recovery and native click recovery checks completed.
- The website generator retained the published 2.1.2 changelog and omitted the
  unreleased 2.1.3 notes and download link.
- `git diff --check` — passed.

## Testing on this PC

`npm run start:local-installed` opens the installed app with the running local
account service at `127.0.0.1:8787` and website preview at `127.0.0.1:4174`.
The local Pro account was verified with a read-only service request. The
installed app keeps its own history and dictionary; its local Pro sign-in was
copied from the developer profile after backing up both profiles.

Automated recording tests use fixtures and simulated microphone events. Real
microphone quality, perceived transcription latency and long spoken dictations
remain part of the user's PC testing before release.

## Sign-in follow-up

The public account hostname currently returns `ENOTFOUND`. Building the desktop
installer does not deploy the account server. A fresh customer install cannot
sign in until the public server and DNS are configured; the successful local
Pro check above did not establish public sign-in readiness.

The corrected local build remembers an explicitly selected service in
`account-service.json` before authentication, independently of `account.json`.
It keeps that selection across restart and sign-out and does not reuse a token
or Pro cache when a different server is selected. Network errors shown in the
app no longer contain developer commands or internal hostnames.

- Full `npm test` and `npm run test:account` passed after this fix.
- `node scripts/test-account-service-native.js --resources=<built resources>`
  passed two actual `app.asar` launches with an empty account profile: initial
  service selection, then a normal restart without an environment override.
  Both reached Google sign-in discovery through the real preload and main IPC.
- Public release checks now require the production HTTPS health and Google
  discovery endpoints. The check currently fails as expected on DNS, and runs
  before both the release command and tagged CI publication. It does not
  replace real Google consent and email-delivery testing after deployment.
