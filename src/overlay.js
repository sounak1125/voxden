'use strict';

const pill = document.getElementById('pill');
const label = document.getElementById('label');
const btnCancel = document.getElementById('btn-cancel');
const btnConfirm = document.getElementById('btn-confirm');
const btnUndo = document.getElementById('btn-undo');
const orbTrigger = document.getElementById('orb-trigger');
const orbFinish = document.getElementById('orb-finish');
const orbDiscard = document.getElementById('orb-discard');
const dragHandle = document.getElementById('flow-drag');
const settingsBtn = document.getElementById('flow-settings');
const captureScreenBtn = document.getElementById('flow-capture');
const waveStrip = document.getElementById('wave');
const waveBars = Array.from(document.querySelectorAll('#wave i'));

let capturing = false;
let mediaStream = null;
let audioCtx = null;
let analyser = null;
let processor = null;
let captureSink = null;
let captureWatch = 0;
let sourceNode = null;
let pcmChunks = [];
let inputSampleRate = 48000;
let raf = 0;
let recognition = null;
let webText = '';
let webResultIndex = 0;
let engine = 'webspeech';
let engineStatus = 'starting';
// Main says so when the next clip goes to the cloud first; the local model's
// state is then not what the user is waiting on.
let cloudReady = false;
// Fixed for one recording: cloud phrases are recognized during natural pauses.
let cloudCapture = false;
let stopRequested = false;
let hideToken = 0;
let hideFallback = 0;
let alwaysShowFlowBar = false;
let flowBarStyle = 'island';
let pendingFlowBarStyle = null;
let hudMode = 'idle';
let overInteractive = false;
let ignoreMouse = null;
let enterTimer = 0;
let soundsEnabled = true;
let shortcutLabel = 'Ctrl+Shift+Space';
// Push to talk that was tapped rather than held stays on until the next press.
let pttLocked = false;

function recordingTitle(dictateMode) {
  return dictateMode === 'ptt' && !pttLocked
    ? 'Release ' + shortcutLabel + ' to finish'
    : 'Press ' + shortcutLabel + ' again to finish';
}
let micDeviceId = 'default';
let sfxCtx = null;
let dragging = false;
let dragPointerId = null;
// The element holding pointer capture for the drag in progress: Orb's grip, or
// Island's capsule itself.
let dragCapture = null;
// An Island press on the capsule that may still become a drag, and whether the
// current gesture already has (see "Dragging by the bar").
let barPress = null;
let barDragged = false;
// Island's gear and screenshot sit inside the capsule, so a press that starts
// on one and is released on the capsule clicks their common parent: the bar.
let pressOnSide = false;
// Hover target, in window coordinates. Fixed rects rather than the pill's own
// box: the pill resizes when it expands, and measuring it would move the edge of
// the hot zone under the cursor and flicker.
//
// The enter rect hugs the resting bar so the controls only appear when you are
// actually on it. Once open, a horizontal rect covers Island's whole capsule --
// settings, mic and screenshot all live inside it -- or connects Orb's sphere
// to its gear and grip, and for Orb a narrow vertical rect reaches the
// screenshot above it. These overlapping paths keep the controls open as the
// cursor moves between them without capturing clicks in the empty upper
// corners of the window.
//
// The stay region strictly contains the enter rect, which keeps this from
// oscillating: crossing an edge can only ever be entering the larger one or
// leaving it, never both in the same frame.
const HOVER_ENTER_W = 62;    // stable target well wider than Island's 36px rest pill
const HOVER_STAY_W = 114;    // Island's 104px capsule, or Orb's gear and grip, with slack
const HOVER_ENTER_H = 26;    // the rest pill is 10 tall, sitting HOVER_BOTTOM off the floor
const HOVER_STAY_H = 46;     // must cover the open 32px capsule
const HOVER_CAPTURE_W = 38; // Orb: 24px screenshot with 7px of slack on each side
const HOVER_CAPTURE_H = 78; // Orb: reaches 6px above the screenshot, plus 4px more
const HOVER_BOTTOM = 10;     // gap from the zone's floor to the window edge

let canRetry = false;
let dictationQuality = 'auto';
let successEntryId = '';
let lastSuccessText = '';
let editingSuccess = false;
let cancelSuccessEdit = false;
let learnedUndoToken = '';
let learnedUndoPending = false;
let learnedHovered = false;
let learnedHeld = false;
const OUT_RATE = 16000;
const MIN_SLICE_SEC = 0.3;
const MIN_SLICE_SAMPLES = Math.round(MIN_SLICE_SEC * OUT_RATE);

let captureGen = 0;
let dsPcmChunks = [];
let chunker = null;
let chunkJobs = [];
// The audio of each committed slice, kept so a boundary that could not be
// stitched from text alone can be re-recognised from the recording that
// crosses it. Dropped with the rest of the chunk state at the end of every
// dictation; nothing here outlives the utterance.
let chunkSlices = [];

// The cue's output device is opened once, while nothing is happening, rather
// than on the first dictation -- where it used to sit between the microphone
// coming up and the waveform appearing.
function ensureSfxContext() {
  if (sfxCtx) return sfxCtx;
  try {
    sfxCtx = new AudioContext();
  } catch (_) {
    sfxCtx = null;
  }
  return sfxCtx;
}

function playCue(kind) {
  if (!soundsEnabled) return;
  try {
    const ctx = ensureSfxContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    const freqs = { start: 520, success: 740, error: 220 };
    osc.frequency.value = freqs[kind] || 440;
    osc.type = kind === 'error' ? 'square' : 'sine';
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.07, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'success' ? 0.12 : 0.08));
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.14);
  } catch (_) {}
}

function isActiveHud(mode) {
  const m = mode || hudMode;
  return m === 'arming' || m === 'recording' || m === 'transcribing' || m === 'success' || m === 'error'
    || m === 'cancel' || m === 'learned' || editingSuccess;
}

function inHoverZone(x, y) {
  const offsetX = Math.abs(x - window.innerWidth / 2);
  const bottom = window.innerHeight - HOVER_BOTTOM;
  if (y > bottom) return false;
  const orb = flowBarStyle === 'orb';
  const height = overInteractive ? (orb ? 50 : HOVER_STAY_H) : orb ? 44 : HOVER_ENTER_H;
  if (offsetX <= (overInteractive ? HOVER_STAY_W : HOVER_ENTER_W) / 2 && y >= bottom - height) return true;
  // Only Orb has a screenshot above the bar. Island's is inside the capsule,
  // and the space above it passes clicks through.
  return orb && overInteractive && offsetX <= HOVER_CAPTURE_W / 2 && y >= bottom - HOVER_CAPTURE_H - 4;
}

function setIgnoreMouse(ignore) {
  if (!window.voxden || typeof window.voxden.setIgnoreMouse !== 'function') return;
  if (ignoreMouse === ignore) return;
  ignoreMouse = ignore;
  window.voxden.setIgnoreMouse(ignore);
}

// Island draws settings and the screenshot inside its capsule, so the capsule's
// own clip reveals them as it opens, exactly as it does the microphone. Orb
// shows them beside and above its sphere. They are the same two buttons either
// way and only change parents, which happens with the style itself: at idle,
// while neither is visible.
const flowHit = document.getElementById('flow-hit');
function placeSideControls() {
  if (!settingsBtn || !captureScreenBtn || !flowHit) return;
  const inside = flowBarStyle === 'island';
  if (inside && settingsBtn.parentElement !== pill) {
    pill.append(settingsBtn, captureScreenBtn);
  } else if (!inside && settingsBtn.parentElement === pill) {
    const before = dragHandle && dragHandle.parentElement === flowHit ? dragHandle : pill;
    flowHit.insertBefore(settingsBtn, before);
    flowHit.insertBefore(captureScreenBtn, before);
  }
}

// Island pins its hover controls a fixed distance above the capsule's floor
// (flow-styles.css), so they never ride its height as it opens. Centring a
// 28px control in the 32px capsule takes the rim's real thickness: at a
// fractional display scale Chromium draws the 1px border as one device pixel,
// which is .8 CSS px at 125%. Read once per display scale, so a bar dragged to
// a monitor with other scaling re-centres on its next hover.
let islandFloorScale = 0;
function syncIslandFloor() {
  if (flowBarStyle !== 'island' || islandFloorScale === window.devicePixelRatio) return;
  islandFloorScale = window.devicePixelRatio;
  const rim = parseFloat(getComputedStyle(pill).borderBottomWidth) || 0;
  pill.style.setProperty('--island-floor', Math.max(0, 2 - rim) + 'px');
}

function syncFlowVisual() {
  document.body.dataset.flowStyle = flowBarStyle;
  placeSideControls();
  syncIslandFloor();
  document.body.classList.toggle('always-flow', alwaysShowFlowBar);
  // Gates the screenshot, gear and grip: other pill states grow into their
  // space, so they only exist alongside the resting bar.
  document.body.classList.toggle('flow-idle', hudMode === 'idle');
  const expanded = !alwaysShowFlowBar || hudMode !== 'idle' || overInteractive || dragging;
  document.body.classList.toggle('flow-expanded', expanded);
  // Island lets an edited result wrap and grow; see flow-styles.css.
  document.body.classList.toggle('flow-editing', editingSuccess);
  const capture = overInteractive || dragging || isActiveHud();
  setIgnoreMouse(!capture);
  syncOrbVisuals();
  syncOrbControls();
}

function syncOrbControls() {
  const orb = flowBarStyle === 'orb';
  const shown = document.body.classList.contains('shown');
  const available = orb && shown;
  const recording = available && hudMode === 'recording';
  document.querySelector('.orb-actions').setAttribute('aria-hidden', String(!recording));
  if (orbTrigger) {
    orbTrigger.disabled = !available || (hudMode !== 'idle' && hudMode !== 'recording');
    orbTrigger.tabIndex = orbTrigger.disabled ? -1 : 0;
    orbTrigger.title = recording ? 'Finish and transcribe · Esc to discard' : 'Start dictation';
    orbTrigger.setAttribute('aria-label', recording ? 'Finish recording and transcribe' : 'Start dictation');
  }
  for (const action of [orbFinish, orbDiscard]) {
    if (!action) continue;
    action.disabled = !recording;
    action.tabIndex = recording ? 0 : -1;
  }
  // The shared retry controls are still used for outcomes, but the Orb's
  // recording actions live beneath the sphere instead of in the old chips.
  const sharedRecording = shown && !orb && hudMode === 'recording';
  const retryOutcome = (hudMode === 'success' || hudMode === 'error') && canRetry;
  const retry = shown && retryOutcome;
  // A preference can discard retained audio while the result is still open.
  // Refresh these controls without replaying the result or its editable text.
  pill.classList.toggle('can-retry', retryOutcome);
  if (btnCancel) btnCancel.tabIndex = sharedRecording ? 0 : -1;
  if (btnConfirm) {
    btnConfirm.tabIndex = sharedRecording || retry ? 0 : -1;
    btnConfirm.title = retryOutcome ? 'Retry last dictation' : 'Stop and transcribe';
    btnConfirm.setAttribute('aria-label', retryOutcome ? 'Retry last dictation' : 'Stop recording and transcribe');
  }
}

function applyFlowBarStyle(value) {
  // Island replaced Classic (and Ribbon before it). Anything but Orb is Island.
  const next = value === 'orb' ? 'orb' : 'island';
  // A preference update must not move Stop/Cancel or restart the audio meter
  // while someone is dictating. The latest choice takes effect on returning
  // to idle, including when a result is being edited or transcription awaits.
  if (hudMode !== 'idle') {
    pendingFlowBarStyle = next === flowBarStyle ? null : next;
    return;
  }
  pendingFlowBarStyle = null;
  if (flowBarStyle === next) return;
  barPress = null;
  resetOrbParticles();
  if (flowBarStyle === 'orb') resetOrbPresentation();
  flowBarStyle = next;
  syncFlowVisual();
}

// Hover comes from the main process polling the OS cursor. DOM mouse events are
// not usable here: the overlay sits in setIgnoreMouseEvents(true, {forward:true})
// most of the time, which forwards mousemove but never delivers mouseleave, so
// any hover flag set from mousemove would latch on forever.
function onCursor(pos) {
  // While the bar is being carried the window is chasing the cursor, so its
  // own idea of where the pointer sits inside it is a frame stale. Acting on
  // that would collapse the bar back to a 6px line mid-drag.
  if (dragging) return;
  // Main decides hover now, with the same rects, and only reports a change.
  // The local test stays as the fallback for an older main process.
  const next = (pos && typeof pos.hover === 'boolean')
    ? pos.hover
    : !!(pos && pos.inside) && inHoverZone(pos.x, pos.y);
  if (next === overInteractive) return;
  overInteractive = next;
  syncFlowVisual();
}

function popIn() {
  if (hideFallback) {
    clearTimeout(hideFallback);
    hideFallback = 0;
  }
  document.body.classList.remove('hiding');
  if (document.body.classList.contains('shown')) {
    syncFlowVisual();
    return;
  }
  // Bump the token only when we actually start an entrance. Bumping it on the
  // already-shown path invalidated the pending `done` of the entrance still in
  // flight, so `entering` stuck and left popIn's forwards-fill pinning the
  // pill's opacity/transform. State updates arrive in pairs (reveal + mode),
  // so that path is hit on every single reveal.
  hideToken += 1;
  void pill.offsetWidth;
  document.body.classList.add('shown', 'entering');
  const token = hideToken;
  function done(ev) {
    if (ev && ev.target !== pill) return;
    if (ev && ev.animationName && ev.animationName !== 'popIn') return;
    // A superseded entrance still has to let go of the pill: returning
    // without removing the listener left one dead closure attached per
    // show/hide, and every later animation end ran all of them.
    pill.removeEventListener('animationend', done);
    if (token !== hideToken) return;
    if (enterTimer) {
      clearTimeout(enterTimer);
      enterTimer = 0;
    }
    document.body.classList.remove('entering');
  }
  pill.addEventListener('animationend', done);
  if (enterTimer) clearTimeout(enterTimer);
  enterTimer = setTimeout(() => done(), 420);
  syncFlowVisual();
}

function popOut() {
  // A bar on its way off screen is not being carried any more, whatever the
  // pointer is still doing.
  endFlowDrag();
  stopOrbVisuals();
  resetOrbParticles();
  resetOrbPresentation();
  if (!document.body.classList.contains('shown')) {
    document.body.classList.remove('hiding', 'entering');
    syncOrbControls();
    window.voxden.hudHidden();
    return;
  }
  const token = ++hideToken;
  if (enterTimer) {
    clearTimeout(enterTimer);
    enterTimer = 0;
  }
  // Island's spinner stops while the bar is away; it keeps its step on the
  // way out rather than snapping back.
  if (hudMode === 'transcribing') holdSpinner();
  document.body.classList.remove('shown', 'entering', 'flow-expanded', 'flow-dragging');
  document.body.classList.add('hiding');
  syncOrbControls();
  function finish(ev) {
    if (ev && ev.target !== pill) return;
    pill.removeEventListener('animationend', finish);
    if (token !== hideToken) return;
    if (hideFallback) {
      clearTimeout(hideFallback);
      hideFallback = 0;
    }
    document.body.classList.remove('hiding');
    window.voxden.hudHidden();
  }
  pill.addEventListener('animationend', finish);
  hideFallback = setTimeout(() => finish(), 360);
}

// --- Dragging ---------------------------------------------------------------
// The renderer only reports the two edges of the gesture. Every frame between
// them is the main process following the OS cursor, because that is the only
// coordinate space that stays right as the bar crosses onto another monitor --
// and because this window spends most of its life click-through, where DOM
// mouse events cannot be trusted to arrive at all.
function startFlowDrag(pointerId, handle) {
  if (dragging) return false;
  if (!window.voxden || typeof window.voxden.overlayDragStart !== 'function') return false;
  dragging = true;
  dragPointerId = pointerId === undefined ? null : pointerId;
  dragCapture = handle || null;
  document.body.classList.add('flow-dragging');
  // Capture keeps the release coming back here on the frames where the pointer
  // outruns the window it is dragging.
  try {
    if (dragCapture && dragPointerId !== null) dragCapture.setPointerCapture(dragPointerId);
  } catch (_) {}
  syncFlowVisual();
  window.voxden.overlayDragStart();
  return true;
}

// Orb's grip: a press on it is a drag from the first pixel.
function beginFlowDrag(e) {
  if (dragging || e.button !== 0) return;
  if (!window.voxden || typeof window.voxden.overlayDragStart !== 'function') return;
  e.preventDefault();
  e.stopPropagation();
  startFlowDrag(e.pointerId, dragHandle);
}

function endFlowDrag() {
  // Whatever ends a drag also ends a press that had not become one yet.
  barPress = null;
  if (!dragging) return;
  dragging = false;
  const handle = dragCapture;
  dragCapture = null;
  if (dragPointerId !== null) {
    const id = dragPointerId;
    dragPointerId = null;
    try {
      if (handle && handle.hasPointerCapture && handle.hasPointerCapture(id)) {
        handle.releasePointerCapture(id);
      }
    } catch (_) {}
  }
  document.body.classList.remove('flow-dragging');
  syncFlowVisual();
  if (window.voxden && typeof window.voxden.overlayDragEnd === 'function') {
    window.voxden.overlayDragEnd();
  }
}

// --- Dragging by the bar (Island) ------------------------------------------
// Island has no grip: the capsule itself is the handle, microphone included.
// A press only becomes a drag once the pointer has moved more than
// BAR_DRAG_SLOP px with the button still down, so a press that stays put is
// still the click that dictates. The gear and the screenshot sit inside the
// capsule but never start a drag.
const BAR_DRAG_SLOP = 4;

function armBarPress(e) {
  barPress = null;
  if (e.button !== 0 || e.isPrimary === false || dragging) return;
  if (flowBarStyle !== 'island' || hudMode !== 'idle') return;
  if (!document.body.classList.contains('shown') || document.body.classList.contains('hiding')) return;
  if (e.target && e.target.closest && e.target.closest('.flow-side')) return;
  barPress = { id: e.pointerId, x: e.clientX, y: e.clientY };
}

function followBarPress(e) {
  if (!barPress || e.pointerId !== barPress.id) return;
  // No button down means the release went somewhere else; a later hover must
  // not turn into a drag.
  if (!(e.buttons & 1) || flowBarStyle !== 'island' || hudMode !== 'idle') {
    barPress = null;
    return;
  }
  const dx = e.clientX - barPress.x;
  const dy = e.clientY - barPress.y;
  if (dx * dx + dy * dy <= BAR_DRAG_SLOP * BAR_DRAG_SLOP) return;
  barPress = null;
  // The release that ends this gesture still arrives as a click on the bar,
  // after pointerup has already cleared `dragging`. So the gesture itself is
  // remembered, and onIdleDictate swallows that one click.
  if (startFlowDrag(e.pointerId, pill)) barDragged = true;
}

function releaseOverlayHold() {
  if (window.voxden && typeof window.voxden.overlayRelease === 'function') {
    window.voxden.overlayRelease();
  }
}

function syncLearnedHold() {
  const hold = hudMode === 'learned' && !!learnedUndoToken
    && (learnedHovered || learnedUndoPending || document.activeElement === btnUndo);
  if (hold === learnedHeld) return;
  learnedHeld = hold;
  if (hold) {
    if (window.voxden && typeof window.voxden.overlayHold === 'function') window.voxden.overlayHold();
  } else {
    releaseOverlayHold();
  }
}

function setSuccessEditable(on) {
  if (!label) return;
  if (!on && editingSuccess) commitSuccessEdit();
  label.contentEditable = on ? 'true' : 'false';
  label.spellcheck = false;
  if (!on && document.activeElement === label) label.blur();
}

function beginSuccessEdit() {
  if (hudMode !== 'success' || !successEntryId || editingSuccess) return;
  editingSuccess = true;
  cancelSuccessEdit = false;
  // Island: the wrapped size is known in pixels before the shape moves, and
  // the words take that layout at once, to be revealed as the room opens.
  measureEditLine();
  rewrapLine(true);
  if (window.voxden && typeof window.voxden.overlayHold === 'function') {
    window.voxden.overlayHold();
  }
  setIgnoreMouse(false);
  syncFlowVisual();
}

function commitSuccessEdit() {
  if (!editingSuccess) return;
  try {
    const cancelled = cancelSuccessEdit;
    cancelSuccessEdit = false;
    editingSuccess = false;
    if (cancelled) {
      if (label) label.textContent = lastSuccessText;
      releaseOverlayHold();
      return;
    }
    const next = (label.textContent || '').replace(/\s+/g, ' ').trim();
    if (!next || next === lastSuccessText) {
      if (label) label.textContent = lastSuccessText;
      releaseOverlayHold();
      return;
    }
    lastSuccessText = next;
    if (label) label.textContent = next;
    const id = successEntryId;
    if (window.voxden && id && typeof window.voxden.editEntry === 'function') {
      window.voxden.editEntry(id, next).finally(releaseOverlayHold);
    } else {
      releaseOverlayHold();
    }
  } finally {
    // The kept line is measured before Island's capsule leaves its editing
    // shape, so it settles straight onto the final width. Its words keep the
    // wrapped layout while the room closes around them, and only become one
    // line again once the shape has settled.
    measureLine();
    document.body.classList.remove('flow-editing');
    unwrapLineLater();
  }
}

// --- Island's line -------------------------------------------------------------
// Island sizes its line in pixels (flow-styles.css): the room the line takes
// rides the spring while the words inside sit at their final width, so a line
// is revealed rather than squeezed and never shows a moving ellipsis. A pixel
// width is also what lets one line replace another; `fit-content` before and
// after is no change a transition can see. A line that leaves, changes its
// words or changes its wrap leaves a copy of itself behind -- the twin -- that
// fades out while the new one fades in, so nothing in the line swaps in a
// frame. All of it is Island's; every function here returns early otherwise.
const lineSpacer = document.getElementById('line');
const labelTwin = document.getElementById('label-twin');
const spinnerTurn = document.querySelector('.spinner-turn');
const LINE_EDIT_MAX_W = 300;
const LINE_EDIT_MAX_H = 64; // four lines; a longer edit scrolls inside the line

let lineRulerEl = null;
function lineRuler(wrapped) {
  if (!lineRulerEl) {
    lineRulerEl = document.createElement('span');
    lineRulerEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(lineRulerEl);
  }
  lineRulerEl.className = wrapped ? 'line-ruler wrapped' : 'line-ruler';
  return lineRulerEl;
}

function islandLineShown(mode, hasLine) {
  return mode === 'success' || mode === 'error' || mode === 'cancel' || mode === 'learned'
    || (mode === 'transcribing' && hasLine);
}

// One line's room: the words' own width in the line's own font, plus a pixel,
// because a box a hair narrower than its text trades the last letter for an
// ellipsis.
function measureLine() {
  if (flowBarStyle !== 'island' || !label) return;
  let width = 0;
  if (label.textContent) {
    const ruler = lineRuler(false);
    ruler.textContent = label.textContent;
    width = Math.ceil(ruler.getBoundingClientRect().width) + 1;
    ruler.textContent = '';
  }
  pill.style.setProperty('--island-line', width + 'px');
}

// A line being edited, wrapped at its full width: measured from the label's
// own nodes, so a typed line break counts. A line that fits measures exactly
// what measureLine does, so starting an edit on it moves nothing.
function measureEditLine() {
  if (flowBarStyle !== 'island' || !label) return;
  const ruler = lineRuler(true);
  ruler.replaceChildren(...Array.from(label.childNodes, node => node.cloneNode(true)));
  const box = ruler.getBoundingClientRect();
  ruler.textContent = '';
  const width = Math.min(LINE_EDIT_MAX_W, Math.ceil(box.width) + 1);
  const height = Math.max(16, Math.min(LINE_EDIT_MAX_H, Math.round(box.height)));
  pill.style.setProperty('--island-edit-w', width + 'px');
  pill.style.setProperty('--island-edit-h', height + 'px');
}

// Leave a copy of the line exactly as it looks now -- its words, its wrap, its
// fade, cut to the room it had -- fading out where it is, after `delay` ms.
// Once per change: a commit that happens inside a state change has already
// left the right one. A copy still fading that is at least as bright as the
// line already stands for it, and is left to finish rather than replaced by a
// dimmer one.
let twinFade = null;
let lineReleased = false;
function releaseLine(delay = 0) {
  if (flowBarStyle !== 'island' || !labelTwin || !label || lineReleased) return;
  if (waveMotionPreference.matches || !label.textContent) return;
  const css = getComputedStyle(label);
  const opacity = Number(css.opacity);
  if (!(opacity > .02)) return;
  if (twinFade && Number(getComputedStyle(labelTwin).opacity) >= opacity) return;
  lineReleased = true;
  queueMicrotask(() => { lineReleased = false; });
  const shape = pill.getBoundingClientRect();
  const shapeCss = getComputedStyle(pill);
  const room = lineSpacer.getBoundingClientRect();
  const width = parseFloat(css.width);
  const height = parseFloat(css.height);
  const cutRight = Math.max(0, width - room.width);
  const cutBottom = Math.max(0, height - room.height);
  if (twinFade) twinFade.cancel();
  labelTwin.replaceChildren(...Array.from(label.childNodes, node => node.cloneNode(true)));
  Object.assign(labelTwin.style, {
    left: (room.left - shape.left - parseFloat(shapeCss.borderLeftWidth)) + 'px',
    top: (room.top - shape.top - parseFloat(shapeCss.borderTopWidth)) + 'px',
    width: width + 'px',
    height: height + 'px',
    whiteSpace: css.whiteSpace,
    overflowWrap: css.overflowWrap,
    textOverflow: css.textOverflow,
    color: css.color,
    transform: css.transform,
    transformOrigin: css.transformOrigin,
    clipPath: cutRight || cutBottom ? 'inset(0 ' + cutRight + 'px ' + cutBottom + 'px 0)' : '',
  });
  labelTwin.scrollTop = label.scrollTop;
  const fade = labelTwin.animate([{ opacity }, { opacity: 0 }], { duration: 100, delay, easing: 'ease', fill: 'both' });
  twinFade = fade;
  fade.onfinish = () => {
    if (twinFade !== fade) return;
    twinFade = null;
    labelTwin.textContent = '';
    fade.cancel();
  };
}

// The line's new words dissolve in over the twin on the same beat as any
// entering content; a new wrap, faster and underneath it (see rewrapLine).
let lineRenew = null;
function renewLine(duration = 180, delay = 60) {
  if (flowBarStyle !== 'island' || waveMotionPreference.matches || !label) return;
  stopRenewLine();
  const fade = label.animate({ opacity: [0, 1] }, { duration, delay, easing: 'ease', fill: 'backwards' });
  lineRenew = fade;
  fade.onfinish = () => { if (lineRenew === fade) lineRenew = null; };
}
function stopRenewLine() {
  if (!lineRenew) return;
  lineRenew.cancel();
  lineRenew = null;
}

// An edited line's wrap. It changes only where it cannot reflow the words
// while the shape moves: at the start of an edit, when the wrapped words are
// revealed as the room opens around them, and after it, once the room has
// closed down to one line. Kept on the body, which setHud never rewrites.
let lineWrapTimer = 0;
function wrapLine(on) {
  clearTimeout(lineWrapTimer);
  lineWrapTimer = 0;
  document.body.classList.toggle('line-wrapped', on);
}
function unwrapLineLater() {
  clearTimeout(lineWrapTimer);
  if (!document.body.classList.contains('line-wrapped')) return;
  lineWrapTimer = setTimeout(() => rewrapLine(false), waveMotionPreference.matches ? 0 : 560);
}

// The two layouts of a line differ only where the room cuts it: one line ends
// in an ellipsis there, wrapped words carry on past it. Where they differ the
// new layout fades in under a copy of the old one, and only then does the copy
// fade off it -- so words both layouts share stay lit throughout, and only the
// end of the line dissolves from one to the other.
function rewrapLine(on) {
  const wrapped = document.body.classList.contains('line-wrapped');
  if (wrapped === on) return wrapLine(on);
  let differs = false;
  if (flowBarStyle === 'island' && label && label.textContent) {
    if (on) {
      differs = label.scrollWidth > label.clientWidth + 1;
    } else {
      const words = label.getBoundingClientRect();
      const room = lineSpacer.getBoundingClientRect();
      differs = words.width > room.width + .5 || words.height > room.height + .5;
    }
  }
  if (differs) releaseLine(100);
  wrapLine(on);
  if (differs) renewLine(100, 0);
}

// When the spinner stops turning it keeps the step it was on while it fades,
// instead of snapping back to its first. The next turn overrides this.
function holdSpinner() {
  if (!spinnerTurn || flowBarStyle !== 'island') return;
  const turn = getComputedStyle(spinnerTurn).transform;
  if (turn && turn !== 'none') spinnerTurn.style.transform = turn;
}

function setHud(mode, text) {
  const next = mode || 'idle';
  const previousMode = hudMode;
  if (flowBarStyle === 'orb' && next === 'transcribing' && previousMode !== next) beginOrbProcessing();
  // Leaving idle takes the grip away, so anything still holding it has to let
  // go -- otherwise the bar keeps following the cursor with no way to drop it.
  if (next !== 'idle') {
    endFlowDrag();
  }
  if (next !== 'success') setSuccessEditable(false);
  if (spinnerTurn && flowBarStyle === 'island') {
    if (previousMode === 'transcribing' && next !== 'transcribing') holdSpinner();
    else if (next === 'transcribing' && previousMode !== 'transcribing') spinnerTurn.style.removeProperty('transform');
  }
  hudMode = next;
  if (hudMode !== 'learned') {
    learnedUndoToken = '';
    learnedUndoPending = false;
    learnedHovered = false;
  }
  if (hudMode === 'learned') {
    label.setAttribute('role', 'status');
    label.setAttribute('aria-live', 'polite');
    label.setAttribute('aria-atomic', 'true');
  } else {
    label.removeAttribute('role');
    label.removeAttribute('aria-live');
    label.removeAttribute('aria-atomic');
  }
  // The line's text is settled before the class is written, because the class
  // is what shows it. It used to be an inline display:none/block, which took
  // the line out of the capsule's content in a single frame -- the one thing
  // the capsule cannot follow, since its width is that content.
  const island = flowBarStyle === 'island';
  let nextLine = label.textContent;
  if (text) {
    nextLine = text;
  } else if (hudMode !== 'success' && hudMode !== 'error' && hudMode !== 'recording' && hudMode !== 'transcribing') {
    nextLine = '';
  } else if (island && hudMode === 'transcribing' && previousMode !== 'transcribing') {
    // A retry re-transcribes a kept clip straight from its result, whose line
    // says nothing about the new work; Island lets it go rather than leaving
    // "Transcription failed" beside the spinner.
    nextLine = '';
  }
  // Island keeps a copy of the line it is about to lose or change, fading
  // out, before anything about the line moves.
  const lineWas = island && islandLineShown(previousMode, !!label.textContent);
  const lineStays = island && islandLineShown(hudMode, !!nextLine);
  const lineChanges = nextLine !== label.textContent;
  if (lineWas && (!lineStays || lineChanges)) releaseLine();
  if (text) {
    label.textContent = text;
    if (hudMode === 'success') lastSuccessText = text;
    measureLine();
  } else if (!nextLine && label.textContent) {
    label.textContent = '';
  }
  if (lineWas && lineStays && lineChanges) renewLine();
  else if (!lineStays) stopRenewLine();
  // Only a result being edited, or just edited, wraps.
  if (hudMode !== 'success') wrapLine(false);
  pill.className = 'pill ' + hudMode
    + (label.textContent ? ' has-line' : '')
    + (hudMode === 'learned' && learnedUndoToken ? ' can-undo' : '');
  label.title = hudMode === 'learned' ? label.textContent : '';
  if (btnUndo) {
    const available = hudMode === 'learned' && !!learnedUndoToken;
    btnUndo.disabled = !available || learnedUndoPending;
    btnUndo.tabIndex = available ? 0 : -1;
  }
  syncLearnedHold();
  if (hudMode === 'idle' && pendingFlowBarStyle !== null) applyFlowBarStyle(pendingFlowBarStyle);
  if (hudMode !== 'recording') {
    pill.style.setProperty('--mic', '#ffffff');
    // Duplicate snapshots leave the visual state alone; actual mode changes
    // still clear all recording feedback before the next scene.
    if (flowBarStyle !== 'orb' || previousMode !== hudMode || raf) stopWaveLoop();
  } else {
    startWaveLoop();
  }
  setSuccessEditable(hudMode === 'success' && !!successEntryId);
  syncFlowVisual();
}

// The content-sized states -- recording, success, error -- used to have their
// width measured here and pinned in pixels, because `width: auto` could not be
// transitioned. `interpolate-size: allow-keywords` in overlay.css does that
// natively now, so the capsule grows into its content instead of being told a
// number one frame after the content that decides it has changed. That
// one-frame gap is what the morph looked like from the outside.

function resetChunkState() {
  dsPcmChunks = [];
  chunkJobs = [];
  chunkSlices = [];
  if (chunker && typeof chunker.reset === 'function') chunker.reset();
  chunker = null;
}

function chunkingApi() {
  return globalThis.voxdenChunking || null;
}

function speechGateApi() {
  return globalThis.voxdenSpeechGate || null;
}

function wantsLocalAsr() {
  if (cloudCapture || cloudReady) return true;
  if (engineStatus === 'unavailable') return false;
  return engine === 'whisper'
    || engineStatus === 'standby'
    || engineStatus === 'starting'
    || engineStatus === 'loading'
    || engineStatus === 'ready';
}

function enqueueSlice(pcm, gen) {
  if (!pcm || !pcm.length) return;
  const cloud = cloudCapture;
  if (cloud && speechGateApi()) {
    // A brief final word still counts, including a partial audio frame. Use
    // frame energy rather than isolated noise peaks to avoid transcribing
    // room tone after the last real phrase.
    const gate = speechGateApi();
    const frame = Math.round(OUT_RATE * gate.FRAME_MS / 1000);
    let audible = false;
    for (let start = 0; start < pcm.length; start += frame) {
      if (gate.frameRms(pcm, start, Math.min(start + frame, pcm.length)) >= gate.ACTIVE_RMS) { audible = true; break; }
    }
    if (!audible) return;
  }
  if (cloud && pcm.length < MIN_SLICE_SAMPLES) {
    // Keep a short final word. Pad only the API request to its minimum length.
    const padded = new Float32Array(MIN_SLICE_SAMPLES);
    padded.set(pcm);
    pcm = padded;
  }
  if (pcm.length < MIN_SLICE_SAMPLES) return;
  if (!window.voxden || typeof window.voxden.transcribeLocal !== 'function') return;
  const wav = encodeWav(pcm, OUT_RATE);
  const index = chunkJobs.length;
  chunkSlices.push(pcm);
  // One cloud request at a time prevents a backlog of parallel paid requests.
  // Local recognition retains its existing sidecar queue.
  const preceding = cloud && index ? chunkJobs[index - 1] : Promise.resolve();
  const job = preceding.then(previous => {
    if (gen !== captureGen) throw new Error('Dictation cancelled.');
    if (cloud && previous && !previous.ok) throw previous.error;
    return window.voxden.transcribeLocal(wav, { park: false, vad: false, cloud, segment: cloud });
  })
    .then((text) => ({ gen, ok: true, index, text: String(text || '') }))
    .catch((err) => ({ gen, ok: false, index, error: err }));
  chunkJobs.push(job);
}

// --- Wave rendering ---------------------------------------------------------
// Bars are scaled, never resized. Writing 13 heights per frame relaid out the
// pill sixty times a second, and that relayout is what read as stutter; the
// loop now only touches transform, colour and opacity, none of which are on
// the layout path.
//
// Nothing is painted raw either. A single microphone frame is noisy enough that
// drawing it straight looks like jitter rather than speech, so every value
// chases its target with a fast attack and a slow release -- the same asymmetry
// a compressor uses, and for the same reason.

const WAVE_MIN_SCALE = 3 / 22;      // the floor beneath the listening ripple
const WAVE_MAX_SCALE = 19 / 22;     // room for the soft halo inside the capsule
const WAVE_REST = [205, 211, 218];
const WAVE_LIVE = [244, 247, 250];  // pearl-white light, local to the flow bar
const WAVE_STEPS = 64;
const BAND_COUNT = Math.max(1, Math.ceil(waveBars.length / 2));
const waveMotionPreference = window.VoxdenFlowMotion;
const orbAtmosphere = document.querySelector('.orb-atmosphere');
const orbParticles = Array.from(document.querySelectorAll('.orb-particle'), element => ({
  element, age: 0, life: 0, angle: 0, strength: 0, bend: 0, travel: 0, originX: 0, originY: 0, size: 1,
}));
let orbParticleCredit = 0;
let orbParticleSerial = 0;
const energyOrb = window.VoxdenEnergyOrb && window.VoxdenEnergyOrb.create(document.getElementById('energy-orb'));
let orbVisualRaf = 0;
let orbVisualLast = 0;
let orbVisualTime = 0;
let orbDrawBudget = 0;
let orbHoverLight = 0;
let orbActiveLight = 0;
let orbVoiceEnergy = 0;
let orbVoiceTrail = 0;
let orbPulse = 0;
let orbEnergyStep = -1;
let orbProcessingMix = 0;
let orbProcessingClock = 0;
let orbProcessingOrigin = null;
const ORB_PROCESSING_ECHOES = [['a', .18, .4], ['b', .37, .27]];

function orbEffectsVisible() {
  return flowBarStyle === 'orb' && !document.hidden
    && document.body.classList.contains('shown') && !document.body.classList.contains('hiding');
}

function stopOrbVisuals() {
  if (!orbVisualRaf) return;
  cancelAnimationFrame(orbVisualRaf);
  orbVisualRaf = 0;
  resetOrbParticles();
}

function resetOrbPresentation() {
  // Reset on departure only. The idle-to-recording handoff preserves these
  // envelopes so clicking the sphere cannot restart its hover motion.
  orbHoverLight = 0;
  orbActiveLight = 0;
  orbDrawBudget = 0;
}

function beginOrbProcessing() {
  const number = (name, fallback) => {
    const value = parseFloat(pill.style.getPropertyValue(name));
    return Number.isFinite(value) ? value : fallback;
  };
  // Keep the final speech frame as the start of the glass transformation.
  // These are inline values, so no layout or microphone read is needed.
  orbProcessingOrigin = {
    energy: orbVoiceEnergy, pulse: orbPulse,
    scale: number('--orb-scale', .8), x: number('--orb-x', 0), y: number('--orb-y', 0),
    halo: number('--orb-halo-opacity', .2), haloScale: number('--orb-halo-scale', 1),
    haloX: number('--orb-halo-x', 0), haloY: number('--orb-halo-y', 0), haloTurn: number('--orb-halo-turn', 0),
  };
  orbProcessingMix = 0;
  orbProcessingClock = 0;
}

function drawProcessingOrb(dt, force) {
  if (!orbProcessingOrigin) beginOrbProcessing();
  const reduced = waveMotionPreference.matches;
  if (!reduced) {
    orbProcessingClock += dt;
    orbVisualTime += dt * .95;
  }
  orbProcessingMix = reduced ? 1 : approach(orbProcessingMix, 1, .14, dt);
  const cycle = (orbProcessingClock / 2.6) % 1;
  // A short charge, then a softer answering pulse. Both are periodic and
  // continuous at the cycle boundary, unlike restarting a blink animation.
  const charge = reduced ? .3 : Math.min(1,
    Math.pow((1 + Math.cos((cycle - .18) * Math.PI * 2)) / 2, 12)
    + .52 * Math.pow((1 + Math.cos((cycle - .44) * Math.PI * 2)) / 2, 16));
  const flare = reduced ? 0 : charge * .3;
  const from = orbProcessingOrigin;
  const blend = (a, b) => a + (b - a) * orbProcessingMix;
  pill.style.setProperty('--orb-scale', blend(from.scale, .89 + charge * .016).toFixed(4));
  pill.style.setProperty('--orb-x', blend(from.x, 0).toFixed(3) + 'px');
  pill.style.setProperty('--orb-y', blend(from.y, 0).toFixed(3) + 'px');
  pill.style.setProperty('--orb-halo-opacity', blend(from.halo, .55 + charge * .42).toFixed(3));
  pill.style.setProperty('--orb-halo-scale', blend(from.haloScale, 1 + charge * .17).toFixed(4));
  pill.style.setProperty('--orb-halo-x', blend(from.haloX, 0).toFixed(3) + 'px');
  pill.style.setProperty('--orb-halo-y', blend(from.haloY, 0).toFixed(3) + 'px');
  pill.style.setProperty('--orb-halo-turn', blend(from.haloTurn, 0).toFixed(3) + 'deg');
  pill.style.setProperty('--orb-processing-turn', (orbVisualTime * .31 * 180 / Math.PI).toFixed(3) + 'deg');
  for (const [name, offset, strength] of ORB_PROCESSING_ECHOES) {
    const progress = Math.min(1, ((cycle - offset + 1) % 1) / .6);
    const light = reduced ? 0 : Math.sin(progress * Math.PI) * (1 - progress * .4) * strength * orbProcessingMix;
    pill.style.setProperty('--orb-echo-' + name + '-opacity', light.toFixed(3));
    pill.style.setProperty('--orb-echo-' + name + '-scale', (.78 + progress * .92).toFixed(4));
  }
  orbDrawBudget += dt;
  if (!force && orbDrawBudget < 1 / 30) return;
  orbDrawBudget %= 1 / 30;
  energyOrb.draw({ time: orbVisualTime, processing: orbProcessingMix,
    energy: blend(from.energy, .48 + charge * .22), pulse: blend(from.pulse, flare),
    hover: orbHoverLight * (1 - orbProcessingMix), reducedMotion: reduced });
}

function drawEnergyOrb(dt, force = false) {
  if (!energyOrb || !orbEffectsVisible()) return;
  if (hudMode === 'transcribing') return drawProcessingOrb(dt, force);
  const reduced = waveMotionPreference.matches;
  const targetHover = hudMode === 'idle' && overInteractive ? 1 : 0;
  orbHoverLight = reduced ? targetHover : approach(orbHoverLight, targetHover, .1, dt);
  const recording = hudMode === 'recording';
  const active = recording || hudMode === 'arming';
  orbActiveLight = reduced ? 0 : approach(orbActiveLight, active ? 1 : 0, .12, dt);
  const energy = recording ? orbVoiceEnergy : hudMode === 'arming' ? .15 : .04;
  const pulse = recording && !reduced ? orbPulse : 0;
  // Integrate speed: multiplying elapsed time by a changing voice level would
  // jump the ribbons to a new phase at each syllable.
  if (!reduced) orbVisualTime += dt * (.7 + energy * 1.65 + pulse * .65);
  const phase = orbVisualTime * .62;
  const motion = recording && !reduced ? energy : 0;
  const scale = reduced ? .8 : .8 + orbHoverLight * .07
    + orbActiveLight * .04 + motion * .06 + pulse * .055;
  // One owner for movement. The hit target never changes size on hover, and
  // there is no CSS transform transition chasing these per-frame values.
  pill.style.setProperty('--orb-scale', scale.toFixed(4));
  pill.style.setProperty('--orb-x', (Math.sin(phase * 2) * motion * .55).toFixed(3) + 'px');
  pill.style.setProperty('--orb-y', (-orbHoverLight * .65 + Math.sin(phase * 3 + .6) * motion * .55).toFixed(3) + 'px');
  pill.style.setProperty('--orb-halo-opacity', Math.min(1, .18 + orbHoverLight * .5 + energy * .5 + pulse * .38).toFixed(3));
  pill.style.setProperty('--orb-halo-scale', (1 + motion * .12 + pulse * .15).toFixed(4));
  pill.style.setProperty('--orb-halo-x', (Math.sin(phase) * motion * 1.6).toFixed(3) + 'px');
  pill.style.setProperty('--orb-halo-y', (Math.cos(phase * 2) * motion * 1.4).toFixed(3) + 'px');
  pill.style.setProperty('--orb-halo-turn', (reduced ? 0 : Math.sin(phase) * motion * 32).toFixed(3) + 'deg');
  orbDrawBudget += dt;
  // The sphere's small texture stays at 30fps; voice metering and particle
  // movement keep their existing frame cadence and share this draw budget.
  if (!force && orbDrawBudget < 1 / 30) return;
  orbDrawBudget %= 1 / 30;
  energyOrb.draw({
    time: orbVisualTime,
    energy,
    pulse,
    hover: orbHoverLight,
    reducedMotion: reduced,
  });
}

function syncOrbVisuals() {
  const active = orbEffectsVisible() && ['idle', 'arming', 'transcribing'].includes(hudMode);
  if (!active) {
    stopOrbVisuals();
    return;
  }
  if (waveMotionPreference.matches) {
    stopOrbVisuals();
    drawEnergyOrb(0, true);
    return;
  }
  if (orbVisualRaf) return;
  orbVisualLast = performance.now();
  drawEnergyOrb(0, true);
  function frame(now) {
    if (!orbEffectsVisible() || !['idle', 'arming', 'transcribing'].includes(hudMode) || waveMotionPreference.matches) {
      stopOrbVisuals();
      return;
    }
    const dt = Math.max(.001, Math.min(.05, (now - orbVisualLast) / 1000));
    orbVisualLast = now;
    drawEnergyOrb(dt);
    if (hudMode === 'transcribing') updateOrbParticles(dt, false);
    orbVisualRaf = requestAnimationFrame(frame);
  }
  orbVisualRaf = requestAnimationFrame(frame);
}

function resetOrbParticles() {
  orbParticleCredit = 0;
  orbParticleSerial = 0;
  orbEnergyStep = -1;
  if (orbAtmosphere) orbAtmosphere.style.setProperty('--orb-energy', '0');
  for (const particle of orbParticles) {
    particle.life = 0;
    particle.element.style.opacity = '0';
    particle.element.style.transform = 'translate(-50%, -50%) scale(.6)';
  }
}

waveMotionPreference.addEventListener('change', () => {
  if (waveMotionPreference.matches) resetOrbParticles();
  syncOrbVisuals();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) resetOrbParticles();
  syncOrbVisuals();
});
window.addEventListener('beforeunload', () => {
  stopOrbVisuals();
  if (energyOrb) energyOrb.dispose();
});

function updateOrbParticles(dt, reduced) {
  const processing = hudMode === 'transcribing';
  if (!orbEffectsVisible() || (hudMode !== 'recording' && !processing) || reduced) {
    if (orbParticleCredit || orbParticles.some(particle => particle.life)) resetOrbParticles();
    return;
  }
  dt = Number.isFinite(dt) ? Math.max(.001, Math.min(.05, dt)) : 1 / 60;
  const energy = processing ? .38 + .14 * Math.sin(orbProcessingClock * Math.PI / 1.2) : orbVoiceEnergy;
  const energyStep = Math.round(energy * 100);
  if (energyStep !== orbEnergyStep) {
    orbEnergyStep = energyStep;
    orbAtmosphere.style.setProperty('--orb-energy', (energyStep / 100).toFixed(2));
  }
  // Speech keeps its existing response. Processing sheds a few small beads
  // from the material's sides after the glass shape has formed.
  const emitting = processing ? orbProcessingMix > .65 : energy > .055;
  const rate = processing ? 3.2 + energy * 2 : 4 + energy * 10 + orbPulse * 4;
  orbParticleCredit = emitting ? Math.min(2, orbParticleCredit + dt * rate) : 0;
  if (orbParticleCredit >= 1) {
    const particle = orbParticles.find(item => !item.life);
    if (particle) {
      const serial = orbParticleSerial++;
      const fraction = (serial * .61803398875 + .17) % 1;
      const edge = serial % 4;
      // The 36px-high active capsule is a straight spine with 18px end caps.
      // Percentage anchors follow its CSS morph without measuring layout.
      if (processing) {
        particle.element.style.left = pill.classList.contains('has-line') ? '20px' : '50%';
        particle.angle = (serial % 2 ? 0 : Math.PI) + (fraction - .5) * .9;
        particle.originX = Math.cos(particle.angle) * 13;
        particle.originY = Math.sin(particle.angle) * 13;
      } else if (edge < 2) {
        const along = .12 + fraction * .76;
        particle.element.style.left = 'calc(' + (along * 100).toFixed(2) + '% + '
          + (18 * (1 - 2 * along)).toFixed(2) + 'px)';
        particle.originX = 0;
        particle.originY = edge === 0 ? -16 : 16;
        particle.angle = (edge === 0 ? -Math.PI / 2 : Math.PI / 2) + (fraction - .5) * .45;
      } else {
        particle.element.style.left = edge === 2 ? '18px' : 'calc(100% - 18px)';
        particle.angle = (edge === 2 ? Math.PI : 0) + (fraction - .5) * 2.1;
        particle.originX = Math.cos(particle.angle) * 16;
        particle.originY = Math.sin(particle.angle) * 16;
      }
      particle.age = 0;
      particle.life = 1.05 + fraction * .4;
      particle.strength = processing ? .36 + energy * .2 : .28 + energy * .4 + orbPulse * .16;
      particle.bend = (fraction - .5) * 3;
      // Bottom travel is shorter because the bar rests near the window floor.
      particle.travel = processing ? 15 + fraction * 5 : Math.sin(particle.angle) > .3 ? 11 : 17 + fraction * 4;
      particle.size = processing ? .66 + fraction * .2 : .86 + fraction * .34;
      orbParticleCredit -= 1;
    }
  }
  for (const particle of orbParticles) {
    if (!particle.life) continue;
    particle.age += dt;
    const progress = Math.min(1, particle.age / particle.life);
    if (progress >= 1) {
      particle.life = 0;
      particle.element.style.opacity = '0';
      continue;
    }
    const travel = particle.travel * (1 - Math.pow(1 - progress, 1.5));
    const x = particle.originX + Math.cos(particle.angle) * travel + Math.sin(progress * Math.PI) * particle.bend;
    const y = particle.originY + Math.sin(particle.angle) * travel;
    const light = Math.sin(Math.PI * progress) * (1 - progress * .3) * particle.strength;
    const size = particle.size * (1 - progress * .52);
    particle.element.style.opacity = light.toFixed(3);
    particle.element.style.transform = 'translate(-50%, -50%) translate(' + x.toFixed(2) + 'px, '
      + y.toFixed(2) + 'px) scale(' + size.toFixed(3) + ')';
  }
}

// One shared colour for the mic and strip, drawn from a small palette rather
// than allocating a colour string for every bar on every frame.
const WAVE_PALETTE = [];
for (let i = 0; i <= WAVE_STEPS; i++) {
  const t = i / WAVE_STEPS;
  const r = Math.round(WAVE_REST[0] + (WAVE_LIVE[0] - WAVE_REST[0]) * t);
  const g = Math.round(WAVE_REST[1] + (WAVE_LIVE[1] - WAVE_REST[1]) * t);
  const b = Math.round(WAVE_REST[2] + (WAVE_LIVE[2] - WAVE_REST[2]) * t);
  WAVE_PALETTE.push('rgb(' + r + ',' + g + ',' + b + ')');
}

const barLevel = new Float32Array(waveBars.length);
const bands = new Float32Array(BAND_COUNT);
let levelSmooth = 0;
let voiceSmooth = 0;
let wavePeak = 0.008;
let glowSmooth = 0;
let glowStep = -1;
let pillStep = -1;
let waveClock = 0;
let waveLast = 0;
let timeBuf = null;
let freqBuf = null;
let bandEdges = null;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Frame-rate independent exponential smoothing. `tau` is a time constant in
// seconds, so a dropped frame eases by exactly as much as it should have over
// two -- a plain `cur += (target - cur) * k` speeds up whenever the frame does.
function approach(cur, target, tau, dt) {
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

// Log-spaced voice bands over 90Hz..5.2kHz. They add real spectral detail across
// the strip while the shared envelope keeps adjacent bars visually connected.
function buildBands(sampleRate, bins, count) {
  const edges = new Int32Array(count + 1);
  const nyquist = sampleRate / 2;
  for (let k = 0; k <= count; k++) {
    const hz = 90 * Math.pow(5200 / 90, k / count);
    edges[k] = Math.max(1, Math.min(bins - 1, Math.round((hz / nyquist) * bins)));
  }
  // A low capture rate can collapse neighbouring edges onto the same bin.
  for (let k = 1; k <= count; k++) {
    if (edges[k] <= edges[k - 1]) edges[k] = edges[k - 1] + 1;
  }
  return edges;
}

function readBands(freq, edges, out) {
  let total = 0;
  for (let k = 0; k < out.length; k++) {
    const from = Math.min(freq.length - 1, edges[k]);
    const to = Math.max(from + 1, Math.min(freq.length, edges[k + 1]));
    let sum = 0;
    for (let i = from; i < to; i++) sum += freq[i];
    out[k] = sum / (to - from) / 255;
    total += out[k];
  }
  return total / out.length;
}

function updateWave(dt, level, freq) {
  const n = waveBars.length;
  if (!n) return;
  dt = Number.isFinite(dt) ? Math.max(0.001, Math.min(0.05, dt)) : 1 / 60;
  level = Number.isFinite(level) ? clamp01(level) : 0;
  const mid = (n - 1) / 2;
  const reduced = waveMotionPreference.matches;

  // This is an input meter, not the recognizer's speech gate. A soft knee and
  // bounded gain make low-gain microphones visible without a threshold that
  // switches their glow off. This never changes recorded PCM or transcription.
  levelSmooth = approach(levelSmooth, level, level > levelSmooth ? 0.016 : 0.065, dt);
  wavePeak = Math.max(0.006, levelSmooth, wavePeak * Math.exp(-dt / 1.8));
  const reference = Math.max(0.004, Math.min(0.012, wavePeak * 0.3));
  const signal = Math.max(0, levelSmooth - 0.00012);
  const voice = 1 - Math.exp(-signal / reference);
  voiceSmooth = approach(voiceSmooth, voice, voice > voiceSmooth ? 0.028 : 0.115, dt);

  // The glow follows the same energy as the bars, with a longer tail. It never
  // depends on a boolean "speaking" class and so cannot flicker off between
  // syllables. Quantizing opacity avoids redundant style writes at rest.
  const glowTarget = Math.pow(voiceSmooth, 0.65);
  glowSmooth = approach(glowSmooth, glowTarget, glowTarget > glowSmooth ? 0.045 : 0.24, dt);
  const gStep = Math.round(glowSmooth * 100);
  if (gStep !== glowStep) {
    glowStep = gStep;
    pill.style.setProperty('--voice-glow', (gStep / 100).toFixed(2));
  }
  // Keep one continuous phase as input rises and falls. Both harmonics wrap
  // together, so even a long recording has no phase jump at the loop boundary.
  waveClock = (waveClock + dt * (2.2 + voiceSmooth * 3.8)) % (Math.PI * 2);

  const avg = freq && bandEdges ? readBands(freq, bandEdges, bands) : 0;

  for (let i = 0; i < n; i++) {
    const position = mid === 0 ? 0 : (i - mid) / mid;
    const envelope = 0.7 + 0.3 * Math.cos(position * Math.PI / 2);
    // Two crests travel in the same direction. The shallow base shows that
    // listening is active; voice adds range and pace without restarting it.
    // The spectrum adds a little texture without making neighbours jump apart.
    const band = bands[Math.round((n === 1 ? 0 : i / (n - 1)) * (BAND_COUNT - 1))];
    const rel = avg > 0.002 ? band / avg : 1;
    const detail = Math.max(0.65, Math.min(1.25, Math.sqrt(rel)));
    const ripple = reduced ? 0
      : 0.78 * (0.5 + 0.5 * Math.sin(waveClock - i * 0.62))
        + 0.22 * (0.5 + 0.5 * Math.sin(waveClock * 2 - i * 0.94 + 1.3));
    const listening = reduced ? 0 : envelope * (0.025 + 0.19 * ripple);
    const speaking = reduced ? envelope
      : Math.min(1, envelope * (0.18 + 0.82 * ripple) * (0.9 + 0.1 * detail));
    const target = listening + voiceSmooth * (speaking - listening);
    const attack = 0.075 - voiceSmooth * 0.045;
    barLevel[i] = approach(barLevel[i], target, target > barLevel[i] ? attack : 0.1, dt);
    const scale = WAVE_MIN_SCALE + (WAVE_MAX_SCALE - WAVE_MIN_SCALE) * barLevel[i];
    waveBars[i].style.transform = 'scaleY(' + scale.toFixed(3) + ')';
  }

  if (flowBarStyle === 'orb' && hudMode === 'recording') {
    // A faster visual envelope preserves the shape of syllables; the waveform's
    // long glow tail alone made the sphere look continuously lit during speech.
    const reference = Math.max(.003, Math.min(.12, wavePeak * .8));
    const energyTarget = Math.pow(1 - Math.exp(-signal / reference), .72);
    orbVoiceEnergy = approach(orbVoiceEnergy, energyTarget, energyTarget > orbVoiceEnergy ? .035 : .085, dt);
    orbVoiceTrail = approach(orbVoiceTrail, orbVoiceEnergy, .24, dt);
    const onset = clamp01((orbVoiceEnergy - orbVoiceTrail) * 3.4);
    orbPulse = approach(orbPulse, onset, onset > orbPulse ? .022 : .13, dt);
  }
  updateOrbParticles(dt, reduced);
  if (flowBarStyle === 'orb' && hudMode === 'recording') drawEnergyOrb(dt);

  const pStep = Math.round(glowSmooth * WAVE_STEPS);
  if (pStep !== pillStep) {
    pillStep = pStep;
    pill.style.setProperty('--mic', WAVE_PALETTE[pStep]);
    waveStrip.style.color = WAVE_PALETTE[pStep];
  }
}

function resetWave() {
  resetOrbParticles();
  orbVoiceEnergy = 0;
  orbVoiceTrail = 0;
  orbPulse = 0;
  levelSmooth = 0;
  voiceSmooth = 0;
  wavePeak = 0.008;
  glowSmooth = 0;
  glowStep = -1;
  waveClock = 0;
  pillStep = -1;
  barLevel.fill(0);
  pill.style.setProperty('--voice-glow', '0');
  pill.style.setProperty('--mic', '#ffffff');
  waveStrip.style.color = WAVE_PALETTE[0];
  for (const el of waveBars) {
    el.style.transform = 'scaleY(' + WAVE_MIN_SCALE.toFixed(3) + ')';
  }
}

function waveRms(samples) {
  // Float samples preserve quiet speech that an 8-bit analyser quantizes away.
  // Remove DC offset so a biased input does not look like constant sound.
  if (!samples.length) return 0;
  let sum = 0;
  let squares = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i];
    squares += samples[i] * samples[i];
  }
  const mean = sum / samples.length;
  return Math.sqrt(Math.max(0, squares / samples.length - mean * mean));
}

function startWaveLoop() {
  if (raf) return;
  resetWave();
  waveLast = performance.now();
  function frame(now) {
    if (!pill.classList.contains('recording')) {
      raf = 0;
      return;
    }
    // Clamped: a backgrounded window resumes with a huge gap, and an unclamped
    // dt would snap every bar to its target in a single frame.
    const dt = Math.min(0.05, Math.max(0.001, (now - waveLast) / 1000));
    waveLast = now;
    let level = 0;
    let freq = null;
    if (analyser) {
      // Buffers are kept, not reallocated: the old loop threw away a kilobyte
      // of Uint8Array every frame for the garbage collector to chase.
      if (!timeBuf || timeBuf.length !== analyser.fftSize) {
        timeBuf = new Float32Array(analyser.fftSize);
      }
      if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) {
        freqBuf = new Uint8Array(analyser.frequencyBinCount);
        bandEdges = buildBands(analyser.context.sampleRate, analyser.frequencyBinCount, BAND_COUNT);
      }
      analyser.getFloatTimeDomainData(timeBuf);
      analyser.getByteFrequencyData(freqBuf);
      level = waveRms(timeBuf);
      freq = freqBuf;
    }
    updateWave(dt, level, freq);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
}

function stopWaveLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  resetWave();
}

function mergePcm(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.round(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.round(i * ratio);
    const end = Math.round((i + 1) * ratio);
    let sum = 0;
    let n = 0;
    for (let j = start; j < end && j < input.length; j++) {
      sum += input[j];
      n++;
    }
    out[i] = n ? sum / n : 0;
  }
  return out;
}

function encodeWav(float32, sampleRate) {
  const n = float32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buf);
  function str(offset, s) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  }
  str(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buf;
}

function stopWebSpeech() {
  if (recognition) {
    try { recognition.stop(); } catch (_) {}
    recognition = null;
  }
}

async function startCapture(useEngine) {
  if (capturing) return;
  capturing = true;
  stopRequested = false;
  webText = '';
  webResultIndex = 0;
  pcmChunks = [];
  captureGen += 1;
  const gen = captureGen;
  resetChunkState();
  cloudCapture = cloudReady;
  engine = useEngine || 'webspeech';
  // Local Auto needs the finished clip length to choose Fast or Accurate.
  // Keep the full recording intact in that mode so long dictations are not
  // prematurely sent through the fast model one chunk at a time.
  if (cloudCapture && globalThis.voxdenCloudSegments) {
    chunker = globalThis.voxdenCloudSegments.createCloudSegmenter();
  } else if (!cloudCapture && dictationQuality !== 'auto' && wantsLocalAsr() && engineStatus === 'ready' && chunkingApi()) {
    chunker = chunkingApi().createChunker();
  }
  setHud('arming');

  let stream;
  try {
    const audio = {
      echoCancellation: false,
      noiseSuppression: true,
      channelCount: 1,
    };
    if (micDeviceId && micDeviceId !== 'default') {
      audio.deviceId = { ideal: micDeviceId };
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio,
      video: false,
    });
  } catch (err) {
    if (gen !== captureGen || !capturing) return;
    failCapture(gen, err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
      ? 'Mic blocked — allow microphone access' : 'Microphone unavailable — check your input device');
    return;
  }

  if (!capturing || gen !== captureGen) {
    for (const track of stream.getTracks()) track.stop();
    return;
  }

  try {
    mediaStream = stream;
    for (const track of stream.getAudioTracks()) {
      track.onended = () => failCapture(gen, 'Microphone disconnected — check your input device');
    }
    const context = new AudioContext();
    audioCtx = context;
    if (context.state === 'suspended') await context.resume();
    if (!capturing || gen !== captureGen) return;
    if (context.state !== 'running') throw new Error('Audio device did not start');
    inputSampleRate = context.sampleRate;
    sourceNode = context.createMediaStreamSource(mediaStream);
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    // The analyser's own smoothing runs before ours and costs nothing. Slightly
    // below the 0.8 default so the spectrum still moves with a syllable; the
    // per-bar filter in updateWave takes the rest of the noise out.
    analyser.smoothingTimeConstant = 0.55;
    processor = context.createScriptProcessor(4096, 1, 1);
    let firstAudio = true;
    let lastAudioAt = 0;
    processor.onaudioprocess = (e) => {
      if (!capturing || gen !== captureGen) return;
      try {
        const raw = new Float32Array(e.inputBuffer.getChannelData(0));
        if (!raw.length) return;
        if (wantsLocalAsr()) {
          // The local engine only ever reads the 16 kHz copy. Keeping the 48 kHz
          // original as well tripled the memory a long dictation held for nothing.
          const ds = downsample(raw, inputSampleRate, OUT_RATE);
          dsPcmChunks.push(ds);
          if (chunker) {
            const slices = chunker.push(ds);
            for (const slice of slices) enqueueSlice(slice, gen);
          }
        } else {
          pcmChunks.push(raw);
        }
        lastAudioAt = performance.now();
        if (firstAudio) {
          firstAudio = false;
          // A constructed graph can still be silent on a suspended/broken audio
          // device. Only promise that we're listening after PCM actually arrives.
          // Main's arming deadline covers graphs that never deliver a first frame.
          setHud('recording');
          if (window.voxden && typeof window.voxden.captureReady === 'function') {
            window.voxden.captureReady();
          }
        }
      } catch (_) {
        failCapture(gen, 'Could not read microphone audio — try again');
      }
    };
    sourceNode.connect(analyser);
    sourceNode.connect(processor);
    captureSink = context.createMediaStreamDestination();
    processor.connect(captureSink);
    if (!capturing || gen !== captureGen) {
      teardownAudio();
      return;
    }
    captureWatch = setInterval(() => {
      if (capturing && gen === captureGen && lastAudioAt && performance.now() - lastAudioAt > 10000) {
        failCapture(gen, 'Microphone stopped responding — try again');
      }
    }, 1000);

    // Chromium SpeechRecognition uploads mic chunks to Google's speech service.
    // Electron does not ship that service, so each chunk fails with
    // OnSizeReceived Error: -2 in the terminal and returns no text. Skip it
    // whenever the local sidecar will transcribe the recording.
    if (!wantsLocalAsr() && (window.SpeechRecognition || window.webkitSpeechRecognition)) {
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';
      recognition.onresult = (ev) => {
        for (let i = webResultIndex; i < ev.results.length; i++) {
          const t = ev.results[i][0].transcript.trim();
          if (!t) continue;
          if (ev.results[i].isFinal) {
            webText = webText ? webText + ' ' + t : t;
            webResultIndex = i + 1;
          }
        }
      };
      recognition.onend = () => {
        if (capturing && !wantsLocalAsr() && recognition) {
          try { recognition.start(); } catch (_) {}
        }
      };
      recognition.onerror = (ev) => {
        if (ev.error === 'not-allowed') {
          window.voxden.captureFailed('Mic blocked — allow microphone access');
        }
      };
      try { recognition.start(); } catch (_) {}
    }
  } catch (_) {
    failCapture(gen, 'Microphone audio could not start — check your input device');
  }
}

function failCapture(gen, message) {
  if (gen !== captureGen || !capturing) return;
  if (typeof window.voxden.diag === 'function') {
    window.voxden.diag('capture-failed', { mode: hudMode, audioState: audioCtx && audioCtx.state, reason: message });
  }
  capturing = false;
  captureGen += 1;
  resetChunkState();
  pcmChunks = [];
  stopWebSpeech();
  teardownAudio();
  setHud('error', message);
  window.voxden.captureFailed(message);
}

function teardownAudio() {
  if (captureWatch) clearInterval(captureWatch);
  captureWatch = 0;
  if (processor) processor.onaudioprocess = null;
  try { processor && processor.disconnect(); } catch (_) {}
  try { captureSink && captureSink.disconnect(); } catch (_) {}
  if (captureSink && captureSink.stream) {
    for (const track of captureSink.stream.getTracks()) track.stop();
  }
  try { sourceNode && sourceNode.disconnect(); } catch (_) {}
  try { analyser && analyser.disconnect(); } catch (_) {}
  processor = null;
  captureSink = null;
  sourceNode = null;
  analyser = null;
  if (audioCtx) {
    try { audioCtx.close().catch(() => {}); } catch (_) {}
    audioCtx = null;
  }
  if (mediaStream) {
    for (const t of mediaStream.getTracks()) {
      t.onended = null;
      t.stop();
    }
    mediaStream = null;
  }
}

// How much audio either side of a seam the bridge pass listens to. Long
// enough to carry the words that were cut and the ones anchoring them, short
// enough that recognising it costs a fraction of the clip.
const BRIDGE_MS = 1500;
// At most this many seams are re-recognised per dictation. Chunking exists so
// that the work is finished when the user stops talking; a noisy recording
// that suspects every boundary must not undo that.
const MAX_BRIDGES = 2;

// Join the chunk transcripts, going back to the audio for any seam the text
// alone could not stitch.
//
// A boundary the chunker built with 400ms of overlap should show that overlap
// in the two transcripts. When it does not, the cut landed inside a word --
// "transcription" arriving as "trans" and "cription" -- and no amount of
// string handling recovers it, because neither side ever contained the word.
// Re-recognising the audio that spans the seam does, because that pass hears
// it whole.
async function reconcileChunks(texts, sliceOf, gen) {
  const api = chunkingApi();
  if (!api || !api.reconcileChunkTranscripts) return texts.join(' ');
  const first = api.reconcileChunkTranscripts(texts);
  const suspects = api.suspectBoundaries
    ? api.suspectBoundaries(first.boundaries, MAX_BRIDGES)
    : [];
  if (!suspects.length) return api.joinChunkTranscripts(texts);

  const bridges = {};
  const span = Math.round(OUT_RATE * BRIDGE_MS / 1000);
  for (const index of suspects) {
    const left = chunkSlices[sliceOf[index - 1]];
    const right = chunkSlices[sliceOf[index]];
    if (!left || !right) continue;
    const head = left.subarray(Math.max(0, left.length - span));
    const tail = right.subarray(0, Math.min(right.length, span));
    const bridge = mergePcm([head, tail]);
    if (bridge.length < MIN_SLICE_SAMPLES) continue;
    try {
      const text = await window.voxden.transcribeLocal(
        encodeWav(bridge, OUT_RATE), { park: false, vad: false }
      );
      if (chunkingApi().shouldIgnoreGeneration(gen, captureGen)) return '';
      if (text && String(text).trim()) bridges[index] = String(text).trim();
    } catch (_) {
      // A failed bridge is a boundary that stays as it was, not a failed
      // dictation. The joined text is still the text.
    }
  }
  return api.joinChunkTranscripts(texts, bridges);
}

// A push-to-talk clip too short to hold a word is almost always a tap where a
// hold was needed. "No speech" blames the microphone for that; say what to do.
function nothingHeardMessage() {
  if (document.body.classList.contains('ptt')) {
    return 'Hold ' + shortcutLabel + ' while you speak';
  }
  return 'No speech';
}

async function finishCapture(shouldTranscribe) {
  if (!capturing && !shouldTranscribe) {
    teardownAudio();
    stopWebSpeech();
    return;
  }
  const gen = captureGen;
  capturing = false;
  stopWebSpeech();
  const chunks = pcmChunks;
  pcmChunks = [];
  teardownAudio();
  // Other apps only need to stay silent while their sound can reach the open
  // microphone. Let main restore output before local transcription finishes.
  if (window.voxden && typeof window.voxden.captureEnded === 'function') {
    window.voxden.captureEnded();
  }

  if (!shouldTranscribe) {
    captureGen += 1;
    resetChunkState();
    window.voxden.cancelled();
    return;
  }

  if (engineStatus === 'ready' || cloudReady) setHud('transcribing');
  else setHud('transcribing', 'Loading speech model…');
  const webFallback = webText.trim();
  const hasPcm = chunks.length > 0 || dsPcmChunks.length > 0;

  if (wantsLocalAsr() && hasPcm) {
    try {
      if (chunker) {
        const tail = chunker.flush();
        if (tail) enqueueSlice(tail, gen);
      }
      const pcm = dsPcmChunks.length
        ? mergePcm(dsPcmChunks)
        : downsample(mergePcm(chunks), inputSampleRate, OUT_RATE);
      if (pcm.length < MIN_SLICE_SAMPLES) {
        captureGen += 1;
        resetChunkState();
        if (webFallback) window.voxden.transcript(webFallback);
        else window.voxden.captureFailed(nothingHeardMessage());
        return;
      }
      // A recording nobody spoke into goes no further. Every engine writes
      // words over silence eventually, and those words used to be pasted;
      // the slices already sent are abandoned with the generation bump, so
      // whatever they come back with is never read either.
      const gate = speechGateApi() ? speechGateApi().analyseSpeech(pcm, { sampleRate: OUT_RATE }) : null;
      if (gate && typeof window.voxden.diag === 'function') window.voxden.diag('speech-gate', gate);
      if (gate && !gate.speech) {
        captureGen += 1;
        resetChunkState();
        window.voxden.captureFailed(nothingHeardMessage());
        return;
      }
      const ignore = chunkingApi() && chunkingApi().shouldIgnoreGeneration;
      let trimmed = '';
      if (chunkJobs.length) {
        if (cloudCapture && window.voxden.parkAudio) await window.voxden.parkAudio(encodeWav(pcm, OUT_RATE));
        const results = await Promise.all(chunkJobs);
        if (ignore && ignore(gen, captureGen)) return;
        const texts = [];
        const sliceOf = [];
        let failed = false;
        for (const result of results) {
          if (ignore && ignore(result.gen, gen)) continue;
          if (!result.ok) {
            if (cloudCapture) throw result.error;
            failed = true;
            break;
          }
          if (result.text && result.text.trim()) {
            texts.push(result.text.trim());
            sliceOf.push(result.index);
          }
        }
        // Cloud segments have no overlapping audio and end in silence. Keep
        // repeated words intact and avoid extra bridge recognition requests.
        const joined = failed ? '' : cloudCapture ? texts.join(' ') : await reconcileChunks(texts, sliceOf, gen);
        if (!failed && joined) {
          trimmed = joined.trim();
          if (!cloudCapture && !(ignore && ignore(gen, captureGen))) {
            const fullWav = encodeWav(pcm, OUT_RATE);
            if (window.voxden.parkAudio) window.voxden.parkAudio(fullWav);
          }
        }
      }
      if (!trimmed && !(cloudCapture && chunkJobs.length)) {
        const wav = encodeWav(pcm, OUT_RATE);
        trimmed = String((await window.voxden.transcribeLocal(wav, { cloud: cloudCapture })) || '').trim();
      }
      if (ignore && ignore(gen, captureGen)) return;
      resetChunkState();
      if (trimmed) {
        window.voxden.transcript(trimmed);
      } else if (webFallback) {
        window.voxden.transcript(webFallback);
      } else {
        window.voxden.captureFailed('No speech');
      }
    } catch (err) {
      if (chunkingApi() && chunkingApi().shouldIgnoreGeneration(gen, captureGen)) return;
      resetChunkState();
      if (webFallback) {
        window.voxden.transcript(webFallback);
      } else {
        window.voxden.captureFailed((err && err.message) || 'Transcribe failed');
      }
    }
    return;
  }

  resetChunkState();

  if (webFallback) {
    window.voxden.transcript(webFallback);
    return;
  }

  // Reaching here with no engine means nothing ever had a chance to transcribe.
  // "No speech" blamed the microphone for a setup problem; say which it is and
  // point at Settings, where the actual missing package is named.
  if (engineStatus === 'unavailable') {
    window.voxden.captureFailed('Speech engine not set up');
    return;
  }

  window.voxden.captureFailed(hasPcm ? 'No speech' : nothingHeardMessage());
}

if (btnCancel) {
  btnCancel.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.voxden) window.voxden.cancel();
  });
}

function finishOrbRecording(e) {
  e.preventDefault();
  e.stopPropagation();
  if (flowBarStyle === 'orb' && hudMode === 'recording' && window.voxden) window.voxden.confirm();
}
if (orbFinish) orbFinish.addEventListener('click', finishOrbRecording);
if (orbDiscard) orbDiscard.addEventListener('click', e => {
  e.preventDefault();
  e.stopPropagation();
  if (flowBarStyle === 'orb' && hudMode === 'recording' && window.voxden) window.voxden.cancel();
});
if (orbTrigger) orbTrigger.addEventListener('click', e => {
  if (hudMode === 'recording') return finishOrbRecording(e);
  e.preventDefault();
  e.stopPropagation();
  if (flowBarStyle !== 'orb' || hudMode !== 'idle' || !window.voxden) return;
  window.voxden.toggle();
});

if (btnConfirm) {
  btnConfirm.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.voxden) return;
    if (editingSuccess) return;
    window.voxden.confirm();
  });
}

if (btnUndo) {
  // Clicking Undo must leave the caret in the app the user is correcting.
  btnUndo.addEventListener('mousedown', e => e.preventDefault());
  btnUndo.addEventListener('focus', syncLearnedHold);
  btnUndo.addEventListener('blur', syncLearnedHold);
  btnUndo.addEventListener('click', async e => {
    e.preventDefault();
    e.stopPropagation();
    if (hudMode !== 'learned' || !learnedUndoToken || learnedUndoPending
      || !window.voxden || typeof window.voxden.undoAutoLearn !== 'function') return;
    const token = learnedUndoToken;
    learnedUndoPending = true;
    btnUndo.disabled = true;
    syncLearnedHold();
    try {
      const result = await window.voxden.undoAutoLearn(token);
      if ((!result || !result.ok) && hudMode === 'learned' && learnedUndoToken === token) {
        setHud('learned', (result && result.error) || 'Could not undo. Try again.');
      }
    } catch (_) {
      if (hudMode === 'learned' && learnedUndoToken === token) setHud('learned', 'Could not undo. Try again.');
    } finally {
      if (hudMode === 'learned' && learnedUndoToken === token) {
        learnedUndoPending = false;
        btnUndo.disabled = false;
        syncLearnedHold();
      }
    }
  });
  pill.addEventListener('pointerenter', () => { learnedHovered = true; syncLearnedHold(); });
  pill.addEventListener('pointerleave', () => { learnedHovered = false; syncLearnedHold(); });
}

if (label) {
  label.addEventListener('focus', () => beginSuccessEdit());
  label.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      label.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelSuccessEdit = true;
      label.blur();
    }
  });
  label.addEventListener('blur', () => commitSuccessEdit());
  // Island's edited line grows and shrinks with what is typed, on the spring.
  label.addEventListener('input', () => { if (editingSuccess) measureEditLine(); });
}

function onIdleDictate(e) {
  // The release that ends a drag by the bar is not a click on it.
  if (barDragged) {
    barDragged = false;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.target.closest && e.target.closest('.orb-trigger, .orb-actions')) return;
  if (e.target.closest && e.target.closest('.act')) return;
  // The gear and the grip live inside the same hit area as the bar, and this
  // handler is on the document, so without this a click on either would also
  // start a dictation.
  if (e.target.closest && e.target.closest('.flow-side')) return;
  // Pressed on Island's gear or screenshot and let go on the capsule: that
  // click lands on the bar, but nobody meant to dictate.
  if (flowBarStyle === 'island' && pressOnSide) return;
  if (dragging) return;
  if (!pill.classList.contains('idle')) return;
  e.preventDefault();
  e.stopPropagation();
  if (window.voxden) window.voxden.toggle();
}

// Listen on the document, not just the pill: the window only captures the mouse
// while the cursor is in the hover zone, so any click that reaches us there is
// meant for the bar even if it lands a few pixels off the resting shape.
document.addEventListener('click', onIdleDictate);

if (dragHandle) {
  dragHandle.addEventListener('pointerdown', beginFlowDrag);
  dragHandle.addEventListener('pointerup', (e) => {
    e.preventDefault();
    e.stopPropagation();
    endFlowDrag();
  });
  dragHandle.addEventListener('pointercancel', endFlowDrag);
  dragHandle.addEventListener('lostpointercapture', endFlowDrag);
  dragHandle.addEventListener('dragstart', (e) => e.preventDefault());
}

// Every press is a new gesture. Capture phase, so the last drag's click guard
// is dropped before the capsule's own handler arms the next press.
function beginPointerGesture(e) {
  barDragged = false;
  pressOnSide = !!(e.target && e.target.closest && e.target.closest('.flow-side'));
}
window.addEventListener('pointerdown', beginPointerGesture, true);
// The click a release produces is dispatched in the same task as pointerup,
// so a timer set there outlives it and nothing else.
window.addEventListener('pointerup', () => {
  if (pressOnSide) setTimeout(() => { pressOnSide = false; }, 0);
});
pill.addEventListener('pointerdown', armBarPress);
window.addEventListener('pointermove', followBarPress);
pill.addEventListener('pointercancel', endFlowDrag);
pill.addEventListener('lostpointercapture', endFlowDrag);

// Backstops for a release the grip never sees. Windows can take the capture
// away without sending either pointerup or pointercancel -- Alt+Tab and the
// lock screen both do -- and a drag with no end leaves the bar on the cursor.
window.addEventListener('pointerup', endFlowDrag);
window.addEventListener('blur', endFlowDrag);

if (settingsBtn) {
  settingsBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.voxden && typeof window.voxden.overlaySettings === 'function') {
      window.voxden.overlaySettings();
    }
  });
}

if (captureScreenBtn) {
  captureScreenBtn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    if (window.voxden && window.voxden.captureScreen) window.voxden.captureScreen();
  });
}

if (window.voxden) {
  window.voxden.onState((s) => {
    let revealAfterState = !!s.reveal;
    if (s.flowBarMotion !== undefined) window.VoxdenFlowMotion.setPreference(s.flowBarMotion);
    engine = s.engine || engine;
    if (typeof s.alwaysShowFlowBar === 'boolean') {
      alwaysShowFlowBar = s.alwaysShowFlowBar;
      document.body.classList.toggle('always-flow', alwaysShowFlowBar);
    }
    if (s.flowBarStyle !== undefined) applyFlowBarStyle(s.flowBarStyle);
    if (typeof s.soundsEnabled === 'boolean') soundsEnabled = s.soundsEnabled;
    if (s.dictationQuality) dictationQuality = s.dictationQuality;
    if (s.shortcutLabel) shortcutLabel = s.shortcutLabel;
    if (typeof s.canRetry === 'boolean') canRetry = s.canRetry;
    if (s.microphone) micDeviceId = s.microphone;
    if (s.dictateMode) {
      document.body.classList.toggle('ptt', s.dictateMode === 'ptt');
    }
    if (typeof s.pttLocked === 'boolean') {
      const locked = s.pttLocked;
      pttLocked = locked;
      // The lock can land mid-recording, after the title was already set.
      if (locked && !s.mode && capturing) pill.title = recordingTitle(s.dictateMode);
    }
    if (s.engineStatus) {
      engineStatus = s.engineStatus;
      if (typeof s.cloudReady === 'boolean') cloudReady = s.cloudReady;
      pill.title = 'Voxden';
    }
    if (s.mode === 'recording' || (!s.mode && hudMode === 'recording')) pill.title = recordingTitle(s.dictateMode);
    if (s.mode === 'arming') {
      setHud('arming');
      if (s.playStartCue) playCue('start');
      revealAfterState = true;
      if (s.prepareOnly === false && !capturing) startCapture(s.engine);
    } else if (s.mode === 'recording') {
      revealAfterState = true;
      if (!capturing) startCapture(s.engine);
    } else if (s.mode === 'stop') {
      finishCapture(true);
    } else if (s.mode === 'cancel') {
      // Bumping the generation makes any transcription still in flight resolve
      // into a result nobody reads, so a cancel during "transcribing" cannot
      // paste a moment later. No cue: the user asked for this.
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      setHud('cancel', s.text || 'Cancelled');
      revealAfterState = true;
    } else if (s.mode === 'success') {
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      successEntryId = s.entryId ? String(s.entryId) : '';
      setHud('success', s.text || '');
      revealAfterState = true;
      playCue('success');
    } else if (s.mode === 'learned') {
      const token = s.undoToken ? String(s.undoToken) : '';
      if (learnedUndoToken !== token) {
        learnedUndoPending = false;
        // A fresh addition restarts main's notice timer. If the pointer is
        // already over Undo, renew the hold for this new receipt as well.
        if (token && learnedHeld) learnedHeld = false;
      }
      learnedUndoToken = token;
      successEntryId = '';
      setHud('learned', s.text || 'Added to dictionary');
      revealAfterState = true;
    } else if (s.mode === 'error') {
      capturing = false;
      captureGen += 1;
      resetChunkState();
      stopWebSpeech();
      teardownAudio();
      pcmChunks = [];
      setHud('error', s.text || 'Transcription failed');
      revealAfterState = true;
      playCue('error');
    } else if (s.mode === 'idle') {
      successEntryId = '';
      editingSuccess = false;
      setHud('idle');
      if (alwaysShowFlowBar) revealAfterState = true;
      else if (document.body.classList.contains('shown')) popOut();
    } else if (s.mode === 'transcribing') {
      setHud('transcribing');
      revealAfterState = true;
    }
    // Apply the target shape before starting an entrance. Starting popIn on the
    // old idle bar and changing it to arming in the same task made the mic and
    // capsule compete for the first frame.
    if (revealAfterState) popIn();
    syncFlowVisual();
  });

  if (typeof window.voxden.onCursor === 'function') {
    window.voxden.onCursor(onCursor);
  }

  // Main owns the end of a drag as well as the middle of it: if the OS takes
  // the pointer capture away without a pointerup ever reaching us, this is the
  // only signal that the bar has been put down. endFlowDrag self-guards on
  // `dragging`, so the echo it sends back to main is a no-op.
  if (typeof window.voxden.onDragEnd === 'function') {
    window.voxden.onDragEnd(() => endFlowDrag());
  }

  // Main checks both the event loop and frame delivery. IPC can remain alive
  // while Chromium's compositor stops animating; the second acknowledgement
  // lets main recover that native surface without discarding the recording.
  if (typeof window.voxden.onPing === 'function' && typeof window.voxden.pong === 'function') {
    let frameProbe = 0;
    let frameProbeSeq = 0;
    window.voxden.onPing((seq) => {
      window.voxden.pong(seq);
      if (typeof window.voxden.frame !== 'function') return;
      frameProbeSeq = seq;
      // One frame per slow health ping, never an idle animation loop. When
      // Chromium stops rendering, retain just one callback for the latest
      // probe instead of queuing callbacks throughout the stalled period.
      if (frameProbe) return;
      frameProbe = requestAnimationFrame(() => {
        frameProbe = 0;
        window.voxden.frame(frameProbeSeq);
      });
    });
  }

  window.voxden.ready();
  syncFlowVisual();
  setTimeout(() => { if (soundsEnabled) ensureSfxContext(); }, 1000);
}
