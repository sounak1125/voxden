# App themes

Settings → Display → App theme offers **Voxden** and **White**. Voxden remains
the default. The existing settings file stores `appTheme`; only `white` opts
into White, and missing or unknown values resolve to `voxden`.

## Rendering

- `app-theme.js` normalizes the preference, supplies native window colors, and
  applies `data-app-theme` before styles load.
- The dashboard preload reads the saved theme through the read-only
  `app-theme-get` IPC. `createHistoryWindow` uses the same preference for the
  initial window background and Windows caption colors.
- `app-theme-ui.js` handles accessible radio cards and serializes saves. A
  failed write restores the last confirmed choice and displays an error.
- A theme-only save updates native chrome and sends `app-theme-changed`. It
  does not rebuild history, call recording controls, or broadcast overlay state.
- `theme.css` owns shared palette tokens. `app-theme.css` adapts page treatments
  and the selector. Use `--action-fill` for mint button fills and `--accent` for
  readable green text and indicators; they differ in White.
- Pro upgrades, plan cards and account badges retain gold in both themes.
  Use `--pro-fill` / `--pro-ink` for gold actions and `--pro-accent` for text;
  White uses darker gold text and a pale champagne `--pro-surface`.
- Only monochrome GitHub, Cursor and Notion marks swap to their `-ink.svg`
  variants. Their original SVG geometry and bubble elements are preserved.

Classic, Ribbon and Orb remain independent of the app theme. Display previews
retain their original palette, and capture overlays do not load the app theme
bootstrap. Automatic operating-system theme matching is intentionally deferred.

## Verification

Run `npm run test:app-theme`. The suite uses temporary profiles and covers saved
startup, native caption changes, rollback, rapid/keyboard choices, readable
text and control colors, compact/scaled layouts, stable scroll and animation
nodes, sidebar resizing, and simulated active recording HUDs for all three bars.
It never requests a real microphone or changes the user's account.

For a visual review, run
`electron scripts/test-app-theme-ui.js --screenshots`. Screenshots and a contrast
report are written under the ignored `temp/theme-review/` directory.
