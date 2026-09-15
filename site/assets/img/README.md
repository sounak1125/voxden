# Website images

## Product screenshots

Captured from the real app — `src/app.html` and `src/overlay.html` loaded into
offscreen Electron windows over the real preload bridge, with a scripted
snapshot standing in for the main process. Nothing here is a mockup, and no
account, engine or microphone is touched while they are taken.

Everything is PNG, dark theme (the only theme Voxden ships), rendered at a
device scale factor of 2, so each full-window file is exactly twice its CSS
size.

### Full windows

| File | Pixels | CSS size | Notes |
| --- | --- | --- | --- |
| `dashboard-dictation.png` | 2400 × 1560 | 1200 × 780 | Dictation page: greeting, the "Your thoughts, in writing." hero, stats, recent dictations, voice profile. Sidebar expanded. Display name is a stand-in, "Sam". |
| `dashboard-dictionary.png` | 2400 × 1560 | 1200 × 780 | Dictionary page with seven entries — four saved words and three corrections learned from dictations. |
| `dashboard-writing-style.png` | 2400 × 1560 | 1200 × 780 | Writing style page, Work context selected with its Casual tone, and the live preview card showing that tone applied to the sample sentence. |
| `dashboard-insights.png` | 2400 × 1560 | 1200 × 780 | Insights page, "Your usage" tab, All time range: words, dictations, streak, the milestone timeline, pace, time saved and fix counts. |
| `signin-gate.png` | 2400 × 1560 | 1200 × 780 | The `#signin-gate` dialog with Google offered and the email fallback below, over the blurred Dictation page. |
| `flow-bar-recording.png` | 404 × 168 | 202 × 84 | The flow bar overlay recording, waveform shaped by a synthetic level. **Transparent background** (RGBA). |
| `flow-bar-idle.png` | 404 × 168 | 202 × 84 | The same overlay idle and at rest. **Transparent background** (RGBA). |

The two flow bar images share one crop box — the recording pill plus 24 px of
padding — so they are interchangeable in a layout. The pill morphs between
shapes and is anchored along its bottom edge, which is why the idle capsule
sits low in the frame rather than centred: that is where it actually is on
screen when the recording pill collapses.

### Content-panel crops

The product tour shows the page rather than the window chrome around it, so the
script also cuts each dashboard shot down to the content panel: everything
right of the sidebar and below the title bar.

| File | Pixels |
| --- | --- |
| `dashboard-dictation-panel.png` | 1925 × 1245 |
| `dashboard-dictionary-panel.png` | 1925 × 1245 |
| `dashboard-writing-style-panel.png` | 1925 × 1245 |
| `dashboard-insights-panel.png` | 1925 × 1245 |

All four share one crop box, so the site can swap one for another without the
frame moving: device pixels 439, 132 to 2364, 1377 of the 2400 × 1560 capture —
.183 and .085 of the way in from the left and top edges, .985 and .883 across.
The box lives as `PANEL` in the capture script; change it there and all four
follow.

### Regenerating

From the repo root:

```
npx electron scripts/capture-site-shots.js
```

or, without npx:

```
node_modules\.bin\electron scripts\capture-site-shots.js
```

It runs in its own throwaway Electron profile, so it does not disturb an
installed Voxden or a `npm start` dev instance, and it overwrites only the
eleven files above. It prints each file with its pixel size and whether it kept
an alpha channel, and exits non-zero if the renderer logged an error or a state
failed to appear.

To change what the shots contain — the display name, the sample dictations, the
dictionary terms, the selected writing tone, the voice profile percentage —
edit the snapshot at the top of `scripts/capture-site-shots.js` and run it
again.

The Insights page is the one view that is not drawn from that base snapshot.
Every figure on it — pace, time saved, the streak, the seventeen-week heatmap,
the app leaderboard, the fix counts — is computed by `src/insights.js` from the
entry list, and the six hand-written dictations that make the Dictation feed
read well leave those cards near-empty. So the script generates twelve weeks of
history from a seeded generator (`INSIGHT_APPS` / `INSIGHT_ENTRIES`) and
broadcasts it for that one capture only. The seed is fixed, so two runs on the
same day give byte-identical history and a run on another day only slides it
along the calendar. The Dictation shot never sees any of it.

## Brand assets

`icon.png` and `logo.svg` are brand art, not screenshots. They are not produced
by the capture script; see the brand asset pipeline notes before replacing them.
