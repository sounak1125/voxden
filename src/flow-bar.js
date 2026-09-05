'use strict';

// Where the flow bar sits on screen, and how that survives a display setup
// that changes underneath it.
//
// The bar is placed by an *anchor* rather than by a window rect. The anchor is
// the point the pill's bottom centre occupies; the overlay window is hung off
// it. That distinction matters because the overlay window resizes -- it grows
// while a success line is being edited -- and a rect-based position would slide
// the bar sideways and upwards every time it did.
//
// Everything here is pure arithmetic over plain {x, y, width, height} objects,
// so the main process can hand it Electron displays and the tests can hand it
// invented ones.

// Clearance between the anchor and the bottom of the work area, so the bar is
// never flush against the taskbar.
const BOTTOM_GAP = 4;

// Keep the stored preference safe for both renderers, including settings files
// from older versions that have no style yet.
function normalizeStyle(value) {
  return value === 'ribbon' || value === 'orb' ? value : 'classic';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// A stored anchor is user data that has been through JSON and a settings file,
// so it is only an anchor once it has two finite numbers in it.
function normalizeAnchor(value) {
  if (!value || typeof value !== 'object') return null;
  const x = num(value.x);
  const y = num(value.y);
  if (x === null || y === null) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function sameAnchor(a, b) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y;
}

// The window that hangs off an anchor: half a width to either side of it, and
// a full height above it.
function rectFor(anchor, size) {
  const width = Math.round(size.width);
  const height = Math.round(size.height);
  return {
    x: Math.round(anchor.x - width / 2),
    y: Math.round(anchor.y - height),
    width,
    height,
  };
}

function anchorFor(rect) {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height),
  };
}

// Pull a rect fully inside a work area. A window wider or taller than the
// display it landed on has no legal position -- min crosses over max -- so it
// pins to the top-left corner rather than to a bound that has inverted.
function clampRect(rect, workArea) {
  const maxX = workArea.x + workArea.width - rect.width;
  const maxY = workArea.y + workArea.height - rect.height;
  const x = maxX < workArea.x ? workArea.x : Math.min(Math.max(rect.x, workArea.x), maxX);
  const y = maxY < workArea.y ? workArea.y : Math.min(Math.max(rect.y, workArea.y), maxY);
  return { x: Math.round(x), y: Math.round(y), width: rect.width, height: rect.height };
}

// Expressed through clampRect so the anchor and the window it produces can
// never disagree about what "on screen" means.
function clampAnchor(anchor, workArea, size) {
  return anchorFor(clampRect(rectFor(anchor, size), workArea));
}

function defaultAnchor(workArea, size) {
  return clampAnchor({
    x: workArea.x + workArea.width / 2,
    y: workArea.y + workArea.height - BOTTOM_GAP,
  }, workArea, size);
}

// Distance from a point to a rect, zero when the point is inside it.
function distanceTo(bounds, point) {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return Math.sqrt(dx * dx + dy * dy);
}

// The display an anchor belongs to. Nearest rather than containing, because
// the anchor outlives the monitor it was dropped on: unplug that screen and
// the saved point is suddenly in dead space, and the bar has to come back
// somewhere the user can still see it.
function displayForPoint(displays, point) {
  let best = null;
  let bestDist = Infinity;
  for (const d of displays || []) {
    if (!d || !d.bounds || !d.workArea) continue;
    const dist = distanceTo(d.bounds, point);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
      if (dist === 0) break;
    }
  }
  return best;
}

function usable(displays) {
  return (Array.isArray(displays) ? displays : []).filter((d) => d && d.bounds && d.workArea);
}

// The one entry point the app uses: given whatever was saved and whatever
// monitors exist right now, where does the bar go?
function resolveAnchor(saved, displays, primary, size) {
  const list = usable(displays);
  const home = (primary && primary.workArea && primary.bounds) ? primary : (list[0] || null);
  const anchor = normalizeAnchor(saved);
  if (!anchor) {
    return home ? defaultAnchor(home.workArea, size) : { x: 0, y: 0 };
  }
  const display = displayForPoint(list, anchor) || home;
  if (!display) return anchor;
  return clampAnchor(anchor, display.workArea, size);
}

module.exports = {
  BOTTOM_GAP,
  normalizeStyle,
  normalizeAnchor,
  sameAnchor,
  rectFor,
  anchorFor,
  clampRect,
  clampAnchor,
  defaultAnchor,
  displayForPoint,
  resolveAnchor,
};
