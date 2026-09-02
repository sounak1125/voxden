'use strict';

// The flow bar can be dragged anywhere now, including onto a monitor that may
// not be there next time the app starts. Everything in src/flow-bar.js exists
// so that a saved position can never leave the bar somewhere the user cannot
// see it -- which is the bug class this guards.

const fs = require('fs');
const path = require('path');
const flowBar = require('../src/flow-bar');

let failed = 0;
function check(name, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  if (g !== e) {
    failed += 1;
    console.error('FAIL', name, '\n  expected', e, '\n  got     ', g);
  } else {
    console.log('ok', name);
  }
}

const SIZE = { width: 260, height: 84 };

function display(id, x, y, width, height, taskbar) {
  const bar = taskbar === undefined ? 48 : taskbar;
  return {
    id,
    bounds: { x, y, width, height },
    workArea: { x, y, width, height: height - bar },
  };
}

// A laptop screen with a second monitor to its left, which is where a
// right-to-left desktop puts negative coordinates into play.
const PRIMARY = display(1, 0, 0, 1920, 1080);
const LEFT = display(2, -1920, 0, 1920, 1080);
const DISPLAYS = [PRIMARY, LEFT];

// --- Anchors are only anchors once they hold two real numbers ---------------

check('a missing anchor is not one', flowBar.normalizeAnchor(null), null);
check('a stringly anchor is not one', flowBar.normalizeAnchor({ x: 'left', y: 4 }), null);
check('a NaN anchor is not one', flowBar.normalizeAnchor({ x: NaN, y: 4 }), null);
check('a whole anchor survives', flowBar.normalizeAnchor({ x: 10.4, y: -3.5 }), { x: 10, y: -3 });

// --- The window hangs off the anchor, not the other way round ---------------

check('the window hangs above and either side of the anchor',
  flowBar.rectFor({ x: 500, y: 900 }, SIZE),
  { x: 370, y: 816, width: 260, height: 84 });

check('anchorFor is rectFor run backwards',
  flowBar.anchorFor(flowBar.rectFor({ x: 500, y: 900 }, SIZE)),
  { x: 500, y: 900 });

// This is why the anchor exists at all: the overlay window grows while a
// success line is being edited, and the bar must not walk up the screen when
// it does.
const idleRect = flowBar.rectFor({ x: 500, y: 900 }, SIZE);
const editRect = flowBar.rectFor({ x: 500, y: 900 }, { width: 380, height: 110 });
check('a resize leaves the bar where it was',
  [idleRect.y + idleRect.height, editRect.y + editRect.height],
  [900, 900]);

// --- Default placement matches where the bar has always been ----------------

check('the default is the primary display, bottom centre',
  flowBar.defaultAnchor(PRIMARY.workArea, SIZE),
  { x: 960, y: 1028 });

check('no saved anchor means the default',
  flowBar.resolveAnchor(null, DISPLAYS, PRIMARY, SIZE),
  flowBar.defaultAnchor(PRIMARY.workArea, SIZE));

check('junk in settings means the default',
  flowBar.resolveAnchor({ x: 'yes' }, DISPLAYS, PRIMARY, SIZE),
  flowBar.defaultAnchor(PRIMARY.workArea, SIZE));

// --- A position on a second monitor is kept, not recentred ------------------

check('a second-monitor position is honoured',
  flowBar.resolveAnchor({ x: -960, y: 1000 }, DISPLAYS, PRIMARY, SIZE),
  { x: -960, y: 1000 });

check('a position over the taskbar is lifted off it',
  flowBar.resolveAnchor({ x: 960, y: 1080 }, DISPLAYS, PRIMARY, SIZE),
  { x: 960, y: 1032 });

check('a drop half off the left edge is pulled back on',
  flowBar.resolveAnchor({ x: -1900, y: 900 }, DISPLAYS, PRIMARY, SIZE),
  { x: -1790, y: 900 });

check('a drop half off the right edge is pulled back on',
  flowBar.resolveAnchor({ x: 1915, y: 900 }, DISPLAYS, PRIMARY, SIZE),
  { x: 1790, y: 900 });

check('a drop above the top has the window pushed down onto it',
  flowBar.resolveAnchor({ x: 960, y: 10 }, DISPLAYS, PRIMARY, SIZE),
  { x: 960, y: 84 });

// --- The monitor that went away ---------------------------------------------
// The whole point of resolving through the live display list: a saved point
// that now sits in dead space has to come back somewhere visible.

check('a position on an unplugged monitor comes back onto a real one',
  flowBar.resolveAnchor({ x: -960, y: 1000 }, [PRIMARY], PRIMARY, SIZE),
  { x: 130, y: 1000 });

check('the anchor picks the display it is nearest to',
  flowBar.displayForPoint(DISPLAYS, { x: -50, y: 500 }).id, 2);
check('a point inside a display picks that display',
  flowBar.displayForPoint(DISPLAYS, { x: 50, y: 500 }).id, 1);
check('a point in dead space still picks a display',
  flowBar.displayForPoint(DISPLAYS, { x: 99999, y: 99999 }).id, 1);

// A display smaller than the overlay window has no legal position for it.
// Clamping to a bound that has crossed over its opposite would put the bar
// off screen in the other direction, which is worse than not clamping at all.
const TINY = display(3, 0, 0, 200, 60, 0);
check('a display smaller than the bar pins it rather than inverting',
  flowBar.resolveAnchor({ x: 5000, y: 5000 }, [TINY], TINY, SIZE),
  { x: 130, y: 84 });

check('sameAnchor compares by value', flowBar.sameAnchor({ x: 1, y: 2 }, { x: 1, y: 2 }), true);
check('sameAnchor sees a difference', flowBar.sameAnchor({ x: 1, y: 2 }, { x: 1, y: 3 }), false);
check('sameAnchor handles nothing', flowBar.sameAnchor(null, null), true);

// --- The wiring the geometry is useless without ------------------------------

const SRC = path.join(__dirname, '..', 'src');
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const overlaySrc = fs.readFileSync(path.join(SRC, 'overlay.js'), 'utf8');
const overlayHtml = fs.readFileSync(path.join(SRC, 'overlay.html'), 'utf8');
const overlayCss = fs.readFileSync(path.join(SRC, 'overlay.css'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(SRC, 'preload.js'), 'utf8');

// positionOverlay used to read screen.getPrimaryDisplay() directly, which is
// what pinned the bar to one monitor no matter what the user wanted.
check('the overlay is placed from the saved anchor',
  /function positionOverlay\(\)[\s\S]{0,400}flowBar\.rectFor\(overlayAnchor\(size\), size\)/.test(mainSrc), true);
check('a drag owns the position while it runs',
  /function positionOverlay\(\)[\s\S]{0,200}if \(overlayDrag\) return;/.test(mainSrc), true);
check('the landing is persisted', /settings\.flowBarAnchor = landed;/.test(mainSrc), true);
check('the landing is clamped before it is saved',
  /const landed = flowBar\.resolveAnchor\([\s\S]{0,12}flowBar\.anchorFor\(/.test(mainSrc), true);
// A window's bounds do not round-trip on a scaled display: setPosition rounds
// into device pixels and getBounds rounds back out. A gesture that both read
// and wrote its own position would accumulate that error into a visible drift,
// so it has to stay in the coordinates main chose.
// The comments in that span name getBounds() on purpose, so only the code counts.
const codeOf = block => block.split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join(' ');
const dragPath = /function overlayDragTick\(\)[\s\S]*?function resetFlowBarPosition/.exec(mainSrc);
check('the drag never measures the window back',
  !!dragPath && !codeOf(dragPath[0]).includes('getBounds()'), true);
check('the drag remembers where it put the window',
  !!dragPath && /overlayDrag\.x = x;/.test(dragPath[0]), true);
// setPosition() re-sends the size it read back from the window, and that
// read-back grows on a scaled display: 260x84 comes back a little larger, gets
// set to that, and comes back larger again. Sixty of those a second grew the
// overlay by roughly 48x48 per second of dragging, and because the bar is
// bottom-aligned inside the window, a taller window slid it steadily down the
// screen. Nothing may place the window without pinning its size.
check('nothing places the overlay by its corner alone',
  !/overlayWin\.setPosition\(/.test(mainSrc), true);
check('the overlay size is pinned every time it is placed',
  /function placeOverlay\(rect\)[\s\S]{0,320}setBounds\(\{ x: rect\.x, y: rect\.y, width: rect\.width, height: rect\.height \}\)/.test(mainSrc), true);
// A window back from hide() takes no mouse-down until it is resized, so the
// show path has to nudge it -- through placeOverlay, so the size stays pinned.
check('a re-shown overlay is nudged so clicks reach it again',
  /showInactive\(\);\s*rearmOverlayInput\(\);/.test(mainSrc)
  && /function rearmOverlayInput\(\)[\s\S]{0,400}height: rect\.height \+ 1 \}\);\s*placeOverlay\(rect\);/.test(mainSrc), true);
check('one function owns the overlay rect',
  (mainSrc.match(/overlayWin\.setBounds\(/g) || []).length === 1 && !/overlayWin\.setSize\(/.test(mainSrc), true);
check('a still hand costs nothing',
  !!dragPath && /if \(x === overlayDrag\.x && y === overlayDrag\.y\) return;/.test(dragPath[0]), true);
check('a drag that never ends is cut loose',
  /DRAG_MAX_MS[\s\S]{0,120}stopOverlayDrag\(true\)/.test(mainSrc), true);
check('the anchor is normalized on load', mainSrc.includes('flowBar.normalizeAnchor(settings.flowBarAnchor)'), true);

// Monitors arriving and leaving is exactly when a saved position stops making
// sense, and display-metrics-changed does not fire for either.
check('a monitor arriving reflows the bar', mainSrc.includes("screen.on('display-added', scheduleOverlayReflow)"), true);
check('a monitor leaving reflows the bar', mainSrc.includes("screen.on('display-removed', scheduleOverlayReflow)"), true);
check('metrics changes reflow the bar', mainSrc.includes("screen.on('display-metrics-changed', scheduleOverlayReflow)"), true);

// The three ways the bar used to go missing and stay missing.
check('a bar that should be visible is put back',
  /function ensureOverlayVisible\(\)[\s\S]{0,900}showOverlay\(\);/.test(mainSrc), true);
// It runs on a twice-a-second poll, so a show that does not take must not turn
// a missing bar into a permanent burn of tray rebuilds and IPC.
check('the rescue backs off if showing does not take',
  /function ensureOverlayVisible\(\)[\s\S]{0,900}OVERLAY_RESCUE_MS\) return;/.test(mainSrc), true);
check('the visibility check runs on the in-process tick',
  /function startHwndPoll\(\)[\s\S]{0,1200}ensureOverlayVisible\(\);/.test(mainSrc), true);
// The foreground window used to be read by starting a powershell.exe twice a
// second, each of which compiled the helper class first. One long-lived
// watcher replaces that; a per-tick process start must not come back.
check('the foreground window comes from one long-lived watcher',
  mainSrc.includes("'-Action', 'foreground-watch'")
    && /function launchForegroundWatch\(\)/.test(mainSrc), true);
check('no tick starts a process to read the foreground window',
  /setInterval\((?:async )?\([^)]*\) => \{[\s\S]{0,600}ps\(\['get'\]\)/.test(mainSrc), false);
check('the fallback poll cannot overlap itself',
  mainSrc.includes('if (foregroundWatch || foregroundFallbackBusy || isQuitting) return;')
    && /finally\s*\{\s*foregroundFallbackBusy = false;/.test(mainSrc), true);
check('a foreground change during a dictation does not move the paste target',
  /function adoptForegroundHwnd\(hwnd\)[\s\S]{0,500}if \(mode === 'arming' \|\| mode === 'recording' \|\| mode === 'transcribing'\) return;/.test(mainSrc), true);
check('the bar reclaims the top when the foreground changes',
  /if \(hwnd !== lastHwnd\)[\s\S]{0,200}raiseOverlay\(\);/.test(mainSrc), true);
check('only the overlay may hide the overlay',
  /ipcMain\.on\('hud-hidden'[\s\S]{0,260}e\.sender !== overlayWin\.webContents/.test(mainSrc), true);
check('the idle reset goes through the one placement function',
  /overlayEditing = false;[\s\S]{0,260}positionOverlay\(\);/.test(mainSrc), true);

// Dictation goes to the window that had focus, never to the bar. Nothing in
// the drag path may focus or activate the overlay, or the paste target moves
// to whatever the user was last looking at.
const dragBlock = /function startOverlayDrag\(\)[\s\S]*?\n}/.exec(mainSrc);
check('starting a drag never focuses the overlay',
  !!dragBlock && !/\.focus\(\)|setFocusable\(true\)/.test(dragBlock[0]), true);
check('the overlay is still filtered out of the paste target',
  /function isOurHwnd[\s\S]{0,200}hwnd === overlayHwnd/.test(mainSrc), true);

// Renderer half of the gesture.
check('the grip is in the markup', overlayHtml.includes('id="flow-drag"'), true);
check('the gear is in the markup', overlayHtml.includes('id="flow-settings"'), true);
check('the grip starts a drag', /dragHandle\.addEventListener\('pointerdown', beginFlowDrag\)/.test(overlaySrc), true);
// A hotkey can start a dictation with the grip still held, and the recording
// pill has no grip to let go of.
check('leaving idle drops the bar', /if \(next !== 'idle'\) \{[\s\S]{0,20}endFlowDrag\(\);/.test(overlaySrc), true);
check('a non-idle state ends the drag in main',
  /if \(extra && extra\.mode && extra\.mode !== 'idle'\) stopOverlayDrag\(true\);/.test(mainSrc), true);
// moveTop() re-sends a position on Windows and can walk the bar sideways on a
// scaled display; the re-assert must stay a pure z-order change.
check('reclaiming the top does not move the bar',
  /function raiseOverlay\(\)[\s\S]{0,400}setAlwaysOnTop\(true, 'screen-saver'\)/.test(mainSrc), true);
check('a lost capture still ends the drag', overlaySrc.includes("window.addEventListener('pointerup', endFlowDrag)"), true);
check('hover polling is ignored mid-drag',
  /function onCursor\(pos\)[\s\S]{0,320}if \(dragging\) return;/.test(overlaySrc), true);
check('the bar stays expanded mid-drag', /const expanded = [^\n]*\|\| dragging;/.test(overlaySrc), true);
check('the mouse stays captured mid-drag', /const capture = overInteractive \|\| dragging \|\| isActiveHud\(\);/.test(overlaySrc), true);
check('a click on the gear does not also dictate',
  /function onIdleDictate[\s\S]{0,400}closest\('\.flow-side'\)\) return;/.test(overlaySrc), true);
check('the gear opens settings', overlaySrc.includes('window.voxden.overlaySettings()'), true);
check('the bridges exist', ['overlayDragStart', 'overlayDragEnd', 'overlaySettings', 'resetFlowBar']
  .every((k) => preloadSrc.includes(k + ':')), true);

// The hover target has to reach the two new buttons, or they appear and then
// vanish the moment the cursor leaves the bar itself.
const stayW = /const HOVER_STAY_W = (\d+);/.exec(overlaySrc);
const enterW = /const HOVER_ENTER_W = (\d+);/.exec(overlaySrc);
check('there is a wider zone to stay inside', !!stayW && !!enterW && Number(stayW[1]) > Number(enterW[1]), true);
// The stay rect has to strictly contain the enter rect. If it did not, an edge
// would exist that is simultaneously outside one and inside the other, and the
// cursor sitting on it would open and close the bar every poll.
const stayH = /const HOVER_STAY_H = (\d+);/.exec(overlaySrc);
const enterHH = /const HOVER_ENTER_H = (\d+);/.exec(overlaySrc);
check('the stay zone contains the enter zone',
  !!stayH && !!enterHH && Number(stayH[1]) >= Number(enterHH[1]) && Number(stayW[1]) >= Number(enterW[1]), true);
// gear/grip sit 21px off centre and are 24px wide, so the cluster reaches 45px
// out; the stay zone is measured from the centre too, hence the halving.
check('the stay zone reaches past the buttons', !!stayW && Number(stayW[1]) / 2 >= 45, true);

// --- Finish -----------------------------------------------------------------
// The capsule is sized by its contents, so the whole morph is only as smooth as
// its widest term. Everything below is a way for one of those terms to move in
// a step while the others ease, which is what "not smooth" looked like from the
// outside. The real proof is in test-flow-bar-ui.js, which samples the morph
// frame by frame; these guard the shapes that made it possible.
check('the capsule sizes itself', overlayCss.includes('interpolate-size: allow-keywords'), true);
check('no JS pins the pill width any more', !/pill\.style\.width/.test(overlaySrc), true);
check('the pill still transitions its width', /transition:[\s\S]{0,200}width var\(--morph\)/.test(overlayCss), true);
// `none` and `flex` are not a size, so a chip hidden that way changes the row's
// measurement in a step -- and `auto` to `auto` is not a change at all, so the
// capsule got no transition to carry it and simply teleported.
check('no content is hidden by removing it from the row',
  !/display: none/.test(overlayCss), true);
check('a hidden chip collapses instead',
  /\.glyph-error \{[\s\S]{0,120}width: 0;/.test(overlayCss), true);
check('nor does the JS take the line out of the row',
  !/label\.style\.display/.test(overlaySrc) && /has-line/.test(overlaySrc), true);
const pillRule = /^\.pill \{[\s\S]*?^\}/m.exec(overlayCss);
check('a hidden chip is charged no gap',
  !!pillRule && /^  gap: 0;$/m.test(pillRule[0])
    && /margin-inline: calc\(var\(--chip-gap\) \/ 2\)/.test(overlayCss), true);
// max() of two curves that cross has a kink in it, whichever way they are eased.
check('neither dots state sizes itself with a minimum',
  /\.pill\.arming \{[\s\S]{0,160}min-width: 0;/.test(overlayCss)
    && /\.pill\.transcribing \{[\s\S]{0,160}min-width: 0;/.test(overlayCss), true);
check('the mic keeps one positioning layer in every state',
  /\.glyph-mic \{[\s\S]{0,120}position: absolute;/.test(overlayCss)
    && !/\.glyph-mic \{[\s\S]{0,400}display: none;/.test(overlayCss), true);
// A percentage resolves against a width that is itself mid-morph, so blending
// one with a pixel value sends the mic on a detour and back.
check('the mic is offset in pixels, never a percentage',
  /--mic-left: \d/.test(overlayCss) && !/var\(--mic-left, 50%\)/.test(overlayCss), true);
check('the active mic moves on the shared morph curve',
  /left var\(--morph\) var\(--spring\)/.test(overlayCss), true);
check('the target state is applied before the entrance',
  /if \(revealAfterState\) popIn\(\);/.test(overlaySrc), true);

// The two marks are controls, and a bare glyph on a dark fill looks like neither
// a control nor a finished piece of design.
const actRule = /\.act \{[\s\S]*?^\}/m.exec(overlayCss);
check('the marks sit in a circle', !!actRule && /border-radius: 50%/.test(actRule[0]), true);
// The rim is an inset shadow because a border has a floor: sub-pixel widths
// snap up to one device pixel, so a chip collapsing to nothing held three of
// them open until the last frame of the morph and then dropped them at once.
check('the circle is drawn, not just on hover',
  !!actRule && /inset 0 0 0 1px rgba/.test(actRule[0]) && /background: rgba/.test(actRule[0]), true);
check('the circle costs the row no width when collapsed',
  !!actRule && /border: 0;/.test(actRule[0]), true);
check('a mark that is fading out takes no clicks',
  !!actRule && /pointer-events: none/.test(actRule[0]), true);
check('a shown mark does take clicks',
  /\.pill\.recording \.act-cancel[\s\S]{0,220}pointer-events: auto;/.test(overlayCss), true);
// A flat fill with a hairline rim reads as a sticker; depth is what stops it.
check('the pill has elevation', /\.pill \{[\s\S]*?box-shadow:[\s\S]{0,8}0 5px 12px/.test(overlayCss), true);
check('the pill has a lit edge', overlayCss.includes('.pill::before'), true);
const barRule = /body\.always-flow:not\(\.flow-expanded\):not\(\.flow-face\) \.pill\.idle \{[\s\S]*?\}/.exec(overlayCss);
check('the resting bar keeps neither', !!barRule && /box-shadow: none;/.test(barRule[0]), true);

const barHeight = barRule && /height: (\d+)px;/.exec(barRule[0]);
check('the resting bar is thicker than it was', !!barHeight && Number(barHeight[1]) > 4, true);
const enterH = /const HOVER_ENTER_H = (\d+);/.exec(overlaySrc);
check('the enter zone still covers the thicker bar',
  !!enterH && !!barHeight && Number(enterH[1]) >= Number(barHeight[1]) + 10, true);

if (failed) {
  process.exitCode = 1;
  console.error(failed + ' test(s) failed');
} else {
  console.log('All flow-bar tests passed.');
}
