'use strict';

(async function() {
  const api = window.capture, geometry = window.voxdenCaptureGeometry;
  const $ = id => document.getElementById(id);
  const canvas = $('image-canvas'), context = canvas.getContext('2d');
  let stage = 'selecting', revision = 0, original = null, marks = [], redo = [], drawing = null;
  let tool = 'circle', speech = 'idle', shortcut = '', retry = false;
  let selectionStart = null, selectionRect = null, selecting = false;

  function status(message, error = false) {
    $('status').textContent = message;
    $('hint').title = message;
    $('hint').classList.toggle('error', error);
  }
  function controls() {
    const finishing = stage === 'finishing';
    document.body.classList.toggle('finishing', finishing);
    document.querySelectorAll('[data-tool]').forEach(button => { button.disabled = finishing; });
    $('undo').disabled = finishing || !marks.length;
    $('retake').disabled = finishing;
    $('voice').disabled = finishing || speech === 'arming';
    $('voice').classList.toggle('recording', speech === 'recording');
    $('hint').classList.toggle('recording', speech === 'recording');
    const label = retry ? 'Retry paste (' + shortcut + ')' : speech === 'recording'
      ? 'Stop and paste (' + shortcut + ')' : 'Start speaking (' + shortcut + ')';
    $('voice').title = label;
    $('voice').setAttribute('aria-label', label);
  }
  function loadImage(image, url) {
    // onload also settles on hidden surfaces, unlike decode() on some Chromium builds.
    return new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('The screenshot could not be loaded.'));
      image.src = url;
    });
  }
  function place(element, rect) {
    Object.assign(element.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
  }
  async function annotate(data) {
    const image = new Image();
    await loadImage(image, data.image);
    original = image; revision = data.revision; shortcut = data.shortcut;
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    place($('capture-region'), data.rect);
    place($('toolbar'), data.layout.toolbar);
    place($('hint'), data.layout.hint);
    $('annotation').hidden = false;
    $('selection').hidden = true;
    // Release the full display image; only the crop remains in the renderer.
    $('desktop').removeAttribute('src');
    $('selection-canvas').width = $('selection-canvas').height = 0;
    stage = 'annotating'; redraw(); controls();
    const result = await api.action('annotation-ready', { revision });
    if (!result.ok) { status(result.reason, true); await api.action('cancel'); }
  }
  function redraw() {
    if (!original) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(original, 0, 0);
    marks.forEach(mark => geometry.drawMark(context, mark));
    if (drawing) geometry.drawMark(context, drawing);
  }
  function point(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
      y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)) };
  }
  function finishMark() {
    if (!drawing) return;
    const a = drawing.points[0], b = drawing.points[drawing.points.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) > 2 || drawing.points.length > 3) { marks.push(drawing); redo = []; }
    drawing = null; redraw(); controls();
  }
  canvas.addEventListener('pointerdown', event => {
    if (stage !== 'annotating' || event.button !== 0) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const p = point(event), bounds = canvas.getBoundingClientRect();
    drawing = { tool, color: '#f47d6d', width: Math.max(2, 2.5 * canvas.width / bounds.width), points: [p, p] };
  });
  canvas.addEventListener('pointermove', event => {
    if (!drawing || stage !== 'annotating') return;
    if (drawing.tool === 'pen' && drawing.points.length < 10000) drawing.points.push(point(event));
    else drawing.points[drawing.points.length - 1] = point(event);
    redraw();
  });
  canvas.addEventListener('pointerup', event => {
    if (!drawing) return;
    drawing.points[drawing.points.length - 1] = point(event);
    finishMark();
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  function cancelDrawing() { drawing = null; redraw(); }
  canvas.addEventListener('pointercancel', cancelDrawing);
  canvas.addEventListener('lostpointercapture', cancelDrawing);
  function selectTool(next) {
    tool = next;
    document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === tool)));
  }
  document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => selectTool(button.dataset.tool)));
  function undoMark() {
    if (stage !== 'annotating' || !marks.length) return;
    redo.push(marks.pop()); redraw(); controls();
  }
  $('undo').addEventListener('click', undoMark);
  async function action(name) {
    try {
      const result = await api.action(name);
      if (!result.ok) status(result.reason, true);
    } catch (_) { /* Closing destroys this surface and its outstanding IPC call. */ }
  }
  $('close').addEventListener('click', () => action('cancel'));
  $('retake').addEventListener('click', () => action('retake'));
  $('voice').addEventListener('click', () => action(retry ? 'retry' : 'voice'));

  function renderSelection() {
    const surface = $('selection-canvas'), dpr = window.devicePixelRatio || 1;
    surface.width = Math.round(innerWidth * dpr); surface.height = Math.round(innerHeight * dpr);
    const ctx = surface.getContext('2d'); ctx.scale(dpr, dpr);
    ctx.fillStyle = 'rgba(5,12,8,.48)'; ctx.fillRect(0, 0, innerWidth, innerHeight);
    $('selection-size').hidden = !selectionRect;
    if (!selectionRect) return;
    const r = selectionRect;
    ctx.clearRect(r.x, r.y, r.width, r.height);
    ctx.strokeStyle = '#b8d5c8'; ctx.lineWidth = 1.5; ctx.strokeRect(r.x, r.y, r.width, r.height);
    const size = $('selection-size');
    size.textContent = Math.round(r.width) + ' × ' + Math.round(r.height);
    size.style.left = Math.max(5, Math.min(innerWidth - 110, r.x + r.width - 90)) + 'px';
    size.style.top = Math.max(5, Math.min(innerHeight - 30, r.y + r.height + 10)) + 'px';
  }
  const selectCanvas = $('selection-canvas');
  selectCanvas.addEventListener('pointerdown', event => {
    if (selecting || event.button !== 0) return;
    selectionStart = { x: event.clientX, y: event.clientY };
    selectionRect = null; selectCanvas.setPointerCapture(event.pointerId);
  });
  selectCanvas.addEventListener('pointermove', event => {
    if (!selectionStart || selecting) return;
    selectionRect = geometry.rectangle(selectionStart, { x: event.clientX, y: event.clientY }, { width: innerWidth, height: innerHeight });
    renderSelection();
  });
  selectCanvas.addEventListener('pointerup', async event => {
    if (!selectionStart || selecting) return;
    selectionRect = geometry.rectangle(selectionStart, { x: event.clientX, y: event.clientY }, { width: innerWidth, height: innerHeight });
    selectionStart = null;
    if (selectCanvas.hasPointerCapture(event.pointerId)) selectCanvas.releasePointerCapture(event.pointerId);
    renderSelection();
    if (!selectionRect || selectionRect.width < 3 || selectionRect.height < 3) return;
    selecting = true;
    try {
      const result = await api.select(selectionRect);
      if (result.ok) await annotate(result);
      else document.querySelector('.selection-hint strong').textContent = result.reason;
    } catch (_) { await action('cancel'); }
    finally { selecting = false; }
  });
  selectCanvas.addEventListener('pointercancel', () => { selectionStart = null; selectionRect = null; renderSelection(); });
  window.addEventListener('resize', () => { if (stage === 'selecting') renderSelection(); });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); action('cancel'); return; }
    if (stage !== 'annotating') return;
    if (event.ctrlKey && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey && redo.length) { marks.push(redo.pop()); redraw(); controls(); }
      else undoMark();
    } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
      const next = { c: 'circle', a: 'arrow', p: 'pen', h: 'hide' }[event.key.toLowerCase()];
      if (next) { event.preventDefault(); selectTool(next); }
    }
  });
  api.onEvent(async data => {
    if (data.shortcut) shortcut = data.shortcut;
    if (data.type === 'speech') {
      speech = data.mode;
      if (['stop', 'transcribing'].includes(speech)) {
        finishMark(); stage = 'finishing'; status('Preparing screenshot and speech…');
      } else if (speech === 'recording') {
        stage = 'annotating'; retry = false; status('Speak · ' + shortcut + ' to paste');
      } else if (speech === 'arming') status('Starting microphone…');
      else if (speech === 'error') {
        stage = 'annotating';
        if (!retry) status(data.message + ' · ' + shortcut + ' to try again', true);
      }
      controls();
    } else if (data.type === 'error') {
      stage = 'annotating'; speech = 'idle'; retry = data.retry;
      status(data.message, true); controls();
    } else if (data.type === 'export') {
      finishMark(); stage = 'finishing'; controls(); status('Pasting screenshot and text…');
      await api.action('export', { requestId: data.requestId, revision, image: canvas.toDataURL('image/png') });
    }
  });
  try {
    const data = await api.load();
    shortcut = data.shortcut;
    await loadImage($('desktop'), data.image);
    renderSelection();
    await api.action('ready');
  } catch (_) { await action('load-failed'); }
})();
