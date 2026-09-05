'use strict';

// Shared by the selection canvas and the main process. Capture coordinates are
// local to one display; use the returned bitmap's dimensions, not an assumed DPI.
(function(root) {
  function rectangle(a, b, size) {
    if (![a.x, a.y, b.x, b.y, size.width, size.height].every(Number.isFinite)
      || size.width <= 0 || size.height <= 0) return null;
    const clamp = (n, max) => Math.min(max, Math.max(0, n));
    const x = clamp(Math.min(a.x, b.x), size.width);
    const y = clamp(Math.min(a.y, b.y), size.height);
    return { x, y, width: clamp(Math.max(a.x, b.x), size.width) - x,
      height: clamp(Math.max(a.y, b.y), size.height) - y };
  }

  function pixelCrop(rect, viewport, bitmap) {
    if (!rect || !viewport || !bitmap || ![rect.x, rect.y, rect.width, rect.height,
      viewport.width, viewport.height, bitmap.width, bitmap.height].every(Number.isFinite)) return null;
    if (rect.width < 3 || rect.height < 3 || viewport.width <= 0 || viewport.height <= 0
      || bitmap.width <= 0 || bitmap.height <= 0) return null;
    const box = rectangle({ x: rect.x, y: rect.y },
      { x: rect.x + rect.width, y: rect.y + rect.height }, viewport);
    if (!box || box.width < 3 || box.height < 3) return null;
    const x = Math.floor(box.x * bitmap.width / viewport.width);
    const y = Math.floor(box.y * bitmap.height / viewport.height);
    const right = Math.min(bitmap.width, Math.ceil((box.x + box.width) * bitmap.width / viewport.width));
    const bottom = Math.min(bitmap.height, Math.ceil((box.y + box.height) * bitmap.height / viewport.height));
    return { x, y, width: right - x, height: bottom - y };
  }

  function drawMark(ctx, mark) {
    const a = mark.points[0], b = mark.points[mark.points.length - 1];
    if (!a || !b) return;
    ctx.save();
    ctx.lineWidth = mark.width;
    ctx.strokeStyle = mark.color;
    ctx.fillStyle = mark.color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (mark.tool === 'circle') {
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2,
        Math.max(1, Math.abs(b.x - a.x) / 2), Math.max(1, Math.abs(b.y - a.y) / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (mark.tool === 'hide') {
      // Opaque pixels, never blur: no original pixels survive the exported PNG.
      ctx.fillStyle = '#141719';
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else {
      ctx.moveTo(a.x, a.y);
      if (mark.tool === 'pen') mark.points.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      else ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (mark.tool === 'arrow') {
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const length = Math.max(mark.width * 4, 12);
        ctx.beginPath();
        ctx.moveTo(b.x - length * Math.cos(angle - Math.PI / 6), b.y - length * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(b.x - length * Math.cos(angle + Math.PI / 6), b.y - length * Math.sin(angle + Math.PI / 6));
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  function annotationLayout(rect, viewport) {
    const width = Math.min(368, viewport.width - 16);
    const x = Math.max(8, Math.min(viewport.width - width - 8, rect.x + (rect.width - width) / 2));
    const below = rect.y + rect.height + 10;
    const y = below + 82 <= viewport.height ? below : rect.y >= 92 ? rect.y - 92 : Math.max(8, viewport.height - 90);
    const toolbar = { x: Math.round(x), y: Math.round(y), width, height: 44 };
    const hint = { x: toolbar.x, y: toolbar.y + 49, width, height: 29 };
    const image = { x: Math.max(0, Math.floor(rect.x) - 2), y: Math.max(0, Math.floor(rect.y) - 2),
      width: Math.ceil(rect.width) + 4, height: Math.ceil(rect.height) + 4 };
    return { toolbar, hint, shapes: [image, toolbar, hint] };
  }
  const api = { rectangle, pixelCrop, drawMark, annotationLayout };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.voxdenCaptureGeometry = api;
})(typeof window === 'object' ? window : globalThis);
