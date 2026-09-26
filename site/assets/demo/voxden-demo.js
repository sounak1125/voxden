/*
 * Voxden live demo: a clickable replica of the Voxden desktop app.
 *
 * Two mounts that share one state, built entirely from here:
 *   <div class="vx-demo vx-demo--app" data-voxden-demo="app">        the app window
 *   <div class="vx-demo vx-demo--dictation" data-voxden-demo="dictation">  the playground
 * A dictation made in the playground lands in the app's Recent dictations and
 * stats. Either mount also works on its own.
 *
 * It is scripted: nothing is recorded, nothing leaves the page, and every text
 * in it is invented sample data.
 *
 * Events on document, for anything that wants to follow along:
 *   voxden:dictation    detail { state }  'recording' | 'transcribing' | 'success' | 'idle'
 *   voxden:voice-level  detail { level }  0..1, about 25 times a second while recording
 *
 * Vanilla ES2019, no dependencies, one IIFE. The only global is
 * window.VoxdenDemo ({ version, mount }).
 */
(function () {
  'use strict';

  if (window.VoxdenDemo && window.VoxdenDemo.version) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  let instanceCount = 0;

  // ---------------------------------------------------------------------------
  // Timing. The flow bar keeps the real app's: a result that offers Polish
  // stays three seconds, hovering the bar holds it, and it leaves 2.5 s after
  // the pointer does.
  const ARMING_MS = 190;
  const TRANSCRIBE_MS = 720;
  const CAPTION_LINGER_MS = 260;
  const SUCCESS_MS = 3000;
  const SUCCESS_RELEASE_MS = 2500;
  const POLISH_MS = 950;
  const POLISHED_MS = 2600;
  const CANCEL_MS = 1400;
  const PAGE_POLISH_MS = 900;
  const LEVEL_MS = 36; // about 25 events a second once timers jitter
  // Under this width the app becomes a card with tabs and the playground stacks
  // (the stylesheet's container queries use the same number).
  const COMPACT_BELOW = 720;
  const POLISH_CREDITS = 0.25; // per 100 words begun; every sample is under 100

  // ---------------------------------------------------------------------------
  // DOM helpers.
  function h(tag, props, kids) {
    const node = document.createElement(tag);
    if (props) setProps(node, props);
    if (kids != null) add(node, kids);
    return node;
  }

  function s(tag, attrs, kids) {
    const node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        if (attrs[key] != null) node.setAttribute(key, String(attrs[key]));
      }
    }
    if (kids != null) add(node, kids);
    return node;
  }

  function setProps(node, props) {
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'on') {
        for (const type of Object.keys(value)) node.addEventListener(type, value[type]);
      } else if (key === 'style') {
        for (const prop of Object.keys(value)) node.style.setProperty(prop, value[prop]);
      } else node.setAttribute(key, value === true ? '' : String(value));
    }
  }

  function add(node, kids) {
    if (Array.isArray(kids)) {
      for (const kid of kids) add(node, kid);
      return;
    }
    if (kids == null || kids === false) return;
    node.appendChild(typeof kids === 'string' || typeof kids === 'number'
      ? document.createTextNode(String(kids)) : kids);
  }

  function empty(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setTabbable(node, on) {
    node.tabIndex = on ? 0 : -1;
  }

  function keyboardFocus(node) {
    try {
      return node.matches(':focus-visible');
    } catch (_) {
      return true;
    }
  }

  const fmt = new Intl.NumberFormat('en-US');
  function num(n) {
    return fmt.format(Math.round(n));
  }

  function clock12(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function wordCount(text) {
    return String(text || '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }

  function minutesAgo(now, minutes) {
    return new Date(now.getTime() - minutes * 60000);
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  // ---------------------------------------------------------------------------
  // Icons. Paths follow the real app's (src/app.html, src/overlay.html).
  const RS = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  function st(width, extra) {
    return Object.assign({}, RS, { 'stroke-width': width }, extra || {});
  }

  const ICONS = {
    dictation: ['0 0 24 24', [
      ['rect', st(1.75, { x: 9, y: 3, width: 6, height: 11, rx: 3 })],
      ['path', st(1.75, { d: 'M5.75 11.5a6.25 6.25 0 0 0 12.5 0M12 17.75V21M9.25 21h5.5' })],
    ]],
    dictionary: ['0 0 24 24', [
      ['path', st(1.75, { d: 'M5 4.75A2.75 2.75 0 0 1 7.75 2H19v17.5H7.75A2.75 2.75 0 0 0 5 22.25V4.75Z' })],
      ['path', st(1.75, { d: 'M5 19.5a2.75 2.75 0 0 1 2.75-2.75H19M9 7h6M9 10.5h4.5' })],
    ]],
    style: ['0 0 24 24', [
      ['path', st(1.75, { d: 'm4 20 4.25-1 10.2-10.2a2.12 2.12 0 0 0-3-3L5.25 16 4 20Zm10-12.75 3 3M8.25 19l-3-3' })],
    ]],
    polish: ['0 0 24 24', [
      ['path', st(1.75, { d: 'M10 3.5c.7 3.7 2.3 5.3 6 6-3.7.7-5.3 2.3-6 6-.7-3.7-2.3-5.3-6-6 3.7-.7 5.3-2.3 6-6Z' })],
      ['path', st(1.6, { d: 'M18 14.25c.35 1.75 1.05 2.45 2.75 2.75-1.7.35-2.4 1.05-2.75 2.75-.35-1.7-1.05-2.4-2.75-2.75 1.7-.3 2.4-1 2.75-2.75Z' })],
    ]],
    insights: ['0 0 24 24', [
      ['path', st(1.75, { d: 'M4 19V5m0 14h16M7.5 15l3.3-3.5 2.8 2.35L18.5 8' })],
      ['circle', { cx: 18.5, cy: 8, r: 1.5, fill: 'currentColor' }],
    ]],
    bell: ['0 0 24 24', [
      ['path', st(1.7, { d: 'M18 9.5a6 6 0 1 0-12 0c0 4.1-1.4 5.3-1.9 5.9a.9.9 0 0 0 .7 1.5h14.4a.9.9 0 0 0 .7-1.5c-.5-.6-1.9-1.8-1.9-5.9Z' })],
      ['path', st(1.7, { d: 'M10.1 19.6a2.2 2.2 0 0 0 3.8 0' })],
    ]],
    search: ['0 0 24 24', [
      ['circle', st(2, { cx: 11, cy: 11, r: 7 })],
      ['path', st(2, { d: 'M20 20l-3.6-3.6' })],
    ]],
    mic: ['0 0 24 24', [
      ['path', { fill: 'currentColor', d: 'M12 2.5a3.25 3.25 0 0 0-3.25 3.25v6.5a3.25 3.25 0 1 0 6.5 0v-6.5A3.25 3.25 0 0 0 12 2.5z' }],
      ['path', st(1.8, { d: 'M6.75 11.25a5.25 5.25 0 0 0 10.5 0M12 16.5v3.25M9.25 19.75h5.5' })],
    ]],
    gear: ['0 0 16 16', [
      ['circle', { cx: 8, cy: 8, r: 5.6, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-dasharray': '2.2 2.2' }],
      ['circle', { cx: 8, cy: 8, r: 3.9, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }],
    ]],
    shot: ['0 0 16 16', [
      ['path', st(1.5, { d: 'M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2' })],
      ['circle', { cx: 8, cy: 8, r: 2, fill: 'currentColor' }],
    ]],
    x: ['0 0 16 16', [
      ['path', st(1.6, { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' })],
    ]],
    xBold: ['0 0 16 16', [
      ['path', st(2.1, { d: 'M4 4l8 8M12 4l-8 8' })],
    ]],
    check: ['0 0 16 16', [
      ['path', st(2.2, { d: 'M3.2 8.4l3.2 3.2 6.4-6.8' })],
    ]],
    bang: ['0 0 16 16', [
      ['path', st(2.3, { d: 'M8 3.6v5.2' })],
      ['circle', { cx: 8, cy: 12.2, r: 1.35, fill: 'currentColor' }],
    ]],
    stop: ['0 0 16 16', [
      ['rect', { x: 3.5, y: 3.5, width: 9, height: 9, rx: 2.25, fill: 'currentColor' }],
    ]],
    sparkle: ['0 0 16 16', [
      ['path', { fill: 'currentColor', d: 'M6.6 1.6c.5 2.8 1.4 3.7 4.2 4.2-2.8.5-3.7 1.4-4.2 4.2-.5-2.8-1.4-3.7-4.2-4.2 2.8-.5 3.7-1.4 4.2-4.2Z' }],
      ['path', { fill: 'currentColor', d: 'M12.2 9.3c.26 1.3.66 1.7 1.96 1.96-1.3.26-1.7.66-1.96 1.96-.26-1.3-.66-1.7-1.96-1.96 1.3-.26 1.7-.66 1.96-1.96Z' }],
    ]],
    sparkleSolid: ['0 0 24 24', [
      ['path', { fill: 'currentColor', d: 'M11 4c.8 4 2.6 5.8 6.6 6.6-4 .8-5.8 2.6-6.6 6.6-.8-4-2.6-5.8-6.6-6.6 4-.8 5.8-2.6 6.6-6.6Z' }],
    ]],
    grammar: ['0 0 24 24', [
      ['path', st(1.8, { d: 'M4 17.5 8.5 6l4.5 11.5M5.8 13.2h5.4' })],
      ['path', st(1.8, { d: 'm14.5 14.5 2.6 2.6 4.4-5.6' })],
    ]],
    tighten: ['0 0 24 24', [
      ['path', st(1.8, { d: 'M4 12h6m0 0-2.8-2.8M10 12l-2.8 2.8M20 12h-6m0 0 2.8-2.8M14 12l2.8 2.8' })],
    ]],
    formal: ['0 0 24 24', [
      ['rect', st(1.3, { x: 4, y: 6, width: 16, height: 12, rx: 2 })],
      ['path', st(1.3, { d: 'm5 7 7 6 7-6' })],
    ]],
    casual: ['0 0 24 24', [
      ['path', st(1.3, { d: 'M7 18 4 21V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3Z' })],
      ['path', st(1.3, { d: 'M8 9h8M8 13h5' })],
    ]],
    veryCasual: ['0 0 24 24', [
      ['circle', st(1.3, { cx: 12, cy: 12, r: 8 })],
      ['path', st(1.3, { d: 'M8 14s1 3 4 3 4-3 4-3M8 9h.01M15 9l2 1-2 1' })],
    ]],
    voiceBars: ['0 0 24 24', [
      ['path', st(1.7, { d: 'M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4' })],
    ]],
    polishedArrow: ['0 0 22 28', [
      ['path', st(1.6, { d: 'M6 1v12.5a6 6 0 0 0 6 6h7' })],
      ['path', st(1.6, { d: 'M15.5 16l3.5 3.5-3.5 3.5' })],
    ]],
    plus: ['0 0 16 16', [
      ['path', st(1.8, { d: 'M8 3v10M3 8h10' })],
    ]],
    trash: ['0 0 16 16', [
      ['path', st(1.4, { d: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1' })],
    ]],
    star: ['0 0 16 16', [
      ['path', { fill: 'currentColor', d: 'M8 1.8l1.7 3.8 4.1.4-3.1 2.8.9 4-3.6-2.1-3.6 2.1.9-4L2.2 6l4.1-.4Z' }],
    ]],
    copy: ['0 0 16 16', [
      ['rect', st(1.4, { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.6 })],
      ['path', st(1.4, { d: 'M10.5 5.5V3.9a1.4 1.4 0 0 0-1.4-1.4H3.9a1.4 1.4 0 0 0-1.4 1.4v5.2a1.4 1.4 0 0 0 1.4 1.4h1.6' })],
    ]],
    send: ['0 0 16 16', [
      ['path', { fill: 'currentColor', d: 'M2.2 2.6a.6.6 0 0 1 .8-.7l10.9 5.5a.7.7 0 0 1 0 1.2L3 14.1a.6.6 0 0 1-.8-.7l1.2-4.6h5.1a.8.8 0 0 0 0-1.6H3.4Z' }],
    ]],
    speaker: ['0 0 16 16', [
      ['path', { fill: 'currentColor', d: 'M7.4 2.9a.6.6 0 0 1 1 .5v9.2a.6.6 0 0 1-1 .5L4.6 10.6H2.8A.8.8 0 0 1 2 9.8V6.2a.8.8 0 0 1 .8-.8h1.8Z' }],
      ['path', st(1.4, { d: 'M10.6 5.6a3.3 3.3 0 0 1 0 4.8M12.3 3.9a5.7 5.7 0 0 1 0 8.2' })],
    ]],
    speakerOff: ['0 0 16 16', [
      ['path', { fill: 'currentColor', d: 'M7.4 2.9a.6.6 0 0 1 1 .5v9.2a.6.6 0 0 1-1 .5L4.6 10.6H2.8A.8.8 0 0 1 2 9.8V6.2a.8.8 0 0 1 .8-.8h1.8Z' }],
      ['path', st(1.4, { d: 'M10.7 6.2l3.6 3.6M14.3 6.2l-3.6 3.6' })],
    ]],
    chevronLeft: ['0 0 16 16', [
      ['path', st(1.8, { d: 'M9.8 3.8 5.6 8l4.2 4.2' })],
    ]],
    chevronUp: ['0 0 16 16', [
      ['path', st(1.8, { d: 'M3.8 9.8 8 5.6l4.2 4.2' })],
    ]],
    chevronRight: ['0 0 16 16', [
      ['path', st(1.6, { d: 'M6 3.8 10.2 8 6 12.2' })],
    ]],
    clock: ['0 0 24 24', [
      ['circle', st(1.7, { cx: 12, cy: 12, r: 7.25 })],
      ['path', st(1.7, { d: 'M12 12V9.4M12 12l2.75 1.75' })],
    ]],
    chat: ['0 0 16 16', [
      ['path', st(1.4, { d: 'M4.6 12.4 2.5 14V4.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v5.9a2 2 0 0 1-2 2Z' })],
    ]],
    mail: ['0 0 16 16', [
      ['rect', st(1.4, { x: 2, y: 3.5, width: 12, height: 9, rx: 1.6 })],
      ['path', st(1.4, { d: 'm2.7 4.4 5.3 4.3 5.3-4.3' })],
    ]],
    language: ['0 0 16 16', [
      ['path', st(1.35, { d: 'M2 3.5h6.5M5.25 2v1.5M7.3 3.5c-.5 2.6-2.1 4.7-4.6 6M4.2 6.2c.9 1.3 2 2.3 3.4 3' })],
      ['path', st(1.35, { d: 'm8.6 14 2.6-6.2 2.6 6.2M9.5 12h3.4' })],
    ]],
    hash: ['0 0 16 16', [
      ['path', st(1.5, { d: 'M6.3 2.5 5 13.5M11 2.5 9.7 13.5M3 6h10.5M2.5 10H13' })],
    ]],
    home: ['0 0 16 16', [
      ['path', st(1.4, { d: 'M2.8 7.2 8 3l5.2 4.2V13a.8.8 0 0 1-.8.8H9.6v-3.3H6.4v3.3H3.6a.8.8 0 0 1-.8-.8Z' })],
    ]],
    dms: ['0 0 16 16', [
      ['path', st(1.4, { d: 'M5 11 2.5 13V4.3A1.8 1.8 0 0 1 4.3 2.5h6.4a1.8 1.8 0 0 1 1.8 1.8v4.9A1.8 1.8 0 0 1 10.7 11Z' })],
      ['path', st(1.4, { d: 'M5.5 6.4h4M5.5 8.6h2.6' })],
    ]],
    at: ['0 0 16 16', [
      ['circle', st(1.4, { cx: 8, cy: 8, r: 2.4 })],
      ['path', st(1.4, { d: 'M10.4 8v.9a1.7 1.7 0 0 0 3.4 0V8a5.8 5.8 0 1 0-2.3 4.6' })],
    ]],
    bold: ['0 0 16 16', [
      ['path', st(1.6, { d: 'M4.5 3h4.2a2.4 2.4 0 0 1 0 4.8H4.5ZM4.5 7.8h4.9a2.6 2.6 0 0 1 0 5.2H4.5Z' })],
    ]],
    link: ['0 0 16 16', [
      ['path', st(1.4, { d: 'M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.9-.9' })],
    ]],
    smile: ['0 0 16 16', [
      ['circle', st(1.4, { cx: 8, cy: 8, r: 5.8 })],
      ['path', st(1.4, { d: 'M5.6 9.4s.8 1.5 2.4 1.5 2.4-1.5 2.4-1.5M6 6.3h.01M10 6.3h.01' })],
    ]],
    paperclip: ['0 0 16 16', [
      ['path', st(1.4, { d: 'm12.6 7.6-4.9 4.9a3 3 0 0 1-4.2-4.2l5.2-5.2a2 2 0 0 1 2.8 2.8l-5.1 5.1a1 1 0 0 1-1.4-1.4l4.6-4.6' })],
    ]],
    more: ['0 0 16 16', [
      ['circle', { cx: 3.5, cy: 8, r: 1.2, fill: 'currentColor' }],
      ['circle', { cx: 8, cy: 8, r: 1.2, fill: 'currentColor' }],
      ['circle', { cx: 12.5, cy: 8, r: 1.2, fill: 'currentColor' }],
    ]],
    inbox: ['0 0 16 16', [
      ['path', st(1.4, { d: 'M2.5 9.5 4.2 3.8a1 1 0 0 1 1-.8h5.6a1 1 0 0 1 1 .8l1.7 5.7v2.7a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8Z' })],
      ['path', st(1.4, { d: 'M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2' })],
    ]],
    settings: ['0 0 24 24', [
      ['circle', st(1.75, { cx: 12, cy: 12, r: 3 })],
      ['path', st(1.75, { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.57V21a2 2 0 0 1-4 0v-.07a1.7 1.7 0 0 0-1.04-1.57 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3.07 14H3a2 2 0 0 1 0-4h.07A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3.07V3a2 2 0 0 1 4 0v.07A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9 1.7 1.7 0 0 0 20.93 10H21a2 2 0 0 1 0 4h-.07A1.7 1.7 0 0 0 19.4 15Z' })],
    ]],
    catGeneral: ['0 0 24 24', [
      ['path', st(1.6, { d: 'M4 7.5h3.5m5 0H20M4 16.5h7.5m5 0H20' })],
      ['circle', st(1.6, { cx: 10, cy: 7.5, r: 2.5, fill: 'currentColor', 'fill-opacity': '.14' })],
      ['circle', st(1.6, { cx: 14, cy: 16.5, r: 2.5, fill: 'currentColor', 'fill-opacity': '.14' })],
    ]],
    catAccount: ['0 0 24 24', [
      ['circle', st(1.6, { cx: 12, cy: 8.5, r: 3.5, fill: 'currentColor', 'fill-opacity': '.1' })],
      ['path', st(1.6, { d: 'M5 19.5c1.2-3.4 3.8-5 7-5s5.8 1.6 7 5' })],
    ]],
    catBilling: ['0 0 24 24', [
      ['rect', st(1.6, { x: 3, y: 5, width: 18, height: 14, rx: 3 })],
      ['path', st(1.6, { d: 'M3 10h18M7 15h4' })],
    ]],
    catEngines: ['0 0 24 24', [
      ['rect', st(1.6, { x: 5.5, y: 5.5, width: 13, height: 13, rx: 3, fill: 'currentColor', 'fill-opacity': '.1' })],
      ['path', st(1.6, { d: 'M9 3v2.5M15 3v2.5M9 18.5V21M15 18.5V21M3 9h2.5M3 15h2.5M18.5 9H21M18.5 15H21' })],
      ['path', st(1.6, { d: 'M9 11v2m3-4v6m3-4v2' })],
    ]],
    catSystem: ['0 0 24 24', [
      ['rect', st(1.6, { x: 3, y: 4, width: 18, height: 12.5, rx: 2.5, fill: 'currentColor', 'fill-opacity': '.1' })],
      ['path', st(1.6, { d: 'M9 20h6m-3-3.5V20' })],
      ['path', st(1.6, { d: 'M7 13h10', opacity: '.45' })],
    ]],
    catDisplay: ['0 0 24 24', [
      ['path', st(1.6, { d: 'M12 3a9 9 0 1 0 0 18h1.2a2.3 2.3 0 0 0 1.6-3.9 1.4 1.4 0 0 1 1-2.4H18a3 3 0 0 0 3-3A8.8 8.8 0 0 0 12 3Z' })],
      ['circle', { cx: 7.5, cy: 11, r: 0.8, fill: 'currentColor' }],
      ['circle', { cx: 10, cy: 7.5, r: 0.8, fill: 'currentColor' }],
      ['circle', { cx: 14.5, cy: 7.5, r: 0.8, fill: 'currentColor' }],
    ]],
    catSound: ['0 0 24 24', [
      ['path', st(1.6, { d: 'M4.5 9H7l4.5-3.5v13L7 15H4.5A1.5 1.5 0 0 1 3 13.5v-3A1.5 1.5 0 0 1 4.5 9Z', fill: 'currentColor', 'fill-opacity': '.14' })],
      ['path', st(1.6, { d: 'M15 9a4.25 4.25 0 0 1 0 6' })],
      ['path', st(1.6, { d: 'M18 6a8.5 8.5 0 0 1 0 12', opacity: '.55' })],
    ]],
    catPrivacy: ['0 0 24 24', [
      ['path', st(1.6, { d: 'm12 3 7 3v6c0 4.2-2.8 6.8-7 9-4.2-2.2-7-4.8-7-9V6l7-3Z', fill: 'currentColor', 'fill-opacity': '.1' })],
      ['path', st(1.6, { d: 'm9 11.5 2 2 4-4' })],
    ]],
    close: ['0 0 16 16', [
      ['path', st(1.6, { d: 'M4 4l8 8M12 4l-8 8' })],
    ]],
    trendUp: ['0 0 16 16', [
      ['path', st(1.5, { d: 'M3 10.5 6.5 7l2.5 2.5L13 5.5M9.8 5.5H13v3.2' })],
    ]],
    winMin: ['0 0 10 10', [['path', { d: 'M0 5.5h10', stroke: 'currentColor', 'stroke-width': 1, fill: 'none' }]]],
    winMax: ['0 0 10 10', [['rect', { x: 0.5, y: 0.5, width: 9, height: 9, rx: 1.5, stroke: 'currentColor', 'stroke-width': 1, fill: 'none' }]]],
    winClose: ['0 0 10 10', [['path', { d: 'M.5.5l9 9M9.5.5l-9 9', stroke: 'currentColor', 'stroke-width': 1, fill: 'none', 'stroke-linecap': 'round' }]]],
    folder: ['0 0 24 24', [
      ['path', { fill: '#e8b64a', d: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z' }],
      ['path', { fill: '#f6cf6a', d: 'M3 9.5A1.5 1.5 0 0 1 4.5 8h15A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z' }],
    ]],
    wifi: ['0 0 16 16', [
      ['path', st(1.3, { d: 'M1.8 6.1a9 9 0 0 1 12.4 0M3.9 8.4a6 6 0 0 1 8.2 0M6 10.7a3 3 0 0 1 4 0' })],
      ['circle', { cx: 8, cy: 12.8, r: 0.9, fill: 'currentColor' }],
    ]],
    volume: ['0 0 16 16', [
      ['path', { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linejoin': 'round', d: 'M7.4 3.3 4.7 5.8H2.9a.6.6 0 0 0-.6.6v3.2c0 .3.3.6.6.6h1.8l2.7 2.5V3.3Z' }],
      ['path', st(1.2, { d: 'M10.3 5.9a3 3 0 0 1 0 4.2M12.1 4.2a5.4 5.4 0 0 1 0 7.6' })],
    ]],
    battery: ['0 0 16 16', [
      ['rect', { x: 1.6, y: 4.6, width: 11.2, height: 6.8, rx: 1.6, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2 }],
      ['rect', { x: 3.1, y: 6.1, width: 6.6, height: 3.8, rx: 0.7, fill: 'currentColor' }],
      ['path', { d: 'M14 7v2', stroke: 'currentColor', 'stroke-width': 1.3, 'stroke-linecap': 'round' }],
    ]],
    caretUp: ['0 0 16 16', [
      ['path', st(1.4, { d: 'M4.5 9.8 8 6.3l3.5 3.5' })],
    ]],
  };

  // Greeting marks, drawn still: the real app moves them slowly, and this page
  // moves nothing while it waits.
  const GREETING_ICONS = {
    dawn: [['path', { class: 'vx-gi-sun', d: 'M7 18a5 5 0 0 1 10 0' }], ['path', { class: 'vx-gi-sun', d: 'M12 9.5V7.5M5.3 12.3l-1.4-1.4M18.7 12.3l1.4-1.4' }], ['path', { class: 'vx-gi-ink', d: 'M3 18h18' }]],
    morning: [['circle', { class: 'vx-gi-sun', cx: 12, cy: 12, r: 4 }], ['path', { class: 'vx-gi-sun', d: 'M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18' }]],
    afternoon: [['path', { class: 'vx-gi-sun', d: 'M10.2 9.2a4 4 0 0 1 7.3 1.6' }], ['path', { class: 'vx-gi-sun', d: 'M14 3v1.6M8.3 5.3l1.1 1.1M19.7 5.3l-1.1 1.1M21.5 10.5h-1.6' }], ['path', { class: 'vx-gi-ink', d: 'M7.5 19.5h8.8a3 3 0 0 0 .4-5.97A4.5 4.5 0 0 0 8 12.6a3.5 3.5 0 0 0-.5 6.9z' }]],
    evening: [['path', { class: 'vx-gi-sun', d: 'M7 18a5 5 0 0 1 10 0' }], ['path', { class: 'vx-gi-sun', d: 'M12 9.5V8M5.6 12.6l-1-1M18.4 12.6l1-1' }], ['path', { class: 'vx-gi-ink', d: 'M3 18h18' }], ['path', { class: 'vx-gi-ink', d: 'M8 21.2h8', opacity: '.55' }]],
    night: [['path', { class: 'vx-gi-ink', d: 'M19 14.2A7.5 7.5 0 1 1 9.8 5a6 6 0 0 0 9.2 9.2z' }], ['path', { class: 'vx-gi-star', d: 'M16.5 4v2.4M15.3 5.2h2.4' }], ['path', { class: 'vx-gi-star', d: 'M20.5 8.2v1.6M19.7 9h1.6' }]],
  };

  function icon(name, size, cls) {
    const def = ICONS[name];
    const svg = s('svg', {
      viewBox: def[0],
      width: size,
      height: size,
      'aria-hidden': 'true',
      focusable: 'false',
      class: 'vx-ico' + (cls ? ' ' + cls : ''),
    });
    for (const part of def[1]) svg.appendChild(s(part[0], part[1]));
    return svg;
  }

  // The Voxden mark (site/assets/img/logo.svg without its filters). Its
  // gradients live once per demo in a hidden <svg>, so every copy of the mark
  // can point at them without repeating an id.
  const LOGO_RIGHT = 'M21.93 29.54 L31.69 10 C32.45 8.48 34.16 7.6 35.53 7.47 C34.17 10.46 32.37 14.51 32.53 16.25 C32.67 17.89 33.66 18.6 35.17 18.39 L40.11 17.7 L31.76 34.77 L27.14 37.02 Z';
  const LOGO_FOLD = 'M21.93 29.54 L26.75 19.89 L35.12 27.9 L31.76 34.77 L27.14 37.02 Z';
  const LOGO_LEFT = 'M6.04 7.23 L10.69 7.23 C12.64 7.23 14.12 7.99 15.35 10.65 L20.02 20.8 C23.15 27.58 24.16 32.66 27.03 33.91 C30.26 35.31 32.1 33.2 33.66 30.9 L31.76 34.77 C29.41 39.59 27.14 41.52 22.94 41.58 C18.6 41.65 16.28 39.07 14.87 36.03 L3.24 10.97 C2.25 8.85 4.45 7.23 6.04 7.23 Z';

  function logoDefs(uid) {
    function stops(list) {
      return list.map((pair) => s('stop', { offset: pair[0], 'stop-color': pair[1], 'stop-opacity': pair[2] }));
    }
    return s('svg', { class: 'vx-defs', width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false' }, [
      s('defs', null, [
        s('linearGradient', { id: uid + '-lg-l', gradientUnits: 'userSpaceOnUse', x1: 25.86, y1: 8.42, x2: 13.27, y2: 40.36 },
          stops([[0, '#7cdebf'], [0.25, '#9ffcd1'], [0.5, '#8df7ca'], [0.75, '#a1ffd2'], [1, '#97ffd3']])),
        s('radialGradient', { id: uid + '-lg-b', gradientUnits: 'userSpaceOnUse', cx: 0, cy: 0, r: 1, gradientTransform: 'translate(23.23 34.78) rotate(18.72) scale(21.2 8.93)' },
          stops([[0, '#00bf9e', 0.38], [0.393, '#00bf9e', 0.19], [1, '#00bf9e', 0]])),
        s('linearGradient', { id: uid + '-lg-r', gradientUnits: 'userSpaceOnUse', x1: 21.17, y1: 12.37, x2: 42.18, y2: 30 },
          stops([[0, '#7cffbf'], [0.333, '#7eefc4'], [0.667, '#66e2b8'], [1, '#aaeed5']])),
        s('linearGradient', { id: uid + '-lg-f', gradientUnits: 'userSpaceOnUse', x1: 24.21, y1: 30.99, x2: 30.84, y2: 24.07 },
          stops([[0, '#00543a', 0.84], [0.618, '#0b9f7e', 0.2], [1, '#0b9f7e', 0]])),
        s('linearGradient', { id: uid + '-lg-s', x2: 0, y2: 1 },
          stops([[0, '#c7fce3'], [0.5, '#98fbd0'], [1, '#8ffbce']])),
      ]),
    ]);
  }

  function logo(uid, size) {
    const ref = (key) => 'url(#' + uid + '-lg-' + key + ')';
    return s('svg', { class: 'vx-logo', viewBox: '0 0 48 48', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' }, [
      s('path', { fill: ref('r'), d: LOGO_RIGHT }),
      s('path', { fill: ref('f'), d: LOGO_FOLD }),
      s('path', { fill: ref('l'), d: LOGO_LEFT }),
      s('path', { fill: ref('b'), d: LOGO_LEFT }),
      s('g', { fill: ref('s') }, [
        s('rect', { x: -4.59, y: -1.17, width: 9.17, height: 2.34, rx: 1.17, transform: 'translate(40.41 8.05) rotate(-7.92) skewX(-12.07)' }),
        s('rect', { x: -4.41, y: -1.1, width: 8.83, height: 2.19, rx: 1.1, transform: 'translate(38.87 12.08) rotate(-8.35) skewX(-10.37)' }),
        s('rect', { x: -3.32, y: -1.03, width: 6.64, height: 2.05, rx: 1.03, transform: 'translate(36.77 15.92) rotate(-8.75) skewX(-7.93)' }),
      ]),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Sample content. Invented, and nothing here comes from a real account.

  // Each dictation: what the speaker says (the live caption), what the speech
  // engine writes back (punctuated, fillers and misheard names still in), and
  // what Polish, Grammar and Tighten return. What gets pasted is worked out
  // below from the engine text, the dictionary and the writing style, the
  // same way the app does it. " | " marks a breath between sentences.
  const SCENARIOS = [
    {
      id: 'teammate',
      label: 'Reply to a teammate',
      short: 'Reply',
      icon: 'chat',
      app: 'chat',
      view: 'channel',
      context: 'work',
      spoken: 'um we’re pretty much on track | uh I’ll send the vox den build tonight',
      engine: 'Um, we’re pretty much on track. Uh, I’ll send the vox den build tonight',
      rewrites: {
        polish: 'We’re on track, and I’ll send the Voxden build tonight.',
        grammar: 'We’re pretty much on track. I’ll send the Voxden build tonight.',
        tighten: 'On track. I’ll send the Voxden build tonight.',
      },
    },
    {
      id: 'client',
      label: 'Email a client',
      short: 'Email',
      icon: 'mail',
      app: 'mail',
      view: 'mail',
      context: 'email',
      spoken: 'um yeah Monday works | uh I’ll send you a invite for the kickoff',
      engine: 'Um, yeah, Monday works. Uh, I’ll send you a invite for the kickoff',
      rewrites: {
        polish: 'Monday works well for us. I’ll send you an invite for the kickoff.',
        grammar: 'Yeah, Monday works. I’ll send you an invite for the kickoff.',
        tighten: 'Monday works. I’ll send the kickoff invite.',
      },
    },
    {
      id: 'hinglish',
      label: 'Hinglish',
      short: 'Hinglish',
      icon: 'language',
      app: 'chat',
      view: 'dm',
      context: 'work',
      spoken: 'uh Rohan kal ki meeting 3 baje shift kar do | um main thoda late hoon',
      engine: 'Uh, Rohan, kal ki meeting 3 baje shift kar do. Um, main thoda late hoon',
      rewrites: {
        polish: 'Rohan, kya kal ki meeting 3 baje shift kar sakte ho? Main thoda late ho jaunga.',
        grammar: 'Rohan, kal ki meeting 3 baje shift kar do. Main thoda late ho jaunga.',
        tighten: 'Rohan, meeting kal 3 baje kar do, main late ho jaunga.',
      },
    },
  ];

  function sampleHistory(now) {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 17, 26);
    return [
      {
        id: 'h1',
        at: minutesAgo(now, 34),
        app: 'Docs',
        text: 'So basically what I’m thinking is we move the design review to Wednesday, because half the team is out on Monday and that way everyone can actually weigh in on the new onboarding flow.',
        rewrites: {
          polish: 'Let’s move the design review to Wednesday. Half the team is out on Monday, and this way everyone can weigh in on the new onboarding flow.',
          grammar: 'So basically, what I’m thinking is we move the design review to Wednesday, because half the team is out on Monday, and that way everyone can actually weigh in on the new onboarding flow.',
          tighten: 'Let’s move the design review to Wednesday so the whole team can weigh in on the new onboarding flow.',
        },
        polished: null,
      },
      {
        id: 'h2',
        at: minutesAgo(now, 71),
        app: 'Notes',
        text: 'Remind me to send Daniel the updated pricing sheet before Friday’s call.',
        rewrites: {
          polish: 'Reminder: send Daniel the updated pricing sheet before Friday’s call.',
          grammar: 'Remind me to send Daniel the updated pricing sheet before Friday’s call.',
          tighten: 'Send Daniel the updated pricing sheet before Friday’s call.',
        },
        polished: null,
      },
      {
        id: 'h3',
        at: yesterday,
        app: 'Team chat',
        text: 'Notes from the retro, the release went smoothly but the changelog was late again, so next time we draft it while the build runs.',
        rewrites: {
          polish: 'Notes from the retro: the release went smoothly, but the changelog was late again, so next time we’ll draft it while the build runs.',
          grammar: 'Notes from the retro: the release went smoothly, but the changelog was late again, so next time we draft it while the build runs.',
          tighten: 'Retro: the release went smoothly, but the changelog was late again. Next time, we draft it during the build.',
        },
        polished: null,
      },
    ];
  }

  const DICTIONARY = [
    { term: 'Voxden', kind: 'added' },
    { term: 'Halden', kind: 'added' },
    { term: 'Priya Nair', kind: 'added' },
    { term: 'Rohan Mehta', kind: 'added' },
    { from: 'vox den', term: 'Voxden', kind: 'learned' },
    { from: 'pria', term: 'Priya', kind: 'learned' },
    { from: 'rohan meta', term: 'Rohan Mehta', kind: 'learned' },
  ];

  const TONES = [
    { id: 'formal', name: 'Formal', desc: 'Considered. Clear. Professional.', caption: 'A thoughtful note. Beautifully put.' },
    { id: 'casual', name: 'Casual', desc: 'Warm, natural, and everyday.', caption: 'A little warmth goes a long way.' },
    { id: 'veryCasual', name: 'Very casual', desc: 'Like a message to a friend.', caption: 'Less buttoned up. Still all you.' },
  ];

  const CONTEXTS = [
    { id: 'personal', name: 'Personal', hint: 'For messages to friends' },
    { id: 'work', name: 'Work', hint: 'Team chat writes this way' },
    { id: 'email', name: 'Email', hint: 'Mail writes this way' },
    { id: 'other', name: 'Other', hint: 'For everything else' },
  ];

  const DEFAULT_STYLES = { personal: 'veryCasual', work: 'casual', email: 'formal', other: 'casual' };

  // What the preview says, spoken, the way the real app's preview works: the
  // fillers show what every tone takes out, and the capitals and the closing
  // full stop show what each tone puts back.
  const PREVIEW_SAID = 'um, hey Priya, I’m sending the notes tonight, you know, once we’re done. thanks for waiting';

  const INSIGHT_RANGES = {
    '7d': { label: '7 days', words: 1406, dictations: 24, span: 'in the last 7 days' },
    '30d': { label: '30 days', words: 2968, dictations: 58, span: 'in the last 30 days' },
    all: { label: 'All time', words: 3482, dictations: 71, span: 'all time' },
  };
  const PACE_WPM = 146;
  const TYPING_WPM = 40;
  const STREAK_DAYS = 9;
  const BASE_FIXES = { style: 131, dictionary: 33 };
  const WEEK_WORDS = [226, 348, 190, 305, 262, 88, 64]; // Monday first
  const LONGEST_STREAK = 14;

  // The real app's milestones (src/insights.js) and voice profile levels
  // (src/app.js). Reached dates are counted back from today.
  const MILESTONES = [
    { words: 250, name: 'Full page', label: 'a full page', daysAgo: 71 },
    { words: 750, name: 'Blog post', label: 'a blog post', daysAgo: 43 },
    { words: 1500, name: 'Long essay', label: 'a long essay', daysAgo: 18 },
    { words: 5000, name: 'Short story', label: 'a short story' },
    { words: 10000, name: 'Book chapter', label: 'a book chapter' },
    { words: 25000, name: 'Novella', label: 'a novella' },
    { words: 50000, name: 'Novel', label: 'a novel' },
    { words: 100000, name: 'Epic novel', label: 'an epic novel' },
  ];
  const PROFILES = [
    { name: 'Learning', words: 0 },
    { name: 'Personalized', words: 2500 },
    { name: 'Attuned', words: 5000 },
    { name: 'Fluent', words: 10000 },
    { name: 'Expert', words: 25000 },
  ];
  const WHERE = [
    { app: 'Team chat', tag: 'Work messages', share: 0.44, trend: 'up' },
    { app: 'Mail', tag: 'Emails', share: 0.27, trend: 'up' },
    { app: 'Docs', tag: 'Other tasks', share: 0.18, trend: '' },
    { app: 'Notes', tag: 'Other tasks', share: 0.11, trend: '' },
  ];
  const TOP_WORDS = [['launch', 38], ['Thursday', 31], ['team', 29], ['review', 24], ['Voxden', 22], ['notes', 20],
    ['build', 18], ['onboarding', 17], ['client', 15], ['tonight', 13], ['design', 12], ['pricing', 10]];
  const HOURS = [0, 0, 0, 0, 0, 0, 1, 3, 9, 14, 16, 12, 7, 5, 8, 10, 9, 6, 4, 3, 2, 1, 0, 0];

  // Settings (src/app.html). Nothing here reaches a backend.
  const MICS = ['System default', 'Headset microphone (USB audio)', 'Microphone array (built in)'];
  const MODELS = [
    { id: 'parakeet', name: 'Parakeet v3', line: 'Small and quick, even without a graphics card.', size: '670 MB', tag: 'Default', installed: true },
    { id: 'whisper-turbo', name: 'Whisper large-v3 turbo', line: 'Mid-size, and uses your dictionary while it listens.', size: '1.6 GB' },
    { id: 'qwen', name: 'Qwen3-ASR 1.7B', line: 'Best with names and accents.', size: '4.7 GB' },
    { id: 'whisper', name: 'Whisper large-v3', line: 'Full-size, and the only one that can use a model trained on your voice.', size: '3.1 GB' },
  ];

  // What each page may let go of when it runs past its window, least needed
  // first (see Demo.fit). `rows`: a list or grid that sheds its last row, down
  // to `keep` items, with `head` naming its headings; `hide`: blocks that go
  // whole, one at a time. The real app scrolls instead; the demo never does.
  const FIT = {
    home: [
      { rows: '.vx-feed > *', head: '.vx-day', keep: 2 },
      { hide: '.vx-metrics' },
      { hide: '.vx-home-side' },
      { rows: '.vx-feed > *', head: '.vx-day', keep: 1 },
      { hide: '.vx-greet' },
      { hide: '.vx-sec-head, .vx-feed' },
    ],
    dictionary: [
      { rows: '.vx-dict-list > *', keep: 3 },
      { hide: '.vx-page-desc' },
      { hide: '.vx-counts' },
      { hide: '.vx-vocab' },
      { rows: '.vx-dict-list > *', keep: 1 },
    ],
    style: [
      { hide: '.vx-said' },
      { hide: '.vx-page-desc' },
      { hide: '.vx-style-intro' },
      { hide: '.vx-eyebrow' },
      { hide: '.vx-page-head' },
      { hide: '.vx-style-h' },
    ],
    polish: [
      { hide: '.vx-actions .vx-fine' },
      { hide: '.vx-page-desc' },
      { hide: '.vx-bridge' },
      { hide: '.vx-draft' },
      { hide: '.vx-page-head' },
    ],
    insights: [
      { rows: '.vx-ins-grid:not([hidden]) > *', keep: 1 },
      { hide: '.vx-ins-sub' },
      { hide: '.vx-page-desc' },
      { hide: '.vx-ins-overview' },
      { hide: '.vx-shelf' },
      { hide: '.vx-ms-strip' },
      { hide: '.vx-profile-copy' },
      { hide: '.vx-ladder' },
      { hide: '.vx-page-head' },
    ],
    settings: [
      { rows: ':scope > *', head: '.vx-set-group', keep: 2 },
    ],
  };

  // ---------------------------------------------------------------------------
  // <style-engine>
  // Writing styles change capitals and punctuation, never words (src/style.js).
  // The fillers um, uh and hmm go in every style; so does a "you know" set off
  // by commas. Formal capitalises every sentence and adds the closing full
  // stop, Casual capitalises and keeps the engine's punctuation, and Very
  // casual starts sentences in lower case -- only everyday words, so names,
  // "I" and acronyms keep theirs -- and drops the closing full stop.
  const FILLER_SRC = '(?:[Uu]m+|[Uu]h+m*|[Hh]m+)';
  const ITEM_SRC = '(?:' + FILLER_SRC + '|[Yy]ou know)';
  const RUN_SRC = ITEM_SRC + '(?:\\s*[,;:]?\\s*' + ITEM_SRC + ')*';
  const LEAD_RUN = new RegExp('(^|[.!?]\\s+)' + FILLER_SRC + '(?:\\s*[,;:]?\\s*' + FILLER_SRC + ')*\\s*[,;:]?\\s*', 'g');
  const MARKED_RUN = new RegExp('\\s*[,;:]\\s*' + RUN_SRC + '\\s*[,;:]\\s*', 'g');
  const BARE_FILLER = new RegExp('(^|[\\s,;:])' + FILLER_SRC + '(?=$|[\\s,;:.!?])\\s*[,;:]?', 'g');
  const EVERYDAY = new Set(('a about after all also an and anyway are as at back be because been but by can could did do does done for from '
    + 'get go going good got great had has have hey hi how i if in is it its just let like main maybe me more my no not now of oh ok okay on '
    + 'one or our please quick really remind right so sorry sure thanks thank that the then there these they this to today tonight too up '
    + 'us was we well were what when where which who why with would yeah yep yes yet you your').split(' '));

  function contractionBase(word) {
    const w = word.toLowerCase().replace(/’/g, '\'');
    if (/n't$/.test(w)) return w.slice(0, -3);
    return w.replace(/'(?:s|re|ll|ve|d|m)$/, '');
  }

  function isEveryday(word) {
    if (!/^\p{Lu}\p{Ll}*(?:['’]\p{Ll}+)?$/u.test(word) || /^I(?:['’]|$)/.test(word)) return false;
    return EVERYDAY.has(contractionBase(word));
  }

  function mapSentenceStarts(text, fn) {
    return text.replace(/(^|[.!?]\s+)([\p{L}][\p{L}’']*)/gu, (match, lead, word) => lead + fn(word));
  }

  function stripFillers(text) {
    let out = String(text || '');
    out = out.replace(MARKED_RUN, ' ');
    out = out.replace(LEAD_RUN, '$1');
    out = out.replace(BARE_FILLER, '$1');
    out = out.replace(/[ \t]+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
      .replace(/(^|[.!?]\s+)[,;:]\s*/g, '$1')
      .replace(/[,;:]\s*([.!?])/g, '$1');
    return out.trim();
  }

  function capitalizePronoun(text) {
    return text.replace(/(^|[^\p{L}\p{N}_.’'-])i(?=$|[^\p{L}\p{N}_-])/gu, '$1I');
  }

  function styleText(text, tone) {
    let out = capitalizePronoun(stripFillers(text));
    if (!out) return '';
    if (tone === 'veryCasual') {
      out = mapSentenceStarts(out, (word) => (isEveryday(word) ? word.charAt(0).toLowerCase() + word.slice(1) : word));
      return out.replace(/([\p{L}\p{N}’'])\.$/u, '$1');
    }
    out = mapSentenceStarts(out, (word) => word.charAt(0).toUpperCase() + word.slice(1));
    if (tone === 'formal' && /[\p{L}\p{N}’']$/u.test(out)) out += '.';
    return out;
  }
  // </style-engine>

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Word-level changes for "Show changes" (the Polish page's own diff).
  function diffWords(before, after) {
    const a = String(before || '').split(/\s+/).filter(Boolean);
    const b = String(after || '').split(/\s+/).filter(Boolean);
    const key = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const dp = [];
    for (let i = 0; i <= a.length; i++) dp.push(new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i][j] = key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (key(a[i]) === key(b[j])) { out.push(['same', b[j]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['del', a[i]]); i++; }
      else { out.push(['ins', b[j]]); j++; }
    }
    while (i < a.length) out.push(['del', a[i++]]);
    while (j < b.length) out.push(['ins', b[j++]]);
    return out;
  }

  // The words of a sample dictation, timed like a brisk speaker: about three
  // and a half seconds each.
  function speechPlan(spoken) {
    const words = [];
    let t = 200;
    for (const token of spoken.split(/\s+/)) {
      if (token === '|') { t += 120; continue; }
      const filler = /^(?:um+|uh+|hmm+)$/i.test(token);
      const letters = token.replace(/[^\p{L}\p{N}]/gu, '').length;
      const dur = filler ? 200 : Math.max(130, Math.min(300, 80 + letters * 24));
      words.push({ text: token, filler, start: t, end: t + dur });
      t += dur + (filler ? 80 : 10);
    }
    return { words, total: t + 260 };
  }

  // ---------------------------------------------------------------------------
  // A clock for everything scripted. Its time stands still while the demo is
  // paused (the tab hidden, the demo scrolled out of view) and runs in real
  // time otherwise. Scheduled steps run on one timer, so the script keeps time
  // however the browser paces animation frames; frames are asked for only
  // while something is moving (the meter), never while the demo waits.
  const perfNow = () => (window.performance && performance.now ? performance.now() : Date.now());

  class Clock {
    constructor() {
      this.tasks = [];
      this.frames = new Set();
      this.timer = 0;
      this.raf = 0;
      this.lastFrame = 0;
      this.running = true;
      this.base = 0;
      this.since = perfNow();
      this.seq = 0;
      this.fire = this.fire.bind(this);
      this.tick = this.tick.bind(this);
    }

    get now() {
      return this.running ? this.base + (perfNow() - this.since) : this.base;
    }

    after(ms, fn, group) {
      const task = { at: this.now + Math.max(0, ms), fn, group: group || '', id: ++this.seq };
      this.tasks.push(task);
      this.arm();
      return task.id;
    }

    cancelGroup(group) {
      const before = this.tasks.length;
      this.tasks = this.tasks.filter((task) => task.group !== group);
      if (this.tasks.length !== before) this.arm();
    }

    arm() {
      if (this.timer) window.clearTimeout(this.timer);
      this.timer = 0;
      if (!this.running || !this.tasks.length) return;
      let next = Infinity;
      for (const task of this.tasks) next = Math.min(next, task.at);
      this.timer = window.setTimeout(this.fire, Math.max(0, next - this.now));
    }

    fire() {
      this.timer = 0;
      const now = this.now + 1;
      const due = this.tasks.filter((task) => task.at <= now);
      if (due.length) {
        this.tasks = this.tasks.filter((task) => task.at > now);
        due.sort((x, y) => x.at - y.at || x.id - y.id);
        for (const task of due) task.fn();
      }
      this.arm();
    }

    onFrame(fn) {
      this.frames.add(fn);
      this.kick();
    }

    offFrame(fn) {
      this.frames.delete(fn);
    }

    kick() {
      if (this.raf || !this.running || !this.frames.size) return;
      this.lastFrame = 0;
      this.raf = window.requestAnimationFrame(this.tick);
    }

    tick(stamp) {
      this.raf = 0;
      const dt = this.lastFrame ? Math.min(100, Math.max(0, stamp - this.lastFrame)) : 16;
      this.lastFrame = stamp;
      for (const fn of Array.from(this.frames)) fn(dt);
      if (this.running && this.frames.size) this.raf = window.requestAnimationFrame(this.tick);
    }

    setRunning(on) {
      if (this.running === on) return;
      if (on) {
        this.since = perfNow();
        this.running = true;
        this.arm();
        this.kick();
      } else {
        this.base = this.now;
        this.running = false;
        if (this.timer) window.clearTimeout(this.timer);
        this.timer = 0;
        if (this.raf) window.cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Cues: the real app's start and success tones (src/overlay.js playCue), at
  // half its gain. One AudioContext for the page, made on the first click.
  const Cues = {
    ctx: null,
    play(kind) {
      try {
        if (!this.ctx) {
          const Ctor = window.AudioContext || window.webkitAudioContext;
          if (!Ctor) return;
          this.ctx = new Ctor();
        }
        const ctx = this.ctx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const now = ctx.currentTime;
        const end = now + (kind === 'success' ? 0.12 : 0.08);
        osc.type = 'sine';
        osc.frequency.value = kind === 'success' ? 740 : 520;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.035, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.14);
      } catch (_) {
        // Sound is a nicety; the demo carries on without it.
      }
    },
  };

  // ---------------------------------------------------------------------------
  // A steady pseudo-random number in 0..1 for a seed, so sample charts look the
  // same on every visit.
  function seeded(seed) {
    const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function shortDate(date) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function daysAgo(now, days) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  }

  // One state behind both mounts: the app window and the dictation playground.
  class Demo {
    constructor(appHost, dictHost) {
      this.appHost = appHost || null;
      this.dictHost = dictHost || null;
      this.uid = 'vx' + (++instanceCount);
      this.clock = new Clock();
      this.gen = 0;
      this.run = null;
      this.now = new Date();
      this.scenarioIndex = 0;
      this.page = 'home';
      this.visibleHosts = new Set();
      this.visible = true;
      this.styles = Object.assign({}, DEFAULT_STYLES);
      this.styleContext = 'work';
      this.dictionary = DICTIONARY.map((entry) => Object.assign({}, entry));
      this.dictFilter = 'all';
      this.history = sampleHistory(this.now);
      this.extra = { words: 0, dictations: 0, style: 0, dictionary: 0 };
      this.credits = 684;
      this.creditsCap = 900;
      this.insightsRange = 'all';
      this.insightsTab = 'usage';
      this.polish = { sourceId: 'h1', result: null, busy: '', showChanges: false };
      this.sent = { channel: [], dm: [], mail: [] };
      this.settings = {
        sounds: true,
        muteAudio: true,
        suggestions: true,
        mode: 'toggle',
        mic: 0,
        speed: 'auto',
        autoAdd: true,
        listen: 'cloud',
        model: 'parakeet',
        installed: { parakeet: true },
        downloading: '',
        progress: 0,
        launchLogin: true,
        taskbar: false,
        autoUpdate: true,
        updateNote: '',
        theme: 'voxden',
        flowStyle: 'island',
        alwaysFlow: true,
        flowMotion: 'system',
        keepRecordings: true,
        training: false,
      };
      this.settingsCat = 'general';
      this.settingsOpen = false;
      this.systemReduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      this.canHover = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
      this.compactApp = false;
      this.compactDict = false;
      this.lastState = 'idle';
      this.level = 0;

      this.fb = {
        mode: 'idle',
        hover: false,
        focus: false,
        polishFocus: false,
        hold: false,
        canPolish: false,
        lineText: '',
        lineShown: false,
      };
      this.wave = null;
      this.onWaveFrame = this.onWaveFrame.bind(this);

      if (this.appHost) this.buildApp();
      if (this.dictHost) this.buildDictation();
      if (!this.status) {
        this.status = h('div', { class: 'vx-sr', role: 'status', 'aria-live': 'polite' });
        (this.appRoot || this.dictRoot).appendChild(this.status);
      }
      this.bind();
      this.watch();
      this.renderAll();
      this.syncLayout();
      if (this.appHost) this.appHost.classList.add('vx-is-ready');
      if (this.dictHost) this.dictHost.classList.add('vx-is-ready');
    }

    get reduced() {
      return this.systemReduced;
    }

    // The flow bar's own motion setting, like the real "Flow bar animations".
    flowReduced() {
      const mode = this.settings.flowMotion;
      return mode === 'reduced' || (mode === 'system' && this.systemReduced);
    }

    // --- Building: the app window --------------------------------------------

    buildApp() {
      const host = this.appHost;
      empty(host);
      if (host.hasAttribute('aria-label') && !host.hasAttribute('role')) host.setAttribute('role', 'region');
      this.appRoot = this.buildAppWindow();
      host.appendChild(this.appRoot);
    }

    captionButtons() {
      return h('span', { class: 'vx-caption', 'aria-hidden': 'true' }, [
        h('span', { class: 'vx-cap-btn' }, icon('winMin', 10)),
        h('span', { class: 'vx-cap-btn' }, icon('winMax', 10)),
        h('span', { class: 'vx-cap-btn vx-cap-close' }, icon('winClose', 10)),
      ]);
    }

    // The real app's window: title bar, sidebar, content panel, and Settings
    // over the content as the app opens it.
    buildAppWindow() {
      const uid = this.uid;
      this.navItems = {};
      this.pages = {};
      const nav = [
        { id: 'home', label: 'Dictation', short: 'Dictation', icon: 'dictation' },
        { id: 'dictionary', label: 'Dictionary', short: 'Dictionary', icon: 'dictionary' },
        { id: 'style', label: 'Writing style', short: 'Style', icon: 'style' },
        { id: 'polish', label: 'Polish', short: 'Polish', icon: 'polish', pro: true },
        { id: 'insights', label: 'Insights', short: 'Insights', icon: 'insights' },
      ];
      this.navOrder = nav.map((item) => item.id);

      this.tablist = h('div', {
        class: 'vx-nav',
        role: 'tablist',
        'aria-label': 'Voxden pages',
        'aria-orientation': 'vertical',
        on: { keydown: (e) => this.onTabKey(e) },
      }, nav.map((item) => {
        const tab = h('button', {
          type: 'button',
          class: 'vx-nav-item',
          role: 'tab',
          id: uid + '-tab-' + item.id,
          'aria-controls': uid + '-page-' + item.id,
          'aria-selected': 'false',
          tabindex: '-1',
          on: { click: () => this.showPage(item.id, false) },
        }, [
          h('span', { class: 'vx-nav-ico' }, icon(item.icon, 17)),
          h('span', { class: 'vx-nav-label' }, [
            h('span', { class: 'vx-nav-long', text: item.label }),
            h('span', { class: 'vx-nav-short', text: item.short }),
          ]),
          item.pro ? h('span', { class: 'vx-pro-tag', text: 'PRO' }) : null,
        ]);
        this.navItems[item.id] = tab;
        return tab;
      }));

      this.credit = {
        count: h('span', { class: 'vx-credits-count' }),
        fill: h('i'),
        detail: h('span', { class: 'vx-credits-detail' }),
        mini: h('span', { class: 'vx-credits-mini-num' }),
        miniFill: h('i'),
      };
      this.credit.box = h('div', { class: 'vx-credits', role: 'group', 'aria-label': 'Cloud credits' }, [
        h('span', { class: 'vx-credits-head' }, [this.credit.count, h('span', { class: 'vx-credits-kicker', text: 'of cloud left' })]),
        h('span', { class: 'vx-credits-bar', 'aria-hidden': 'true' }, this.credit.fill),
        this.credit.detail,
      ]);
      const miniCredits = h('span', { class: 'vx-credits-mini', 'aria-hidden': 'true' }, [
        this.credit.mini,
        h('span', { class: 'vx-credits-bar' }, this.credit.miniFill),
      ]);

      this.settingsBtn = h('button', {
        type: 'button',
        class: 'vx-nav-item vx-nav-settings',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        on: { click: () => this.openSettings('general', this.settingsBtn) },
      }, [
        h('span', { class: 'vx-nav-ico' }, icon('settings', 17)),
        h('span', { class: 'vx-nav-label' }, [h('span', { class: 'vx-nav-long', text: 'Settings' }), h('span', { class: 'vx-nav-short', text: 'Settings' })]),
      ]);
      this.avatarBtn = h('button', {
        type: 'button',
        class: 'vx-avatar',
        'aria-label': 'Your account',
        title: 'Your account',
        'aria-haspopup': 'dialog',
        on: { click: () => this.openSettings('account', this.avatarBtn) },
      }, 'A');

      this.main = h('div', { class: 'vx-main' }, [
        this.buildHomePage(),
        this.buildDictionaryPage(),
        this.buildStylePage(),
        this.buildPolishPage(),
        this.buildInsightsPage(),
      ]);

      return h('div', { class: 'vx-root vx-win vx-win-app', role: 'group', 'aria-label': 'Voxden app window' }, [
        logoDefs(uid),
        h('div', { class: 'vx-app-bar' }, [
          h('span', { class: 'vx-brand' }, [logo(uid, 24), h('span', { class: 'vx-brand-name', text: 'Voxden' })]),
          miniCredits,
          h('span', { class: 'vx-app-tools' }, [
            h('span', { class: 'vx-bell', 'aria-hidden': 'true' }, icon('bell', 16)),
            this.avatarBtn,
          ]),
          this.captionButtons(),
        ]),
        h('div', { class: 'vx-app-body' }, [
          h('div', { class: 'vx-side' }, [this.tablist, this.credit.box, this.settingsBtn]),
          this.main,
        ]),
        this.buildSettings(),
      ]);
    }

    makePage(id, kids) {
      const panel = h('section', {
        class: 'vx-page vx-page-' + id,
        id: this.uid + '-page-' + id,
        role: 'tabpanel',
        'aria-labelledby': this.uid + '-tab-' + id,
        tabindex: '0',
        hidden: true,
      }, kids);
      this.pages[id] = panel;
      return panel;
    }

    pageHead(kicker, title, desc, extra) {
      return h('div', { class: 'vx-page-head' }, [
        h('div', { class: 'vx-page-head-copy' }, [
          h('p', { class: 'vx-kicker', text: kicker }),
          h('p', { class: 'vx-page-title', text: title }),
          desc ? h('p', { class: 'vx-page-desc', text: desc }) : null,
        ]),
        extra || null,
      ]);
    }

    buildHomePage() {
      const hour = this.now.getHours();
      const salute = hour >= 5 && hour < 12 ? 'Good morning,' : hour >= 12 && hour < 17 ? 'Good afternoon,'
        : hour >= 17 && hour < 22 ? 'Good evening,' : 'Up late?';
      const part = hour >= 5 && hour < 8 ? 'dawn' : hour >= 8 && hour < 12 ? 'morning' : hour >= 12 && hour < 17 ? 'afternoon'
        : hour >= 17 && hour < 21 ? 'evening' : 'night';
      const greetIcon = s('svg', { viewBox: '0 0 24 24', width: 17, height: 17, fill: 'none', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'vx-ico' },
        GREETING_ICONS[part].map((piece) => s(piece[0], piece[1])));
      const home = this.home = {
        weekNum: h('span', { class: 'vx-week-num' }),
        weekBars: h('span', { class: 'vx-week-bars', 'aria-hidden': 'true' }),
        allWords: h('strong'),
        allDictations: h('strong'),
        feed: h('div', { class: 'vx-feed' }),
        savedNum: h('span', { class: 'vx-dm-num' }),
        ringFill: s('circle', { class: 'vx-ring-fill', cx: 48, cy: 48, r: 43 }),
        ringPct: h('strong'),
        profile: h('span', { class: 'vx-vc-profile' }),
        profileMeta: h('span', { class: 'vx-vc-meta' }),
      };
      const bubble = (name) => h('span', { class: 'vx-hero-bubble vx-hero-bubble-' + name }, icon(name, 17));

      const voiceCard = h('button', {
        type: 'button',
        class: 'vx-voice-card',
        on: { click: () => { this.insightsTab = 'voice'; this.renderInsights(); this.showPage('insights', false); } },
      }, [
        h('span', { class: 'vx-vc-ring', 'aria-hidden': 'true' }, [
          s('svg', { viewBox: '0 0 96 96', class: 'vx-ring' }, [s('circle', { class: 'vx-ring-track', cx: 48, cy: 48, r: 43 }), home.ringFill]),
          h('span', { class: 'vx-vc-pct' }, home.ringPct),
        ]),
        h('span', { class: 'vx-vc-body' }, [
          h('span', { class: 'vx-vc-title', text: 'Voice profile' }),
          home.profile,
          home.profileMeta,
          h('span', { class: 'vx-vc-link' }, ['Your voice', icon('chevronRight', 12)]),
        ]),
      ]);
      home.voiceCard = voiceCard;

      const toInsights = () => { this.insightsTab = 'usage'; this.renderInsights(); this.showPage('insights', false); };
      const metrics = h('div', { class: 'vx-metrics' }, [
        h('button', { type: 'button', class: 'vx-dm-pace', 'aria-label': 'Speaking pace, ' + PACE_WPM + ' words a minute. Open Insights', on: { click: toInsights } }, [
          h('span', { class: 'vx-dm-head' }, [
            h('span', { class: 'vx-dm-eyebrow' }, ['Speaking pace', h('span', { class: 'vx-dm-sub', text: 'all time' })]),
            h('span', { class: 'vx-dm-cta', 'aria-hidden': 'true' }, ['Insights', icon('chevronRight', 11)]),
          ]),
          h('span', { class: 'vx-dm-readout' }, [h('span', { class: 'vx-dm-figure', text: String(PACE_WPM) }), h('span', { class: 'vx-dm-unit', text: 'words/min' })]),
          h('span', { class: 'vx-dm-trend', text: (PACE_WPM / TYPING_WPM).toFixed(1) + '× typing speed' }),
        ]),
        h('span', { class: 'vx-dm-rule', 'aria-hidden': 'true' }),
        h('button', { type: 'button', class: 'vx-dm-saved', 'aria-label': 'Time saved compared with typing. Open Insights', on: { click: toInsights } }, [
          h('span', { class: 'vx-dm-saved-ico', 'aria-hidden': 'true' }, icon('clock', 14)),
          h('span', { class: 'vx-dm-saved-copy' }, [
            h('span', { class: 'vx-dm-saved-top' }, [h('span', { class: 'vx-dm-eyebrow', text: 'Time saved' }), h('span', { class: 'vx-dm-saved-value' }, [home.savedNum, h('span', { class: 'vx-dm-saved-unit', text: 'min' })])]),
            h('span', { class: 'vx-dm-note', text: 'Compared with typing at 40 WPM' }),
          ]),
          h('span', { class: 'vx-dm-chev', 'aria-hidden': 'true' }, icon('chevronRight', 12)),
        ]),
      ]);

      return this.makePage('home', [
        h('p', { class: 'vx-greet' }, [
          h('span', { class: 'vx-greet-ico' }, greetIcon),
          h('span', { class: 'vx-greet-salute', text: salute }),
          salute === 'Up late?' ? null : h('span', { class: 'vx-greet-name', text: 'Alex' }),
        ]),
        h('div', { class: 'vx-hero' }, [
          h('div', { class: 'vx-hero-copy' }, [
            h('p', { class: 'vx-hero-kicker', text: 'Speak naturally. Write clearly.' }),
            h('p', { class: 'vx-hero-h' }, [
              h('span', { class: 'vx-hero-line', text: 'Your thoughts,' }),
              h('span', { class: 'vx-hero-line vx-hero-accent', text: 'in writing.' }),
            ]),
            h('p', { class: 'vx-hero-p', text: 'Speak naturally. Let Voxden take it from here.' }),
            h('p', { class: 'vx-hero-keys' }, [
              h('kbd', { class: 'vx-kbd', text: 'Ctrl' }),
              h('span', { class: 'vx-plus', 'aria-hidden': 'true', text: '+' }),
              h('kbd', { class: 'vx-kbd', text: 'Win' }),
              h('span', { class: 'vx-hero-keys-copy', text: 'to dictate' }),
            ]),
          ]),
          h('div', { class: 'vx-hero-apps', 'aria-hidden': 'true' }, [
            bubble('chat'), bubble('mail'), bubble('dictionary'), bubble('sparkleSolid'), bubble('hash'),
          ]),
        ]),
        h('div', { class: 'vx-home-side' }, [
          h('div', { class: 'vx-week-card', role: 'group', 'aria-label': 'Totals' }, [
            h('div', { class: 'vx-week-top' }, [
              h('span', { class: 'vx-week-lead' }, [home.weekNum, h('span', { class: 'vx-week-unit', text: 'words this week' })]),
              home.weekBars,
            ]),
            h('p', { class: 'vx-week-foot' }, [
              h('span', null, [home.allWords, ' words all time']),
              h('span', null, [home.allDictations, ' dictations']),
            ]),
          ]),
          voiceCard,
          metrics,
        ]),
        h('div', { class: 'vx-sec-head' }, [
          h('span', { class: 'vx-sec-eyebrow', text: 'Library' }),
          h('p', { class: 'vx-sec-title', text: 'Recent dictations' }),
        ]),
        home.feed,
      ]);
    }

    buildDictionaryPage() {
      const d = this.dict = {
        total: h('strong'),
        learned: h('strong'),
        list: h('div', { class: 'vx-dict-list', role: 'list', 'aria-label': 'Your words' }),
        filters: {},
        input: h('input', {
          class: 'vx-add-input',
          type: 'text',
          maxlength: '40',
          autocomplete: 'off',
          spellcheck: 'false',
          placeholder: 'A name, a product, a word',
          'aria-label': 'Word to add',
        }),
        msg: h('p', { class: 'vx-add-msg', 'aria-live': 'polite' }),
      };
      d.addBtn = h('button', {
        type: 'button',
        class: 'vx-btn-primary',
        'aria-expanded': 'false',
        'aria-controls': this.uid + '-add',
        on: { click: () => this.toggleAddWord(true) },
      }, [icon('plus', 13), 'Add a word']);
      d.form = h('form', {
        class: 'vx-add',
        id: this.uid + '-add',
        hidden: true,
        on: {
          submit: (e) => { e.preventDefault(); this.addWord(); },
          keydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.toggleAddWord(false); } },
        },
      }, [
        d.input,
        h('button', { type: 'submit', class: 'vx-add-save', text: 'Add' }),
        h('button', { type: 'button', class: 'vx-add-cancel', text: 'Cancel', on: { click: () => this.toggleAddWord(false) } }),
      ]);

      const filterBtn = (id, label) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-seg-btn',
          'aria-pressed': String(id === this.dictFilter),
          text: label,
          on: { click: () => { this.dictFilter = id; this.renderDictionary(); } },
        });
        d.filters[id] = btn;
        return btn;
      };

      return this.makePage('dictionary', [
        this.pageHead('Personal vocabulary', 'Dictionary', 'Your names, your words. Always spelled your way.', d.addBtn),
        h('div', { class: 'vx-vocab' }, [
          h('div', { class: 'vx-vocab-copy' }, [
            h('p', { class: 'vx-vocab-title', text: 'Always spelled your way.' }),
            h('p', { class: 'vx-vocab-line', text: 'Fix a word once. Voxden remembers.' }),
          ]),
          h('div', { class: 'vx-fix', role: 'img', 'aria-label': 'vox den becomes Voxden' }, [
            h('span', { class: 'vx-fix-from', 'aria-hidden': 'true', text: 'vox den' }),
            h('span', { class: 'vx-fix-arrow', 'aria-hidden': 'true', text: '→' }),
            h('span', { class: 'vx-fix-to', 'aria-hidden': 'true', text: 'Voxden' }),
          ]),
          h('div', { class: 'vx-counts' }, [
            h('p', { class: 'vx-count' }, [d.total, h('span', { text: 'saved words' })]),
            h('p', { class: 'vx-count' }, [d.learned, h('span', { text: 'learned from you' })]),
          ]),
        ]),
        d.form,
        d.msg,
        h('div', { class: 'vx-dict-bar' }, [
          h('div', { class: 'vx-seg', role: 'group', 'aria-label': 'Show' }, [
            filterBtn('all', 'All'), filterBtn('added', 'Added'), filterBtn('learned', 'Learned'),
          ]),
        ]),
        d.list,
      ]);
    }

    buildStylePage() {
      const w = this.styleUi = { ctx: {}, tones: {} };
      w.ctxHint = h('span', { class: 'vx-ctx-hint' });
      w.output = h('p', { class: 'vx-paper-out', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
      w.toneName = h('span', { class: 'vx-paper-tone' });
      w.caption = h('p', { class: 'vx-scene-caption' });

      const ctxButtons = CONTEXTS.map((ctx) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-ctx-btn',
          'aria-pressed': 'false',
          text: ctx.name,
          on: { click: () => { this.styleContext = ctx.id; this.renderStyle(); } },
        });
        w.ctx[ctx.id] = btn;
        return btn;
      });

      const toneButtons = TONES.map((tone) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-tone',
          'aria-pressed': 'false',
          on: { click: () => this.pickTone(tone.id) },
        }, [
          h('span', { class: 'vx-tone-ico' }, icon(tone.id, 19)),
          h('span', { class: 'vx-tone-copy' }, [
            h('span', { class: 'vx-tone-name', text: tone.name }),
            h('span', { class: 'vx-tone-desc', text: tone.desc }),
          ]),
          h('span', { class: 'vx-tone-check', 'aria-hidden': 'true' }),
        ]);
        w.tones[tone.id] = btn;
        return btn;
      });

      w.card = h('div', { class: 'vx-style-card', 'data-tone': 'casual' }, [
        h('div', { class: 'vx-style-bar' }, [
          h('span', { class: 'vx-ctx-label', id: this.uid + '-ctx', text: 'Writing for' }),
          h('div', { class: 'vx-ctx', role: 'group', 'aria-labelledby': this.uid + '-ctx' }, ctxButtons),
          w.ctxHint,
        ]),
        h('div', { class: 'vx-style-body' }, [
          h('div', { class: 'vx-tone-panel' }, [
            h('p', { class: 'vx-eyebrow', text: 'The same words. A new feel.' }),
            h('p', { class: 'vx-style-h' }, ['A little more ', h('em', { class: 'vx-style-em', text: 'you.' })]),
            h('p', { class: 'vx-style-intro', text: 'From a thoughtful email to a quick hello. Find the tone that feels right.' }),
            h('div', { class: 'vx-tones', role: 'group', 'aria-label': 'Tone' }, toneButtons),
          ]),
          h('div', { class: 'vx-scene' }, [
            h('div', { class: 'vx-scene-stack', 'aria-hidden': 'true' }),
            h('div', { class: 'vx-paper' }, [
              h('p', { class: 'vx-paper-head' }, [icon('voiceBars', 15), h('span', { text: 'Your voice, in words' }), h('span', { class: 'vx-paper-dot', 'aria-hidden': 'true' })]),
              w.output,
              h('p', { class: 'vx-paper-foot' }, [w.toneName, h('span', { class: 'vx-paper-sign', 'aria-hidden': 'true', text: 'yours, naturally' })]),
            ]),
            w.caption,
          ]),
        ]),
        h('div', { class: 'vx-said' }, [
          h('span', { class: 'vx-said-label', text: 'You said' }),
          h('span', { class: 'vx-said-text', text: '“' + PREVIEW_SAID + '”' }),
          h('span', { class: 'vx-said-note', text: 'Styles change only capitals and punctuation, never your words. Um, uh and hmm go in every style.' }),
        ]),
      ]);

      return this.makePage('style', [
        this.pageHead('Tone and voice', 'Writing style', 'Sound like yourself. In every conversation.'),
        w.card,
      ]);
    }

    buildPolishPage() {
      const p = this.polishUi = {
        recents: h('div', { class: 'vx-recents', role: 'group', 'aria-label': 'Recent dictations' }),
        balance: h('span', { class: 'vx-balance' }),
        draft: h('p', { class: 'vx-draft-text' }),
        words: h('span', { class: 'vx-draft-count' }),
        title: h('span', { class: 'vx-note-title', text: 'Polished' }),
        output: h('div', { class: 'vx-note-out', role: 'status', 'aria-live': 'polite', tabindex: '0' }),
        status: h('span', { class: 'vx-note-status' }),
        modes: {},
      };
      p.changes = h('button', {
        type: 'button',
        class: 'vx-changes',
        'aria-pressed': 'false',
        text: 'Show changes',
        hidden: true,
        on: { click: () => { this.polish.showChanges = !this.polish.showChanges; this.renderPolishResult(); } },
      });
      p.copy = h('button', { type: 'button', class: 'vx-copy', text: 'Copy', hidden: true, on: { click: () => this.copyPolished() } });
      p.run = h('button', { type: 'button', class: 'vx-run', on: { click: () => this.runPagePolish('polish') } }, [
        icon('sparkleSolid', 16, 'vx-run-ico'),
        p.runLabel = h('span', { class: 'vx-run-label', text: 'Polish' }),
        h('span', { class: 'vx-run-cost', text: '0.25 credits' }),
      ]);
      p.modes.polish = p.run;
      const modeBtn = (id, label, glyph) => {
        const btn = h('button', { type: 'button', class: 'vx-mode', on: { click: () => this.runPagePolish(id) } }, [
          icon(glyph, 16, 'vx-mode-ico'),
          h('span', { class: 'vx-mode-label', text: label }),
        ]);
        p.modes[id] = btn;
        return btn;
      };

      return this.makePage('polish', [
        this.pageHead('Pro · Writing', 'Polish', 'Say it however it comes out. Send it the way it should read.'),
        h('div', { class: 'vx-studio' }, [
          h('div', { class: 'vx-studio-bar' }, [
            h('span', { class: 'vx-studio-label', text: 'Start from' }),
            p.recents,
            p.balance,
          ]),
          h('div', { class: 'vx-studio-body' }, [
            h('div', { class: 'vx-draft' }, [
              h('span', { class: 'vx-card-label', text: 'As you said it' }),
              p.draft,
              h('span', { class: 'vx-draft-foot' }, p.words),
            ]),
            h('span', { class: 'vx-bridge', 'aria-hidden': 'true' }, icon('sparkleSolid', 16)),
            h('div', { class: 'vx-note-wrap' }, [
              h('div', { class: 'vx-note-stack', 'aria-hidden': 'true' }),
              h('div', { class: 'vx-note' }, [
                h('p', { class: 'vx-note-head' }, [icon('sparkleSolid', 12), p.title, p.changes]),
                p.output,
                h('p', { class: 'vx-note-foot' }, [p.status, p.copy]),
              ]),
            ]),
          ]),
          h('div', { class: 'vx-actions' }, [
            p.run,
            modeBtn('grammar', 'Grammar', 'grammar'),
            modeBtn('tighten', 'Tighten', 'tighten'),
            h('p', { class: 'vx-fine' }, [
              h('strong', { text: 'Polish' }), ' clears the mess and smooths the flow. ',
              h('strong', { text: 'Grammar' }), ' fixes only what is wrong. ',
              h('strong', { text: 'Tighten' }), ' says it in fewer words. Each costs 0.25 credits per 100 words.',
            ]),
          ]),
        ]),
      ]);
    }

    // Insights as the real page lays it out: a usage view (overview,
    // milestones, pace, time saved, fixes, where you dictate, the streak) and
    // a voice view (profile, words, what you taught it, when you speak).
    buildInsightsPage() {
      const uid = this.uid;
      const n = this.ins = { ranges: {}, tabs: {}, panels: {} };
      n.sub = h('p', { class: 'vx-ins-sub' });
      n.words = h('strong');
      n.dictations = h('strong');
      n.streak = h('strong');
      const rangeBtn = (id) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-range-btn',
          'aria-pressed': String(id === this.insightsRange),
          text: INSIGHT_RANGES[id].label,
          on: { click: () => { this.insightsRange = id; this.renderInsights(); } },
        });
        n.ranges[id] = btn;
        return btn;
      };
      const tabBtn = (id, label) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-ins-tab',
          role: 'tab',
          id: uid + '-ins-tab-' + id,
          'aria-controls': uid + '-ins-' + id,
          'aria-selected': 'false',
          text: label,
          on: {
            click: () => { this.insightsTab = id; this.renderInsights(); },
            keydown: (e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              this.insightsTab = this.insightsTab === 'usage' ? 'voice' : 'usage';
              this.renderInsights();
              n.tabs[this.insightsTab].focus({ preventScroll: true });
            },
          },
        });
        n.tabs[id] = btn;
        return btn;
      };

      // Milestones: the shelf and the strip.
      n.books = h('div', { class: 'vx-shelf-books', 'aria-hidden': 'true' });
      n.shelfCaption = h('p', { class: 'vx-shelf-caption' });
      n.msTitle = h('p', { class: 'vx-ms-title' });
      n.msCopy = h('p', { class: 'vx-ms-copy' });
      n.msFill = h('span', { class: 'vx-progress-fill' });
      n.msNext = h('span', { class: 'vx-progress-label' });
      n.msStrip = h('ol', { class: 'vx-ms-strip', 'aria-label': 'Milestones this year' });

      // Pace.
      const arcLen = Math.PI * 56;
      n.gaugeFill = s('path', {
        class: 'vx-gauge-fill', d: 'M14 72 A56 56 0 0 1 126 72', fill: 'none', 'stroke-width': 12, 'stroke-linecap': 'round',
        'stroke-dasharray': arcLen.toFixed(1), 'stroke-dashoffset': arcLen.toFixed(1),
      });
      n.arcLen = arcLen;
      n.paceFoot = h('p', { class: 'vx-ins-foot' });
      n.saved = h('span', { class: 'vx-ins-big' });
      n.savedLine = h('p', { class: 'vx-ins-line' });
      n.fixTotal = h('span', { class: 'vx-ins-big' });
      n.fixStyle = h('b');
      n.fixDict = h('b');
      n.lb = h('ol', { class: 'vx-lb', 'aria-label': 'Apps ranked by words dictated' });
      n.heat = h('div', { class: 'vx-heat-grid', role: 'img' });
      n.heatMonths = h('div', { class: 'vx-heat-months', 'aria-hidden': 'true' });

      // Voice.
      n.profileName = h('p', { class: 'vx-profile-name' });
      n.profileCopy = h('p', { class: 'vx-profile-copy' });
      n.profilePct = h('strong', { class: 'vx-profile-pct' });
      n.profileFill = h('span', { class: 'vx-profile-fill' });
      n.profileMeta = h('span');
      n.profileWords = h('span');
      n.ladder = h('div', { class: 'vx-ladder', 'aria-label': 'Voice profile milestones', role: 'list' });
      n.cloud = h('div', { class: 'vx-cloud' });
      n.taughtDict = h('span', { class: 'vx-stat-val' });
      n.hours = h('div', { class: 'vx-hours', role: 'img' });

      const card = (span, kids, extraClass) => h('div', { class: 'vx-ins-card vx-span-' + span + (extraClass ? ' ' + extraClass : '') }, kids);
      const sectionHead = (title, meta) => h('div', { class: 'vx-ins-section-head' }, [h('p', { class: 'vx-ins-h', text: title }), meta || null]);

      n.panels.usage = h('div', { class: 'vx-ins-grid', id: uid + '-ins-usage', role: 'tabpanel', 'aria-labelledby': uid + '-ins-tab-usage' }, [
        card(12, [
          h('div', { class: 'vx-shelf' }, [n.books, h('span', { class: 'vx-shelf-board', 'aria-hidden': 'true' }), n.shelfCaption]),
          h('div', { class: 'vx-ms-body' }, [
            h('span', { class: 'vx-cap-label', text: 'Milestones' }),
            n.msTitle,
            n.msCopy,
            h('div', { class: 'vx-progress' }, [h('span', { class: 'vx-progress-track' }, n.msFill), n.msNext]),
            n.msStrip,
          ]),
        ], 'vx-ms-card'),
        card(4, [
          h('span', { class: 'vx-ins-card-head' }, [h('span', { class: 'vx-ins-big', text: String(PACE_WPM) }), h('span', { class: 'vx-cap-label', text: 'Words per minute' })]),
          h('span', { class: 'vx-gauge-wrap' }, [
            s('svg', { viewBox: '0 0 140 82', class: 'vx-gauge', 'aria-hidden': 'true', focusable: 'false' }, [
              s('path', { class: 'vx-gauge-track', d: 'M14 72 A56 56 0 0 1 126 72', fill: 'none', 'stroke-width': 12, 'stroke-linecap': 'round' }),
              n.gaugeFill,
            ]),
            h('span', { class: 'vx-gauge-inner' }, [
              h('span', { class: 'vx-gauge-top', text: (PACE_WPM / TYPING_WPM).toFixed(1) + '×' }),
              h('span', { class: 'vx-gauge-sub', text: 'vs typing' }),
            ]),
          ]),
          n.paceFoot,
        ]),
        card(4, [
          h('span', { class: 'vx-ins-card-head' }, [n.saved, h('span', { class: 'vx-cap-label', text: 'Saved vs typing' })]),
          n.savedLine,
          h('p', { class: 'vx-ins-foot', text: 'Compared with typing at 40 words per minute.' }),
        ]),
        card(4, [
          h('span', { class: 'vx-ins-card-head' }, [n.fixTotal, h('span', { class: 'vx-cap-label', text: 'Fixes made by Voxden' })]),
          h('ul', { class: 'vx-ins-rows' }, [
            h('li', null, [h('i', { class: 'vx-dot' }), n.fixStyle, ' words changed']),
            h('li', null, [h('i', { class: 'vx-dot vx-dot-dict' }), n.fixDict, ' dictionary fixes']),
          ]),
          h('p', { class: 'vx-ins-foot', text: 'Words changed covers filler cleanup and your writing style.' }),
        ]),
        card(6, [sectionHead('Where you dictate', h('span', { class: 'vx-meta-label' }, ['Apps ', h('i', { text: '|' }), ' ', h('b', { text: String(WHERE.length) })])), n.lb]),
        card(6, [
          sectionHead(STREAK_DAYS + ' day streak', h('span', { class: 'vx-meta-label' }, ['Longest streak ', h('i', { text: '|' }), ' ', h('b', { text: String(LONGEST_STREAK) }), ' days'])),
          h('div', { class: 'vx-heat' }, [
            h('div', { class: 'vx-heat-days', 'aria-hidden': 'true' }, ['Mon', '', 'Wed', '', 'Fri', '', ''].map((d) => h('span', { text: d }))),
            h('div', { class: 'vx-heat-cols' }, [n.heatMonths, n.heat]),
          ]),
          h('p', { class: 'vx-heat-legend', 'aria-hidden': 'true' }, [
            'Less', h('i', { 'data-level': '1' }), h('i', { 'data-level': '2' }), h('i', { 'data-level': '3' }), h('i', { 'data-level': '4' }), 'More',
            h('span', { class: 'vx-legend-gap' }), h('i', { class: 'is-streak' }), 'Current streak',
          ]),
        ]),
      ]);

      n.panels.voice = h('div', { class: 'vx-ins-grid', id: uid + '-ins-voice', role: 'tabpanel', 'aria-labelledby': uid + '-ins-tab-voice', hidden: true }, [
        card(12, [
          h('div', { class: 'vx-profile-head' }, [
            h('div', { class: 'vx-profile-title' }, [
              h('span', { class: 'vx-cap-label', text: 'Your voice profile' }),
              h('p', { class: 'vx-profile-name-row' }, [n.profileName, h('span', { class: 'vx-profile-status', text: 'Current' })]),
              n.profileCopy,
            ]),
            n.profilePct,
          ]),
          h('div', { class: 'vx-profile-progress' }, [
            h('span', { class: 'vx-profile-track', 'aria-hidden': 'true' }, n.profileFill),
            h('span', { class: 'vx-profile-meta' }, [n.profileMeta, n.profileWords]),
          ]),
          n.ladder,
        ], 'vx-profile-card'),
        card(6, [sectionHead('Words you use most', h('span', { class: 'vx-meta-label' }, ['Top ', h('i', { text: '|' }), ' ', h('b', { text: String(TOP_WORDS.length) })])), n.cloud]),
        card(6, [
          sectionHead('What you taught Voxden'),
          h('ul', { class: 'vx-stat-rows' }, [
            h('li', null, [h('span', { class: 'vx-stat-key', text: 'Dictionary entries' }), n.taughtDict]),
            h('li', null, [h('span', { class: 'vx-stat-key', text: 'Spellings you taught' }), h('span', { class: 'vx-stat-val', text: '3' })]),
            h('li', null, [h('span', { class: 'vx-stat-key', text: 'Transcripts you edited' }), h('span', { class: 'vx-stat-val', text: '12' })]),
          ]),
          h('p', { class: 'vx-ins-foot', text: 'Edit a transcript and Voxden learns that spelling for next time.' }),
        ]),
        card(8, [sectionHead('When you speak', h('span', { class: 'vx-meta-label' }, ['Most active ', h('i', { text: '|' }), ' ', h('b', { text: '10 AM' })])), n.hours]),
        card(4, [
          sectionHead('Dictation length'),
          h('ul', { class: 'vx-stat-rows' }, [
            h('li', null, [h('span', { class: 'vx-stat-key', text: 'Average' }), h('span', { class: 'vx-stat-val', text: '49 words' })]),
            h('li', null, [h('span', { class: 'vx-stat-key', text: 'Longest' }), h('span', { class: 'vx-stat-val', text: '212 words' })]),
          ]),
          h('p', { class: 'vx-ins-foot', text: 'Words per dictation in this range.' }),
        ]),
      ]);

      const page = this.makePage('insights', [
        this.pageHead('Your progress', 'Insights', 'Small moments of flow. A little more time for you.',
          h('div', { class: 'vx-range', role: 'group', 'aria-label': 'Time range' }, [rangeBtn('7d'), rangeBtn('30d'), rangeBtn('all')])),
        h('div', { class: 'vx-ins-tabs', role: 'tablist', 'aria-label': 'Insights sections' }, [tabBtn('usage', 'Your usage'), tabBtn('voice', 'Your voice')]),
        n.sub,
        h('div', { class: 'vx-ins-overview' }, [
          h('p', { class: 'vx-ins-ov' }, [h('span', { text: 'Words dictated' }), n.words]),
          h('p', { class: 'vx-ins-ov' }, [h('span', { text: 'Dictations' }), n.dictations]),
          h('p', { class: 'vx-ins-ov' }, [h('span', { text: 'Current streak · all time' }), h('strong', null, [String(STREAK_DAYS) + ' ', h('small', { text: 'days' })])]),
        ]),
        n.panels.usage,
        n.panels.voice,
      ]);
      this.buildHeatmap();
      this.buildHours();
      return page;
    }

    // Seventeen weeks, a column each, the current streak outlined.
    buildHeatmap() {
      const n = this.ins;
      const today = daysAgo(this.now, 0);
      const monday = daysAgo(this.now, (this.now.getDay() + 6) % 7);
      const start = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() - 16 * 7);
      empty(n.heat);
      empty(n.heatMonths);
      let lastMonth = -1;
      let active = 0;
      for (let c = 0; c < 17; c++) {
        const colStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() + c * 7);
        const label = colStart.getMonth() !== lastMonth ? colStart.toLocaleDateString('en-US', { month: 'short' }) : '';
        lastMonth = colStart.getMonth();
        n.heatMonths.appendChild(h('span', { text: label }));
        const col = h('div', { class: 'vx-heat-col' });
        for (let r = 0; r < 7; r++) {
          const day = new Date(colStart.getFullYear(), colStart.getMonth(), colStart.getDate() + r);
          const ago = Math.round((today - day) / 86400000);
          if (ago < 0) { col.appendChild(h('i', { class: 'is-future' })); continue; }
          let level = 0;
          if (ago < STREAK_DAYS) level = 1 + Math.floor(seeded(ago + 3) * 4);
          else if (ago === STREAK_DAYS) level = 0;
          else if (ago >= 38 && ago < 38 + LONGEST_STREAK) level = 1 + Math.floor(seeded(ago * 7) * 4);
          else level = seeded(ago * 3.1) < 0.42 ? 0 : 1 + Math.floor(seeded(ago * 5.3) * 4);
          if (level) active++;
          col.appendChild(h('i', { 'data-level': String(level), class: ago < STREAK_DAYS ? 'is-streak' : null }));
        }
        n.heat.appendChild(col);
      }
      n.heat.setAttribute('aria-label', 'Dictation activity over the last 17 weeks: ' + active + ' active days, the last ' + STREAK_DAYS + ' in a row');
    }

    buildHours() {
      const n = this.ins;
      const max = Math.max.apply(null, HOURS);
      empty(n.hours);
      HOURS.forEach((count, hour) => {
        n.hours.appendChild(h('span', { class: 'vx-hour' + (count === max ? ' is-peak' : '') }, [
          h('i', { style: { height: Math.max(3, Math.round((count / max) * 100)) + '%' } }),
        ]));
      });
      const labels = h('span', { class: 'vx-hours-axis', 'aria-hidden': 'true' }, ['12 AM', '6 AM', '12 PM', '6 PM', '12 AM'].map((t) => h('span', { text: t })));
      n.hours.appendChild(labels);
      n.hours.setAttribute('aria-label', 'Dictations by hour of the day, busiest at 10 AM');
    }

    // Settings, as the real app opens it: a dialog over the content with the
    // category list on the left. Every control works here, and nothing leaves
    // the page.
    buildSettings() {
      const uid = this.uid;
      const st2 = this.settingsUi = { cats: {}, panels: {}, toggles: {} };
      const cats = [
        ['general', 'General', 'catGeneral'],
        ['account', 'Account', 'catAccount'],
        ['billing', 'Plans & billing', 'catBilling'],
        ['engines', 'Speech engines', 'catEngines'],
        ['system', 'System', 'catSystem'],
        ['display', 'Display', 'catDisplay'],
        ['sound', 'Sound', 'catSound'],
        ['privacy', 'Data and privacy', 'catPrivacy'],
      ];
      const catList = h('div', {
        class: 'vx-set-cats',
        role: 'tablist',
        'aria-label': 'Settings categories',
        'aria-orientation': 'vertical',
        on: { keydown: (e) => this.onSettingsCatKey(e, cats.map((c) => c[0])) },
      }, cats.map((cat) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-set-cat',
          role: 'tab',
          id: uid + '-set-tab-' + cat[0],
          'aria-controls': uid + '-set-' + cat[0],
          'aria-selected': 'false',
          tabindex: '-1',
          on: { click: () => this.showSettingsCat(cat[0], false) },
        }, [h('span', { class: 'vx-set-cat-ico' }, icon(cat[2], 18)), h('span', { class: 'vx-set-cat-label', text: cat[1] })]);
        st2.cats[cat[0]] = btn;
        return btn;
      }));

      const panel = (id, title, kids) => {
        const el = h('div', {
          class: 'vx-set-panel',
          id: uid + '-set-' + id,
          role: 'tabpanel',
          'aria-labelledby': uid + '-set-tab-' + id,
          hidden: true,
        }, [h('p', { class: 'vx-set-title', text: title })].concat(kids));
        st2.panels[id] = el;
        return el;
      };
      const row = (label, hint, control, extra) => {
        const labelId = uid + '-set-l-' + (++this.idSeq);
        const hintId = hint ? labelId + '-h' : null;
        const node = h('div', { class: 'vx-set-row' + (extra ? ' ' + extra : '') }, [
          h('div', { class: 'vx-set-copy' }, [
            h('span', { class: 'vx-set-label', id: labelId, text: label }),
            hint ? h('span', { class: 'vx-set-hint', id: hintId, text: hint }) : null,
          ]),
          control ? h('div', { class: 'vx-set-control' }, typeof control === 'function' ? control(labelId, hintId) : control) : null,
        ]);
        return node;
      };
      const toggle = (key, onChange) => (labelId, hintId) => {
        const input = h('input', {
          type: 'checkbox',
          class: 'vx-toggle-input',
          role: 'switch',
          'aria-labelledby': labelId,
          'aria-describedby': hintId,
          on: { change: () => { this.settings[key] = input.checked; if (onChange) onChange(input.checked); this.renderSettings(); } },
        });
        st2.toggles[key] = input;
        return h('label', { class: 'vx-toggle' }, [input, h('span', { class: 'vx-toggle-track', 'aria-hidden': 'true' })]);
      };
      const segmented = (key, options, labelId, onChange) => {
        const group = h('div', { class: 'vx-seg vx-set-seg', role: 'radiogroup', 'aria-labelledby': labelId });
        options.forEach((opt) => {
          const btn = h('button', {
            type: 'button',
            class: 'vx-seg-btn',
            role: 'radio',
            'aria-checked': 'false',
            'data-value': opt[0],
            text: opt[1],
            on: { click: () => { this.settings[key] = opt[0]; if (onChange) onChange(opt[0]); this.renderSettings(); } },
          });
          group.appendChild(btn);
        });
        st2['seg-' + key] = group;
        return group;
      };
      this.idSeq = 0;

      // General.
      st2.modeHint = h('span', { class: 'vx-set-hint' });
      const micSelect = h('select', {
        class: 'vx-select',
        on: { change: () => { this.settings.mic = micSelect.selectedIndex; } },
      }, MICS.map((m) => h('option', { text: m })));
      st2.mic = micSelect;
      const modeRow = h('div', { class: 'vx-set-row' }, [
        h('div', { class: 'vx-set-copy' }, [h('span', { class: 'vx-set-label', id: uid + '-set-mode', text: 'Dictation mode' }), st2.modeHint]),
        h('div', { class: 'vx-set-control' }, segmented('mode', [['toggle', 'Toggle'], ['ptt', 'Push to talk']], uid + '-set-mode')),
      ]);
      const micRow = row('Microphone', null, (labelId) => { micSelect.setAttribute('aria-labelledby', labelId); return micSelect; });
      st2.more = h('details', { class: 'vx-set-more' }, [
        h('summary', null, [h('span', { class: 'vx-set-label', text: 'More options' }), h('span', { class: 'vx-set-hint', text: 'Speed, app language & dictionary learning' })]),
        h('div', { class: 'vx-set-more-body' }, [
          row('Dictation speed', 'Auto balances speed and accuracy.', (labelId) => segmented('speed', [['auto', 'Auto'], ['fast', 'Fast'], ['accurate', 'Accurate']], labelId)),
          row('Auto-add to dictionary', 'Remember words you correct.', toggle('autoAdd')),
        ]),
      ]);
      panel('general', 'General', [
        h('p', { class: 'vx-set-group', text: 'Dictation' }),
        row('Shortcuts', 'Dictation and paste.', [
          h('span', { class: 'vx-keys' }, [h('kbd', { class: 'vx-kbd', text: 'Ctrl' }), h('span', { class: 'vx-plus', text: '+' }), h('kbd', { class: 'vx-kbd', text: 'Win' })]),
          h('span', { class: 'vx-keys' }, [h('kbd', { class: 'vx-kbd', text: 'Ctrl' }), h('span', { class: 'vx-plus', text: '+' }), h('kbd', { class: 'vx-kbd', text: 'Alt' }), h('span', { class: 'vx-plus', text: '+' }), h('kbd', { class: 'vx-kbd', text: 'V' })]),
        ]),
        modeRow,
        h('p', { class: 'vx-set-group', text: 'Voice & language' }),
        micRow,
        row('Dictation languages', 'Up to three with Voxden Cloud on Pro.', h('span', { class: 'vx-set-value', text: 'English, Hinglish' })),
        st2.more,
      ]);

      // Account.
      panel('account', 'Account', [
        h('div', { class: 'vx-account-card' }, [
          h('span', { class: 'vx-pc-avatar', 'aria-hidden': 'true' }, ['A', h('span', { class: 'vx-pc-badge', text: 'PRO' })]),
          h('div', { class: 'vx-pc-fields' }, [
            h('p', { class: 'vx-pc-field' }, [h('span', { text: 'Name' }), h('strong', { text: 'Alex Rivera' })]),
            h('p', { class: 'vx-pc-field' }, [h('span', { text: 'Email' }), h('strong', { text: 'alex@example.com' })]),
            h('p', { class: 'vx-pc-field' }, [h('span', { text: 'Plan' }), h('strong', { text: 'Voxden Pro' })]),
          ]),
        ]),
        h('button', { type: 'button', class: 'vx-btn-secondary', text: 'View plans & billing', on: { click: () => this.showSettingsCat('billing', true) } }),
      ]);

      // Plans & billing.
      st2.billingLeft = h('span');
      panel('billing', 'Plans & billing', [
        h('p', { class: 'vx-set-lead', text: 'Your voice. Your apps. One simple monthly plan.' }),
        h('div', { class: 'vx-plans' }, [
          h('div', { class: 'vx-plan' }, [
            h('p', { class: 'vx-plan-name', text: 'Free' }),
            h('p', { class: 'vx-plan-copy', text: 'Keep your dictation on this PC.' }),
            h('ul', { class: 'vx-plan-list' }, ['3,000 words a week', 'On-device dictation', 'Your personal dictionary', 'Works offline after setup'].map((f) => h('li', { text: f }))),
          ]),
          h('div', { class: 'vx-plan vx-plan-pro' }, [
            h('p', { class: 'vx-plan-name' }, ['Voxden Pro', h('span', { class: 'vx-plan-badge', text: 'Your plan' })]),
            h('p', { class: 'vx-plan-copy', text: 'Speak freely. Keep work moving.' }),
            h('ul', { class: 'vx-plan-list' }, ['Cloud dictation', 'No weekly word limit on this PC', 'Dictate in up to three languages at once', '60 languages through the cloud, Hindi and Hinglish included', 'Polish, Grammar and Tighten'].map((f) => h('li', { text: f }))),
            h('p', { class: 'vx-plan-usage' }, st2.billingLeft),
          ]),
        ]),
      ]);

      // Speech engines.
      st2.listen = {};
      const listenCard = (id, name, line, badge) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-listen-card',
          role: 'radio',
          'aria-checked': 'false',
          on: { click: () => { this.settings.listen = id; this.renderSettings(); } },
        }, [
          h('span', { class: 'vx-listen-head' }, [h('span', { class: 'vx-listen-name', text: name }), badge ? h('span', { class: 'vx-listen-badge', text: badge }) : null]),
          h('span', { class: 'vx-listen-line', text: line }),
          id === 'cloud' ? (st2.cloudLine = h('span', { class: 'vx-listen-line vx-listen-credits' })) : null,
          h('span', { class: 'vx-listen-dot', 'aria-hidden': 'true' }),
        ]);
        st2.listen[id] = btn;
        return btn;
      };
      st2.models = h('ul', { class: 'vx-models', 'aria-label': 'Models on this PC' });
      panel('engines', 'Speech engines', [
        h('p', { class: 'vx-set-group', id: uid + '-listen', text: 'How Voxden listens' }),
        h('div', { class: 'vx-listen', role: 'radiogroup', 'aria-labelledby': uid + '-listen' }, [
          listenCard('local', 'On this PC', 'Your audio stays on this PC.'),
          listenCard('cloud', 'Voxden Cloud', 'Your audio goes to Voxden Cloud, which knows more languages.', 'Pro'),
        ]),
        h('p', { class: 'vx-set-group', text: 'Model' }),
        st2.models,
      ]);

      // System.
      st2.updateNote = h('span', { class: 'vx-set-hint', role: 'status' });
      st2.updateBtn = h('button', { type: 'button', class: 'vx-btn-secondary', text: 'Check now', on: { click: () => this.checkUpdates() } });
      panel('system', 'System', [
        h('p', { class: 'vx-set-group', text: 'Startup & window' }),
        row('Launch at login', 'Start Voxden when you sign in to Windows.', toggle('launchLogin')),
        row('Show app in taskbar', 'Keep Voxden in the taskbar when the window is closed.', toggle('taskbar')),
        h('p', { class: 'vx-set-group', text: 'Updates' }),
        row('Install updates automatically', 'Voxden restarts into a new version when you are not dictating.', toggle('autoUpdate')),
        h('div', { class: 'vx-set-row' }, [
          h('div', { class: 'vx-set-copy' }, [h('span', { class: 'vx-set-label', text: 'Check for updates' }), st2.updateNote]),
          h('div', { class: 'vx-set-control' }, st2.updateBtn),
        ]),
      ]);

      // Display.
      st2.theme = {};
      const themeCard = (id, name, desc) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-theme-card',
          role: 'radio',
          'aria-checked': 'false',
          on: { click: () => { this.settings.theme = id; this.renderSettings(); } },
        }, [
          h('span', { class: 'vx-theme-preview vx-theme-' + id, 'aria-hidden': 'true' }, [h('i', { class: 'vx-tp-nav' }), h('i', { class: 'vx-tp-head' }), h('i', { class: 'vx-tp-card' }), h('i', { class: 'vx-tp-accent' })]),
          h('span', { class: 'vx-theme-name' }, [name, h('span', { class: 'vx-theme-check', 'aria-hidden': 'true', text: '✓' })]),
          h('span', { class: 'vx-theme-desc', text: desc }),
        ]);
        st2.theme[id] = btn;
        return btn;
      };
      st2.flowStyle = {};
      const styleCard = (id, name, desc) => {
        const btn = h('button', {
          type: 'button',
          class: 'vx-style-choice',
          role: 'radio',
          'aria-checked': 'false',
          on: { click: () => { this.settings.flowStyle = id; this.renderSettings(); } },
        }, [
          h('span', { class: 'vx-choice-preview vx-choice-' + id, 'aria-hidden': 'true' }, id === 'island'
            ? h('span', { class: 'vx-cp-island' }, [h('span', { class: 'vx-cp-key' }, icon('x', 9)), h('span', { class: 'vx-cp-key vx-cp-stop' })])
            : h('span', { class: 'vx-cp-orb' })),
          h('span', { class: 'vx-choice-name', text: name }),
          h('span', { class: 'vx-choice-desc', text: desc }),
        ]);
        st2.flowStyle[id] = btn;
        return btn;
      };
      st2.themeNote = h('p', { class: 'vx-set-hint vx-set-note', role: 'status' });
      st2.styleNote = h('p', { class: 'vx-set-hint vx-set-note', role: 'status' });
      st2.motion = h('select', {
        class: 'vx-select',
        on: { change: () => { this.settings.flowMotion = st2.motion.value; this.applyFlowMotion(); } },
      }, [h('option', { value: 'system', text: 'Follow system' }), h('option', { value: 'full', text: 'On' }), h('option', { value: 'reduced', text: 'Reduced' })]);
      panel('display', 'Display', [
        h('p', { class: 'vx-set-group', id: uid + '-theme', text: 'App theme' }),
        h('div', { class: 'vx-theme-options', role: 'radiogroup', 'aria-labelledby': uid + '-theme' }, [
          themeCard('voxden', 'Voxden', 'Charcoal & mint'),
          themeCard('white', 'White', 'Soft white & mint'),
        ]),
        st2.themeNote,
        h('p', { class: 'vx-set-group', id: uid + '-flowstyle', text: 'Flow bar style' }),
        h('div', { class: 'vx-choice-options', role: 'radiogroup', 'aria-labelledby': uid + '-flowstyle' }, [
          styleCard('island', 'Island', 'One black shape. Fluid motion.'),
          styleCard('orb', 'Orb', 'A glowing voice sphere.'),
        ]),
        st2.styleNote,
        row('Always show flow bar', 'Keep it visible between dictations.', toggle('alwaysFlow', () => this.syncBar())),
        row('Flow bar animations', 'Reduced keeps the bar and its meter still.', (labelId) => { st2.motion.setAttribute('aria-labelledby', labelId); return st2.motion; }),
      ]);

      // Sound.
      panel('sound', 'Sound', [
        row('Dictation and notification sounds', 'Play short cues when dictation starts, finishes, or fails.', toggle('sounds', () => this.renderSound())),
        row('Mute other audio while dictating', 'Pauses music and silences calls, videos, and other playback while your microphone is open.', toggle('muteAudio')),
        row('Suggestions', 'Show helpful tips inside Voxden.', toggle('suggestions')),
      ]);

      // Data and privacy.
      const storeToggle = h('label', { class: 'vx-toggle' }, [
        h('input', { type: 'checkbox', class: 'vx-toggle-input', role: 'switch', checked: true, disabled: true, 'aria-label': 'Store data on this PC' }),
        h('span', { class: 'vx-toggle-track', 'aria-hidden': 'true' }),
      ]);
      panel('privacy', 'Data and privacy', [
        row('Store data on this PC', 'Dictations and corrections stay in your local data folder.', storeToggle),
        row('Keep recordings', 'Keeps the audio behind each dictation for 14 days so you can replay, save or retry it.', toggle('keepRecordings')),
        row('Keep audio for training', 'Keeps audio behind corrected dictations to train on your voice. Stays on this PC, off by default.', toggle('training')),
      ]);

      st2.dialog = h('div', {
        class: 'vx-settings',
        role: 'dialog',
        'aria-label': 'Settings',
        tabindex: '-1',
        on: { keydown: (e) => this.onSettingsKey(e) },
      }, [
        h('div', { class: 'vx-set-layout' }, [
          catList,
          h('div', { class: 'vx-set-detail' }, Object.keys(st2.panels).map((key) => st2.panels[key])),
        ]),
        h('button', { type: 'button', class: 'vx-set-close', 'aria-label': 'Close settings', title: 'Close', on: { click: () => this.closeSettings() } }, icon('close', 14)),
      ]);
      st2.layer = h('div', {
        class: 'vx-settings-layer',
        hidden: true,
        on: { pointerdown: (e) => { if (e.target === st2.layer) this.closeSettings(); } },
      }, st2.dialog);
      return st2.layer;
    }

    // --- Building: the dictation playground ------------------------------------

    buildDictation() {
      const host = this.dictHost;
      empty(host);
      if (host.hasAttribute('aria-label') && !host.hasAttribute('role')) host.setAttribute('role', 'region');
      this.status = h('div', { class: 'vx-sr', role: 'status', 'aria-live': 'polite' });
      this.targetWin = this.buildTargetWindow();
      this.flowBar = this.buildFlowBar();
      this.dictRoot = h('div', {
        class: 'vx-root vx-dict',
        tabindex: '0',
        role: 'group',
        'aria-label': 'Dictation playground. Press Space to dictate.',
      }, [
        this.buildToolbar(),
        h('div', { class: 'vx-client' }, [this.targetWin, this.flowBar]),
        this.status,
        h('div', { class: 'vx-ruler-box', 'aria-hidden': 'true' }, this.ruler = h('span', { class: 'vx-ruler' })),
      ]);
      host.appendChild(this.dictRoot);
      this.renderScenario();
    }

    buildToolbar() {
      this.chips = SCENARIOS.map((sc, index) => h('button', {
        type: 'button',
        class: 'vx-chip',
        'aria-pressed': String(index === this.scenarioIndex),
        on: { click: () => this.selectScenario(index) },
      }, [
        icon(sc.icon, 14, 'vx-chip-ico'),
        h('span', { class: 'vx-chip-long', text: sc.label }),
        h('span', { class: 'vx-chip-short', text: sc.short }),
      ]));

      this.soundBtn = h('button', {
        type: 'button',
        class: 'vx-sound',
        'aria-pressed': 'true',
        'aria-label': 'Sound',
        title: 'Start and finish sounds',
        on: { click: () => { this.settings.sounds = !this.settings.sounds; this.renderSound(); } },
      }, [icon('speaker', 16, 'vx-sound-on'), icon('speakerOff', 16, 'vx-sound-off')]);

      return h('div', { class: 'vx-toolbar' }, [
        h('span', { class: 'vx-toolbar-label', id: this.uid + '-pick', text: 'Try a dictation' }),
        h('div', { class: 'vx-chips', role: 'group', 'aria-labelledby': this.uid + '-pick' }, this.chips),
        h('div', { class: 'vx-toolbar-end' }, [
          h('span', { class: 'vx-shortcut' }, [
            h('span', { class: 'vx-shortcut-copy', text: 'In the app, press' }),
            h('kbd', { class: 'vx-kbd', text: 'Ctrl' }),
            h('span', { class: 'vx-plus', 'aria-hidden': 'true', text: '+' }),
            h('kbd', { class: 'vx-kbd', text: 'Win' }),
          ]),
          this.soundBtn,
        ]),
      ]);
    }

    // The box the words land in: the #launch channel (or a direct message),
    // and for the email sample a mail draft in the same place.
    buildTargetWindow() {
      const t = this.target = {};
      t.head = h('div', { class: 'vx-chat-head' });
      t.msgs = h('div', { class: 'vx-msgs', role: 'log', 'aria-label': 'Messages' });
      t.chatComposer = this.buildComposer('chat');
      t.chat = h('div', { class: 'vx-chat' }, [t.head, t.msgs, t.chatComposer.wrap]);

      t.mailComposer = this.buildComposer('mail');
      t.mailToast = h('p', { class: 'vx-mail-toast', role: 'status', 'aria-live': 'polite' });
      t.mailSend = h('button', { type: 'button', class: 'vx-mail-send', disabled: true, on: { click: () => this.sendMessage() } }, [icon('send', 13), 'Send']);
      t.mail = h('div', { class: 'vx-mail' }, [
        h('div', { class: 'vx-mail-fields' }, [
          h('p', { class: 'vx-mail-field' }, [
            h('span', { class: 'vx-mail-label', text: 'To' }),
            h('span', { class: 'vx-mail-chip' }, [h('span', { class: 'vx-mail-chip-av', 'aria-hidden': 'true', text: 'D' }), 'Daniel Brooks']),
          ]),
          h('p', { class: 'vx-mail-field' }, [
            h('span', { class: 'vx-mail-label', text: 'Subject' }),
            h('span', { class: 'vx-mail-subject', text: 'Re: Kickoff date' }),
          ]),
        ]),
        h('div', { class: 'vx-mail-body' }, [
          h('p', { class: 'vx-mail-greet', text: 'Hi Daniel,' }),
          t.mailComposer.wrap,
          h('p', { class: 'vx-mail-sign' }, ['Best,', h('br'), 'Alex']),
          h('div', { class: 'vx-mail-quote' }, [
            h('p', { class: 'vx-mail-quote-head', text: 'On Tuesday, Daniel Brooks wrote:' }),
            h('p', { text: 'Could you confirm when your team can start the Halden onboarding? We’re free most of next week.' }),
          ]),
        ]),
        h('div', { class: 'vx-mail-bar' }, [
          t.mailSend,
          h('span', { class: 'vx-mail-tools', 'aria-hidden': 'true' }, [icon('paperclip', 15), icon('bold', 15), icon('link', 15), icon('more', 15)]),
        ]),
        t.mailToast,
      ]);

      return h('div', { class: 'vx-win vx-win-target', role: 'group', 'aria-label': 'Where the words go' }, [
        h('div', { class: 'vx-target-body' }, [t.chat, t.mail]),
      ]);
    }

    buildComposer(kind) {
      const c = { kind };
      c.placeholder = h('span', { class: 'vx-placeholder', 'aria-hidden': 'true' });
      c.typed = h('span', { class: 'vx-typed' });
      c.caret = h('span', { class: 'vx-caret', 'aria-hidden': 'true' });
      c.text = h('div', { class: 'vx-comp-text', 'aria-live': 'polite' }, [c.placeholder, c.typed, c.caret]);
      if (kind === 'chat') {
        c.send = h('button', { type: 'button', class: 'vx-send', 'aria-label': 'Send message', disabled: true, on: { click: () => this.sendMessage() } }, icon('send', 14));
        c.wrap = h('div', { class: 'vx-composer' }, [
          h('div', { class: 'vx-comp-box' }, [
            c.text,
            h('div', { class: 'vx-comp-tools' }, [
              h('span', { class: 'vx-comp-icons', 'aria-hidden': 'true' }, [icon('bold', 14), icon('link', 14), icon('at', 14), icon('smile', 14)]),
              c.send,
            ]),
          ]),
        ]);
      } else {
        c.wrap = h('div', { class: 'vx-mail-compose' }, c.text);
      }
      return c;
    }

    buildFlowBar() {
      const fb = this.fb;
      fb.captionText = h('span', { class: 'vx-cap-line' });
      fb.captionBox = h('p', { class: 'vx-cap-text' }, fb.captionText);
      fb.captions = h('div', { class: 'vx-captions', 'aria-hidden': 'true' }, h('div', { class: 'vx-cap-inner' }, [
        h('p', { class: 'vx-cap-head' }, [h('span', { class: 'vx-cap-dot' }), 'Speaking']),
        fb.captionBox,
      ]));

      fb.hit = h('button', {
        type: 'button',
        class: 'vx-pill-hit',
        'aria-label': 'Start dictation',
        on: {
          click: () => this.onPillClick(),
          // Keyboard focus opens the bar the way hovering does; a click's
          // focus does not keep it open after the pointer leaves.
          focus: () => { fb.focus = keyboardFocus(fb.hit); this.syncBar(); },
          blur: () => { fb.focus = false; this.syncBar(); },
        },
      });
      fb.cancel = h('button', {
        type: 'button',
        class: 'vx-act vx-act-cancel',
        'aria-label': 'Cancel recording',
        title: 'Cancel',
        tabindex: '-1',
        on: { click: (e) => { e.stopPropagation(); this.cancelDictation(); } },
      }, icon('x', 10));
      fb.polishBtn = h('button', {
        type: 'button',
        class: 'vx-act vx-act-polish',
        'aria-label': 'Polish this dictation, 0.25 credits',
        title: 'Polish · 0.25 credits',
        tabindex: '-1',
        on: { click: (e) => { e.stopPropagation(); this.polishFromBar(); } },
      }, icon('sparkle', 13));
      fb.stop = h('button', {
        type: 'button',
        class: 'vx-act vx-act-stop',
        'aria-hidden': 'true',
        tabindex: '-1',
        title: 'Stop and transcribe',
        on: { click: (e) => { e.stopPropagation(); this.stopDictation(); } },
      }, icon('stop', 14.2222));
      fb.mark = h('span', { class: 'vx-mark', 'data-kind': 'check', 'aria-hidden': 'true' }, [
        icon('check', 10, 'vx-mark-check'), icon('xBold', 10, 'vx-mark-x'), icon('bang', 10, 'vx-mark-bang'),
      ]);
      fb.bars = [];
      for (let i = 0; i < 13; i++) fb.bars.push(h('i'));
      fb.waveEl = h('span', { class: 'vx-wave', 'aria-hidden': 'true' }, fb.bars);
      const spokes = [];
      for (let i = 0; i < 8; i++) spokes.push(h('i'));
      fb.spinner = h('span', { class: 'vx-spinner', 'aria-hidden': 'true' }, h('span', { class: 'vx-spinner-turn' }, spokes));
      fb.label = h('span', { class: 'vx-label', 'aria-hidden': 'true' });
      fb.line = h('span', { class: 'vx-line' }, fb.label);
      fb.twin = h('span', { class: 'vx-label-twin', 'aria-hidden': 'true' });
      // Both swap animations hold their last frame; let go of it once they
      // end, so the line's own fades work again.
      fb.label.addEventListener('animationend', () => fb.label.classList.remove('is-swapping'));
      fb.twin.addEventListener('animationend', () => fb.twin.classList.remove('is-fading'));

      fb.pill = h('div', { class: 'vx-pill is-idle is-rest', role: 'group', 'aria-label': 'Voxden flow bar' }, [
        fb.hit,
        h('span', { class: 'vx-fb-side vx-fb-gear', 'aria-hidden': 'true' }, icon('gear', 14)),
        h('span', { class: 'vx-mic', 'aria-hidden': 'true' }, icon('mic', 15)),
        h('span', { class: 'vx-fb-side vx-fb-shot', 'aria-hidden': 'true' }, icon('shot', 14)),
        fb.cancel,
        fb.mark,
        fb.waveEl,
        fb.spinner,
        fb.line,
        fb.twin,
        fb.polishBtn,
        fb.stop,
      ]);
      fb.pill.addEventListener('pointerenter', () => this.onPillPointer(true));
      fb.pill.addEventListener('pointerleave', () => this.onPillPointer(false));
      fb.polishBtn.addEventListener('focus', () => this.onPolishFocus(true));
      fb.polishBtn.addEventListener('blur', () => this.onPolishFocus(false));

      fb.hoverZone = h('div', { class: 'vx-fb-hover', 'aria-hidden': 'true' });
      fb.hoverZone.addEventListener('pointerenter', () => this.onPillPointer(true));
      fb.hoverZone.addEventListener('pointerleave', () => this.onPillPointer(false));
      fb.hoverZone.addEventListener('click', () => { if (fb.mode === 'idle') this.startDictation(); });

      fb.tryit = h('button', {
        type: 'button',
        class: 'vx-tryit',
        on: {
          click: () => this.startDictation(),
          pointerenter: () => this.onPillPointer(true),
          pointerleave: () => this.onPillPointer(false),
        },
      }, [
        icon('chevronUp', 13, 'vx-tryit-arrow'),
        h('span', { class: 'vx-tryit-main', text: 'Try it' }),
        h('span', { class: 'vx-tryit-sub', text: 'click to dictate' }),
        h('kbd', { class: 'vx-kbd vx-tryit-kbd', text: 'Space' }),
      ]);

      return h('div', { class: 'vx-fb' }, [fb.captions, fb.hoverZone, fb.pill, fb.tryit]);
    }

    // --- Events and observers -------------------------------------------------

    bind() {
      if (this.dictRoot) this.dictRoot.addEventListener('keydown', (e) => this.onKey(e));
      // A hidden tab pauses the demo like scrolling it away does; it picks up
      // where it stopped.
      document.addEventListener('visibilitychange', () => this.syncRunning());
    }

    watch() {
      const hosts = [this.appHost, this.dictHost].filter(Boolean);
      if ('IntersectionObserver' in window) {
        this.io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) this.visibleHosts.add(entry.target);
            else this.visibleHosts.delete(entry.target);
          }
          this.setVisible(this.visibleHosts.size > 0);
        }, { rootMargin: '60px 0px' });
        hosts.forEach((host) => this.io.observe(host));
      }
      if ('ResizeObserver' in window) {
        this.ro = new ResizeObserver(() => this.syncLayout());
        hosts.forEach((host) => this.ro.observe(host));
      } else {
        window.addEventListener('resize', () => this.syncLayout());
      }
      // Fonts can change what fits once they load.
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.fit(), () => {});
      if (window.matchMedia) {
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onMotion = () => { this.systemReduced = motion.matches; this.applyFlowMotion(); };
        if (motion.addEventListener) motion.addEventListener('change', onMotion);
        else if (motion.addListener) motion.addListener(onMotion);
        const hover = window.matchMedia('(hover: hover)');
        const onHover = () => { this.canHover = hover.matches; this.syncBar(); };
        if (hover.addEventListener) hover.addEventListener('change', onHover);
        else if (hover.addListener) hover.addListener(onHover);
      }
    }

    setVisible(on) {
      if (this.visible === on) return;
      this.visible = on;
      for (const root of [this.appRoot, this.dictRoot]) if (root) root.classList.toggle('vx-is-offscreen', !on);
      this.syncRunning();
    }

    syncRunning() {
      this.clock.setRunning(this.visible && !document.hidden);
    }

    syncLayout() {
      if (this.appHost) {
        const width = this.appHost.getBoundingClientRect().width;
        this.compactApp = width > 0 && width < COMPACT_BELOW;
        this.tablist.setAttribute('aria-orientation', this.compactApp ? 'horizontal' : 'vertical');
        this.settingsUi.dialog.querySelector('.vx-set-cats').setAttribute('aria-orientation', this.compactApp ? 'horizontal' : 'vertical');
      }
      if (this.dictHost) {
        const width = this.dictHost.getBoundingClientRect().width;
        this.compactDict = width > 0 && width < COMPACT_BELOW;
      }
      this.syncBar();
      this.fit();
    }

    onKey(e) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const mode = this.fb.mode;
      if (e.key === 'Escape' && (mode === 'recording' || mode === 'arming')) {
        e.preventDefault();
        this.cancelDictation();
        return;
      }
      if (e.key !== ' ' && e.key !== 'Spacebar') return;
      const target = e.target;
      if (target && target.closest && target.closest('button, a[href], input, textarea, select, summary, [contenteditable="true"], [contenteditable=""], [role="tab"]')) return;
      e.preventDefault();
      if (e.repeat) return;
      this.toggleDictation();
    }

    onTabKey(e) {
      const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      const order = this.navOrder;
      let index = order.indexOf(this.page);
      if (e.key === 'Home') index = 0;
      else if (e.key === 'End') index = order.length - 1;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') index = (index + 1) % order.length;
      else index = (index - 1 + order.length) % order.length;
      this.showPage(order[index], true);
    }

    showPage(id, focusTab) {
      if (!this.appRoot) return;
      this.page = id;
      for (const key of Object.keys(this.navItems)) {
        const on = key === id;
        const tab = this.navItems[key];
        tab.setAttribute('aria-selected', String(on));
        tab.classList.toggle('is-active', on);
        setTabbable(tab, on);
        this.pages[key].hidden = !on;
      }
      this.fit();
      if (focusTab) this.navItems[id].focus({ preventScroll: true });
    }

    // --- Fit ------------------------------------------------------------------
    // The demo never scrolls: the page on show (and the Settings category, when
    // Settings is open) keeps to its window and ends on a whole card or row.
    // Whatever it let go of comes back first, then its FIT plan runs in order,
    // and a block only goes if that makes room. Runs when a page or category
    // shows, when its content changes, and when the window changes size.
    fit() {
      if (!this.appRoot || !this.page || !this.pages[this.page] || this.fitting) return;
      this.fitting = true;
      try {
        this.fitBox(this.main, this.pages[this.page], FIT[this.page] || []);
        const panel = this.settingsOpen && this.settingsUi.panels[this.settingsCat];
        if (panel) this.fitBox(panel.parentNode, panel, FIT.settings);
      } finally {
        this.fitting = false;
      }
    }

    fitBox(box, root, plan) {
      for (const el of root.querySelectorAll('.vx-fit-out')) el.classList.remove('vx-fit-out');
      const over = () => box.scrollHeight - box.clientHeight;
      for (const step of plan) {
        if (over() <= 0) return;
        if (step.rows) {
          this.fitRows(root, step, over);
          continue;
        }
        for (const el of root.querySelectorAll(step.hide)) {
          if (over() <= 0) return;
          const before = over();
          el.classList.add('vx-fit-out');
          if (over() >= before) el.classList.remove('vx-fit-out');
        }
      }
    }

    // Lets a list's last row go (the items sharing the lowest top) while the
    // box runs over and more than `keep` items would stay. A heading goes
    // with the last item under it.
    fitRows(root, step, over) {
      const keep = step.keep || 0;
      const isHead = (el) => !!(step.head && el.matches(step.head));
      const live = () => Array.prototype.filter.call(root.querySelectorAll(step.rows),
        (el) => !el.classList.contains('vx-fit-out') && el.getClientRects().length > 0);
      const topOf = (el) => Math.round(el.getBoundingClientRect().top);
      for (;;) {
        if (over() <= 0) return;
        const items = live().filter((el) => !isHead(el));
        if (!items.length) return;
        const top = Math.max(...items.map(topOf));
        const row = items.filter((el) => topOf(el) === top);
        if (items.length - row.length < keep) return;
        const before = over();
        const gone = row.slice();
        row.forEach((el) => el.classList.add('vx-fit-out'));
        const left = live();
        left.forEach((el, i) => {
          if (isHead(el) && (i === left.length - 1 || isHead(left[i + 1]))) { el.classList.add('vx-fit-out'); gone.push(el); }
        });
        if (over() >= before) {
          gone.forEach((el) => el.classList.remove('vx-fit-out'));
          return;
        }
      }
    }

    renderSound() {
      const on = this.settings.sounds;
      if (this.soundBtn) {
        this.soundBtn.setAttribute('aria-pressed', String(on));
        this.soundBtn.classList.toggle('is-off', !on);
      }
      if (this.settingsUi && this.settingsUi.toggles.sounds) this.settingsUi.toggles.sounds.checked = on;
    }

    cue(kind) {
      if (this.settings.sounds) Cues.play(kind);
    }

    announce(text) {
      this.status.textContent = '';
      this.clock.after(30, () => { this.status.textContent = text; }, 'sr');
    }

    emit(name, detail) {
      try {
        document.dispatchEvent(new CustomEvent(name, { detail }));
      } catch (_) {
        // An old browser without CustomEvent: nothing follows along.
      }
    }

    // --- Settings ---------------------------------------------------------------

    openSettings(cat, opener) {
      if (!this.appRoot) return;
      const st2 = this.settingsUi;
      this.settingsOpener = opener || this.settingsBtn;
      this.settingsOpen = true;
      st2.layer.hidden = false;
      this.settingsBtn.setAttribute('aria-expanded', 'true');
      this.appRoot.classList.add('vx-settings-open');
      this.renderSettings();
      this.showSettingsCat(cat || this.settingsCat, true);
    }

    closeSettings() {
      if (!this.settingsOpen) return;
      this.settingsOpen = false;
      this.settingsUi.layer.hidden = true;
      this.settingsBtn.setAttribute('aria-expanded', 'false');
      this.appRoot.classList.remove('vx-settings-open');
      if (this.settingsOpener) this.settingsOpener.focus({ preventScroll: true });
    }

    showSettingsCat(id, focus) {
      const st2 = this.settingsUi;
      this.settingsCat = id;
      for (const key of Object.keys(st2.cats)) {
        const on = key === id;
        st2.cats[key].setAttribute('aria-selected', String(on));
        st2.cats[key].classList.toggle('is-active', on);
        setTabbable(st2.cats[key], on);
        st2.panels[key].hidden = !on;
      }
      this.fit();
      if (focus) st2.cats[id].focus({ preventScroll: true });
    }

    onSettingsCatKey(e, order) {
      const keys = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(e.key)) return;
      e.preventDefault();
      let index = order.indexOf(this.settingsCat);
      if (e.key === 'Home') index = 0;
      else if (e.key === 'End') index = order.length - 1;
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') index = (index + 1) % order.length;
      else index = (index - 1 + order.length) % order.length;
      this.showSettingsCat(order[index], true);
    }

    // Escape closes; Tab stays inside the dialog while it is open.
    onSettingsKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeSettings();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = Array.from(this.settingsUi.dialog.querySelectorAll('button, input, select, summary, [tabindex="0"]'))
        .filter((el) => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    renderSettings() {
      if (!this.settingsUi) return;
      const st2 = this.settingsUi;
      const set = this.settings;
      for (const key of Object.keys(st2.toggles)) st2.toggles[key].checked = !!set[key];
      for (const key of ['mode', 'speed']) {
        const group = st2['seg-' + key];
        if (!group) continue;
        for (const btn of group.children) {
          const on = btn.getAttribute('data-value') === set[key];
          btn.setAttribute('aria-checked', String(on));
          btn.setAttribute('aria-pressed', String(on));
          btn.tabIndex = on ? 0 : -1;
        }
      }
      st2.modeHint.textContent = set.mode === 'ptt' ? 'Hold the keys while you talk, let go to finish.' : 'Press once to start, again to stop.';
      st2.mic.selectedIndex = set.mic;
      for (const id of Object.keys(st2.listen)) {
        st2.listen[id].setAttribute('aria-checked', String(set.listen === id));
        st2.listen[id].tabIndex = set.listen === id ? 0 : -1;
      }
      const hours = Math.floor(Math.floor(this.credits) / 60);
      st2.cloudLine.textContent = 'About ' + hours + ' hours of cloud left this month.';
      st2.billingLeft.textContent = num(this.credits) + ' of ' + num(this.creditsCap) + ' cloud credits left this month.';
      this.renderModels();
      for (const id of Object.keys(st2.theme)) {
        st2.theme[id].setAttribute('aria-checked', String(set.theme === id));
        st2.theme[id].tabIndex = set.theme === id ? 0 : -1;
      }
      st2.themeNote.textContent = set.theme === 'white' ? 'White turns the content light and keeps the dark frame. This preview stays in Voxden.' : '';
      st2.themeNote.hidden = set.theme !== 'white';
      for (const id of Object.keys(st2.flowStyle)) {
        st2.flowStyle[id].setAttribute('aria-checked', String(set.flowStyle === id));
        st2.flowStyle[id].tabIndex = set.flowStyle === id ? 0 : -1;
      }
      st2.styleNote.textContent = set.flowStyle === 'orb' ? 'Orb is picked for your next dictation in the app. This page keeps showing Island.' : '';
      st2.styleNote.hidden = set.flowStyle !== 'orb';
      st2.motion.value = set.flowMotion;
      st2.updateNote.textContent = set.updateNote || 'Voxden checks for updates in the background.';
      this.renderSound();
      this.fit();
    }

    renderModels() {
      const st2 = this.settingsUi;
      const set = this.settings;
      empty(st2.models);
      for (const model of MODELS) {
        const installed = !!set.installed[model.id];
        const inUse = set.model === model.id;
        const loading = set.downloading === model.id;
        let action = null;
        if (inUse) action = h('span', { class: 'vx-model-state', text: 'In use' });
        else if (loading) action = h('span', { class: 'vx-model-state', text: 'Downloading ' + Math.round(set.progress) + '%' });
        else {
          action = h('button', {
            type: 'button',
            class: 'vx-btn-secondary',
            disabled: !!set.downloading,
            text: installed ? 'Use' : 'Download and use',
            'aria-label': (installed ? 'Use ' : 'Download and use ') + model.name,
            on: { click: () => this.useModel(model.id) },
          });
        }
        st2.models.appendChild(h('li', { class: 'vx-model' + (inUse ? ' is-in-use' : '') }, [
          h('div', { class: 'vx-model-copy' }, [
            h('span', { class: 'vx-model-name' }, [model.name, model.tag ? h('span', { class: 'vx-model-tag', text: model.tag }) : null]),
            h('span', { class: 'vx-model-line', text: model.line }),
            loading ? h('span', { class: 'vx-model-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(set.progress)), 'aria-label': 'Downloading ' + model.name }, h('i', { style: { width: set.progress + '%' } })) : null,
          ]),
          h('span', { class: 'vx-model-size', text: model.size }),
          h('div', { class: 'vx-model-action' }, action),
        ]));
      }
    }

    // A model already on this PC switches at once; another downloads first
    // (simulated: nothing is fetched).
    useModel(id) {
      const set = this.settings;
      if (set.downloading) return;
      if (set.installed[id]) {
        set.model = id;
        this.renderSettings();
        this.announce(MODELS.find((m) => m.id === id).name + ' is in use.');
        return;
      }
      set.downloading = id;
      set.progress = 0;
      this.renderModels();
      const step = () => {
        set.progress = Math.min(100, set.progress + 7 + seeded(set.progress + 1) * 9);
        if (set.progress >= 100) {
          set.installed[id] = true;
          set.downloading = '';
          set.model = id;
          this.renderSettings();
          this.announce(MODELS.find((m) => m.id === id).name + ' downloaded and in use.');
          return;
        }
        this.renderModels();
        this.clock.after(90, step, 'settings');
      };
      this.clock.after(90, step, 'settings');
    }

    checkUpdates() {
      const st2 = this.settingsUi;
      st2.updateBtn.disabled = true;
      this.settings.updateNote = 'Checking…';
      this.renderSettings();
      this.clock.after(900, () => {
        st2.updateBtn.disabled = false;
        this.settings.updateNote = 'You have the latest version.';
        this.renderSettings();
      }, 'settings');
    }

    applyFlowMotion() {
      if (this.dictRoot) this.dictRoot.classList.toggle('vx-flow-reduced', this.flowReduced());
      if (this.wave) {
        if (this.flowReduced()) this.paintStaticWave();
        else this.clock.onFrame(this.onWaveFrame);
      }
    }

    // --- Rendering ------------------------------------------------------------

    renderAll() {
      this.renderCredits();
      this.renderHome();
      this.renderDictionary();
      this.renderStyle();
      this.renderPolishPage();
      this.renderInsights();
      this.renderSettings();
      this.renderSound();
      this.applyFlowMotion();
      if (this.appRoot) this.showPage('home', false);
    }

    allWords() {
      return INSIGHT_RANGES.all.words + this.extra.words;
    }

    renderCredits() {
      if (!this.appRoot) return;
      const left = Math.max(0, this.credits);
      const minutes = Math.floor(left);
      const figure = minutes >= 60 ? Math.floor(minutes / 60) + ' h' : minutes + ' min';
      const pct = Math.max(0, Math.min(100, (left / this.creditsCap) * 100));
      this.credit.count.textContent = figure;
      this.credit.detail.textContent = num(left) + ' of ' + num(this.creditsCap) + ' credits';
      this.credit.fill.style.width = pct.toFixed(1) + '%';
      this.credit.mini.textContent = minutes >= 60 ? Math.floor(minutes / 60) + 'h left' : minutes + 'm left';
      this.credit.miniFill.style.width = pct.toFixed(1) + '%';
      this.credit.box.setAttribute('aria-label', 'About ' + Math.floor(minutes / 60) + ' hours of cloud dictation left, '
        + num(left) + ' of ' + num(this.creditsCap) + ' credits');
      const exact = Math.floor(left * 100) / 100;
      this.polishUi.balance.textContent = exact.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' credits left';
      if (this.settingsUi && this.settingsUi.cloudLine) this.renderSettings();
    }

    weekValues() {
      const today = (this.now.getDay() + 6) % 7;
      return WEEK_WORDS.map((value, index) => {
        if (index < today) return value;
        if (index > today) return 0;
        return Math.round(value * 0.55) + this.extra.words;
      });
    }

    profileState() {
      const words = this.allWords();
      let index = 0;
      PROFILES.forEach((profile, i) => { if (words >= profile.words) index = i; });
      const current = PROFILES[index];
      const next = PROFILES[index + 1];
      const pct = next ? Math.floor(((words - current.words) / (next.words - current.words)) * 100) : 100;
      return { index, current, next, pct, words };
    }

    renderHome() {
      if (!this.appRoot) return;
      const home = this.home;
      const values = this.weekValues();
      const total = values.reduce((sum, v) => sum + v, 0);
      home.weekNum.textContent = num(total);
      const max = Math.max(1, ...values);
      empty(home.weekBars);
      const letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
      values.forEach((value, index) => {
        home.weekBars.appendChild(h('span', { class: 'vx-week-day' + (value ? '' : ' is-empty') }, [
          h('span', { class: 'vx-week-slot' }, h('i', { style: { height: value ? Math.max(5, Math.round((value / max) * 34)) + 'px' : '3px' } })),
          h('span', { class: 'vx-week-dow', text: letters[index] }),
        ]));
      });
      home.allWords.textContent = num(this.allWords());
      home.allDictations.textContent = num(INSIGHT_RANGES.all.dictations + this.extra.dictations);
      home.savedNum.textContent = num(this.minutesSaved(this.allWords()));
      const profile = this.profileState();
      const circ = 2 * Math.PI * 43;
      home.ringFill.setAttribute('stroke-dasharray', circ.toFixed(2));
      home.ringFill.setAttribute('stroke-dashoffset', (circ * (1 - profile.pct / 100)).toFixed(2));
      home.ringPct.textContent = profile.pct + '%';
      home.profile.textContent = profile.current.name;
      home.profileMeta.textContent = profile.next ? num(profile.next.words - profile.words) + ' words until ' + profile.next.name : 'Expert profile active';
      home.voiceCard.setAttribute('aria-label', 'Voice profile ' + profile.current.name + ', ' + profile.pct + ' percent. Open Your voice insights');
      this.renderFeed();
    }

    minutesSaved(words) {
      return words * (1 / TYPING_WPM - 1 / PACE_WPM);
    }

    renderFeed(newId) {
      if (!this.appRoot) return;
      const feed = this.home.feed;
      empty(feed);
      const today = new Date();
      const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      let lastLabel = '';
      for (const entry of this.history) {
        const label = sameDay(entry.at, today) ? 'Today' : sameDay(entry.at, yesterday) ? 'Yesterday'
          : entry.at.toLocaleDateString('en-US', { weekday: 'long' });
        if (label !== lastLabel) {
          feed.appendChild(h('p', { class: 'vx-day', text: label }));
          lastLabel = label;
        }
        const card = h('div', { class: 'vx-card' + (entry.id === newId ? ' is-new' : '') }, [
          h('p', { class: 'vx-card-meta' }, [
            h('span', { class: 'vx-card-time', text: clock12(entry.at) }),
            h('span', { class: 'vx-card-app', text: entry.app }),
          ]),
          h('p', { class: 'vx-card-text', text: entry.text }),
        ]);
        if (entry.polished) {
          const words = { polish: 'Polished', grammar: 'Grammar fixed', tighten: 'Tightened' }[entry.polished.mode] || 'Polished';
          card.appendChild(h('div', { class: 'vx-card-polished', role: 'group', 'aria-label': words + ' version' }, [
            icon('polishedArrow', 22, 'vx-card-polished-arrow'),
            h('div', { class: 'vx-card-polished-panel' + (entry.id === newId ? ' is-new' : '') }, [
              h('span', { class: 'vx-card-polished-label' }, [icon('sparkle', 10), words]),
              h('p', { class: 'vx-card-polished-text', text: entry.polished.text }),
            ]),
          ]));
        }
        feed.appendChild(card);
        if (entry.id === newId) this.clock.after(1600, () => card.classList.remove('is-new'), 'fx');
      }
      this.fit();
    }

    renderDictionary() {
      if (!this.appRoot) return;
      const d = this.dict;
      const learned = this.dictionary.filter((e) => e.kind === 'learned').length;
      d.total.textContent = String(this.dictionary.length);
      d.learned.textContent = String(learned);
      for (const id of Object.keys(d.filters)) d.filters[id].setAttribute('aria-pressed', String(id === this.dictFilter));
      empty(d.list);
      const rows = this.dictionary.filter((e) => this.dictFilter === 'all' || e.kind === this.dictFilter
        || (this.dictFilter === 'added' && e.kind === 'yours'));
      for (const entry of rows) {
        const row = h('div', { class: 'vx-row' + (entry.kind === 'learned' ? ' is-learned' : '') + (entry.fresh ? ' is-new' : ''), role: 'listitem' });
        if (entry.from) {
          row.appendChild(h('span', { class: 'vx-row-from', text: entry.from }));
          row.appendChild(h('span', { class: 'vx-row-arrow', 'aria-label': 'becomes', text: '→' }));
          row.appendChild(h('span', { class: 'vx-row-to' }, [entry.term, h('span', { class: 'vx-row-star', title: 'Learned from your edits' }, icon('star', 11))]));
        } else {
          row.appendChild(h('span', { class: 'vx-row-term', text: entry.term }));
        }
        if (entry.kind === 'yours') {
          row.appendChild(h('span', { class: 'vx-row-tag', text: 'Just added' }));
          row.appendChild(h('button', {
            type: 'button',
            class: 'vx-row-del',
            'aria-label': 'Remove ' + entry.term,
            title: 'Remove',
            on: { click: () => this.removeWord(entry) },
          }, icon('trash', 14)));
        }
        d.list.appendChild(row);
      }
      if (!rows.length) d.list.appendChild(h('p', { class: 'vx-dict-empty', text: 'No words here yet.' }));
      if (this.ins) this.ins.taughtDict.textContent = String(this.dictionary.length);
      this.fit();
    }

    toggleAddWord(open) {
      const d = this.dict;
      d.form.hidden = !open;
      d.addBtn.setAttribute('aria-expanded', String(open));
      this.fit();
      if (open) {
        d.msg.textContent = '';
        d.input.value = '';
        d.input.focus({ preventScroll: false });
      } else {
        d.addBtn.focus({ preventScroll: true });
      }
    }

    addWord() {
      const d = this.dict;
      const word = d.input.value.replace(/\s+/g, ' ').trim();
      if (!word) {
        d.msg.textContent = 'Type a word or a name first.';
        return;
      }
      if (!/[\p{L}\p{N}]/u.test(word)) {
        d.msg.textContent = 'A word needs at least one letter or number.';
        return;
      }
      const exists = this.dictionary.some((e) => e.term.toLowerCase() === word.toLowerCase() && !e.from);
      if (exists) {
        d.msg.textContent = '“' + word + '” is already in your dictionary.';
        return;
      }
      for (const entry of this.dictionary) entry.fresh = false;
      this.dictionary.unshift({ term: word, kind: 'yours', fresh: true });
      if (this.dictFilter === 'learned') this.dictFilter = 'all';
      this.renderDictionary();
      d.form.hidden = true;
      d.addBtn.setAttribute('aria-expanded', 'false');
      d.msg.textContent = 'Added “' + word + '”. Voxden will spell it your way. This demo keeps it until you leave the page.';
      d.addBtn.focus({ preventScroll: true });
    }

    removeWord(entry) {
      this.dictionary = this.dictionary.filter((e) => e !== entry);
      this.renderDictionary();
      this.dict.msg.textContent = 'Removed “' + entry.term + '”.';
      this.dict.addBtn.focus({ preventScroll: true });
    }

    renderStyle() {
      if (!this.appRoot) return;
      const w = this.styleUi;
      const ctx = this.styleContext;
      const tone = this.styles[ctx];
      for (const id of Object.keys(w.ctx)) {
        w.ctx[id].setAttribute('aria-pressed', String(id === ctx));
        w.ctx[id].classList.toggle('is-active', id === ctx);
      }
      for (const id of Object.keys(w.tones)) w.tones[id].setAttribute('aria-pressed', String(id === tone));
      const info = TONES.find((t) => t.id === tone);
      const context = CONTEXTS.find((c) => c.id === ctx);
      w.ctxHint.textContent = context.hint;
      w.card.setAttribute('data-tone', tone);
      w.toneName.textContent = info.name;
      w.caption.textContent = info.caption;
      const text = styleText(PREVIEW_SAID, tone);
      if (w.output.textContent !== text) {
        const first = !w.output.textContent;
        w.output.textContent = text;
        if (!first && !this.reduced && w.output.animate) {
          w.output.animate([{ opacity: 0.3, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
        }
      }
      this.fit();
    }

    pickTone(tone) {
      this.styles[this.styleContext] = tone;
      this.renderStyle();
    }

    polishSources() {
      return this.history.filter((entry) => wordCount(entry.text) >= 3).slice(0, 3);
    }

    renderPolishPage() {
      if (!this.appRoot) return;
      const p = this.polishUi;
      const sources = this.polishSources();
      if (!sources.some((e) => e.id === this.polish.sourceId) && sources.length) {
        this.polish.sourceId = sources[0].id;
        this.polish.result = null;
      }
      empty(p.recents);
      for (const entry of sources) {
        p.recents.appendChild(h('button', {
          type: 'button',
          class: 'vx-recent',
          'aria-pressed': String(entry.id === this.polish.sourceId),
          title: entry.text,
          on: { click: () => this.pickPolishSource(entry.id) },
        }, [
          h('span', { class: 'vx-recent-app', text: entry.app }),
          h('span', { class: 'vx-recent-text', text: entry.text }),
        ]));
      }
      const source = this.polishSource();
      p.draft.textContent = source ? source.text : '';
      const words = source ? wordCount(source.text) : 0;
      p.words.textContent = words === 1 ? '1 word' : words + ' words';
      this.renderPolishButtons();
      this.renderPolishResult();
    }

    polishSource() {
      return this.history.find((e) => e.id === this.polish.sourceId) || null;
    }

    pickPolishSource(id) {
      if (this.polish.busy) return;
      this.polish.sourceId = id;
      this.polish.result = null;
      this.polish.showChanges = false;
      this.renderPolishPage();
    }

    renderPolishButtons() {
      const p = this.polishUi;
      const busy = this.polish.busy;
      const labels = { polish: ['Polish', 'Polishing…'], grammar: ['Grammar', 'Checking…'], tighten: ['Tighten', 'Tightening…'] };
      for (const id of Object.keys(p.modes)) {
        const btn = p.modes[id];
        btn.disabled = !!busy || !this.polishSource();
        btn.classList.toggle('is-running', busy === id);
        const label = id === 'polish' ? p.runLabel : btn.querySelector('.vx-mode-label');
        label.textContent = labels[id][busy === id ? 1 : 0];
        if (id !== 'polish') btn.title = '0.25 credits, the same as Polish';
      }
    }

    renderPolishResult() {
      const p = this.polishUi;
      const result = this.polish.result;
      const titles = { polish: 'Polished', grammar: 'Grammar fixed', tighten: 'Tightened' };
      p.title.textContent = titles[result ? result.mode : 'polish'];
      p.changes.hidden = !result;
      p.copy.hidden = !result;
      p.changes.setAttribute('aria-pressed', String(!!(result && this.polish.showChanges)));
      empty(p.output);
      p.output.classList.toggle('is-empty', !result);
      if (!result) {
        p.output.appendChild(h('span', { class: 'vx-note-empty', text: 'Your polished words will appear here.' }));
        p.status.textContent = '';
        this.fit();
        return;
      }
      if (this.polish.showChanges) {
        diffWords(result.before, result.after).forEach((part, index) => {
          if (index) p.output.appendChild(document.createTextNode(' '));
          if (part[0] === 'same') p.output.appendChild(document.createTextNode(part[1]));
          else p.output.appendChild(h(part[0], { text: part[1] }));
        });
      } else {
        p.output.textContent = result.after;
      }
      p.status.textContent = 'Used ' + POLISH_CREDITS + ' credits · saved to this dictation';
      this.fit();
    }

    runPagePolish(mode) {
      const source = this.polishSource();
      if (!source || this.polish.busy) return;
      this.polish.busy = mode;
      this.polish.result = null;
      this.polishUi.output.classList.add('is-busy');
      this.renderPolishButtons();
      this.announce({ polish: 'Polishing', grammar: 'Checking grammar', tighten: 'Tightening' }[mode]);
      this.clock.after(PAGE_POLISH_MS, () => {
        this.polish.busy = '';
        this.polishUi.output.classList.remove('is-busy');
        const after = source.rewrites[mode];
        this.polish.result = { mode, before: source.text, after, entryId: source.id };
        source.polished = { text: after, mode };
        this.spend(POLISH_CREDITS);
        this.renderPolishButtons();
        this.renderPolishResult();
        this.renderFeed();
        if (!this.reduced && this.polishUi.output.animate) {
          this.polishUi.output.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
      }, 'page');
    }

    copyPolished() {
      const result = this.polish.result;
      const btn = this.polishUi.copy;
      if (!result) return;
      const done = (ok) => {
        btn.textContent = ok ? 'Copied' : 'Copy failed';
        btn.classList.toggle('is-done', ok);
        this.clock.after(1400, () => { btn.textContent = 'Copy'; btn.classList.remove('is-done'); }, 'fx');
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(result.after).then(() => done(true), () => done(false));
        } else done(false);
      } catch (_) {
        done(false);
      }
    }

    spend(amount) {
      this.credits = Math.max(0, Math.round((this.credits - amount) * 1000) / 1000);
      this.renderCredits();
    }

    renderInsights() {
      if (!this.appRoot) return;
      const n = this.ins;
      const range = INSIGHT_RANGES[this.insightsRange];
      for (const id of Object.keys(n.ranges)) {
        n.ranges[id].setAttribute('aria-pressed', String(id === this.insightsRange));
        n.ranges[id].classList.toggle('is-active', id === this.insightsRange);
      }
      for (const id of Object.keys(n.tabs)) {
        const on = id === this.insightsTab;
        n.tabs[id].setAttribute('aria-selected', String(on));
        n.tabs[id].classList.toggle('is-active', on);
        setTabbable(n.tabs[id], on);
        n.panels[id].hidden = !on;
      }
      const words = range.words + this.extra.words;
      const dictations = range.dictations + this.extra.dictations;
      n.words.textContent = num(words);
      n.dictations.textContent = num(dictations);
      n.sub.textContent = num(dictations) + ' dictations · ' + num(words) + ' words ' + range.span;

      // Milestones: this year's words.
      const year = this.allWords();
      let reached = -1;
      MILESTONES.forEach((m, i) => { if (year >= m.words) reached = i; });
      const next = MILESTONES[reached + 1];
      const prev = reached >= 0 ? MILESTONES[reached] : null;
      empty(n.books);
      MILESTONES.forEach((m, i) => {
        const cls = i <= reached ? 'is-reached' : i === reached + 1 ? 'is-next' : i === reached + 2 ? 'is-after-next' : '';
        n.books.appendChild(h('i', { class: 'vx-book ' + cls, style: { height: (46 + i * 6) + 'px' } }));
      });
      n.shelfCaption.textContent = next ? next.name + ' · next · ' + num(next.words - year) + ' words to go' : 'Every milestone reached';
      n.msTitle.textContent = prev ? 'You’ve written ' + prev.label + ' this year' : 'Your first milestone is a page away';
      n.msCopy.textContent = num(year) + ' words across ' + num(INSIGHT_RANGES.all.dictations + this.extra.dictations) + ' dictations this year.';
      const from = prev ? prev.words : 0;
      const pct = next ? Math.max(0, Math.min(100, ((year - from) / (next.words - from)) * 100)) : 100;
      n.msFill.style.width = pct.toFixed(1) + '%';
      n.msNext.textContent = next ? num(next.words - year) + ' words to ' + next.label : '';
      empty(n.msStrip);
      MILESTONES.forEach((m, i) => {
        const state = i <= reached ? 'is-reached' : i === reached + 1 ? 'is-next' : 'is-locked';
        const when = i <= reached ? shortDate(daysAgo(this.now, m.daysAgo || 0)) : i === reached + 1 ? 'Next' : num(m.words) + ' words';
        n.msStrip.appendChild(h('li', { class: 'vx-ms-step ' + state }, [h('span', { class: 'vx-ms-dot', 'aria-hidden': 'true' }), h('b', { text: m.name }), h('small', { text: when })]));
      });

      // Pace, time saved, fixes.
      const mult = PACE_WPM / TYPING_WPM;
      n.gaugeFill.setAttribute('stroke-dashoffset', (n.arcLen * (1 - Math.min(1, mult / 5))).toFixed(1));
      n.paceFoot.textContent = 'From ' + num(words) + ' timed words, against 40 WPM typing.';
      const saved = this.minutesSaved(words);
      n.saved.textContent = saved >= 60 ? Math.floor(saved / 60) + ' h ' + Math.round(saved % 60) + ' min' : num(saved) + ' min';
      n.savedLine.textContent = 'That’s about ' + Math.max(1, Math.round(saved / 4)) + ' coffee breaks, back in your day.';
      const style = BASE_FIXES.style + this.extra.style;
      const dict = BASE_FIXES.dictionary + this.extra.dictionary;
      n.fixTotal.textContent = num(style + dict);
      n.fixStyle.textContent = num(style);
      n.fixDict.textContent = num(dict);

      // Where you dictate.
      empty(n.lb);
      WHERE.forEach((app, i) => {
        const appWords = Math.round(words * app.share);
        n.lb.appendChild(h('li', { class: 'vx-lb-row', 'data-rank': String(i + 1) }, [
          h('span', { class: 'vx-lb-rank', text: String(i + 1) }),
          h('span', { class: 'vx-lb-main' }, [
            h('span', { class: 'vx-lb-name' }, [h('b', { text: app.app }), h('span', { class: 'vx-lb-tag', text: app.tag })]),
            h('span', { class: 'vx-lb-track', 'aria-hidden': 'true' }, h('i', { style: { width: Math.round((app.share / WHERE[0].share) * 100) + '%' } })),
          ]),
          h('span', { class: 'vx-lb-words' }, [h('b', { text: num(appWords) }), ' words']),
          h('span', { class: 'vx-lb-trend' + (app.trend ? ' is-up' : ''), 'aria-hidden': 'true' }, app.trend ? icon('trendUp', 13) : null),
        ]));
      });

      // Voice.
      const profile = this.profileState();
      n.profileName.textContent = profile.current.name;
      n.profileCopy.textContent = profile.index >= 1
        ? 'Voxden knows your names and the words you use most. Keep dictating and it gets sharper.'
        : 'Fix a misspelled word in a transcript. Voxden saves that spelling for next time.';
      n.profilePct.textContent = profile.pct + '%';
      n.profileFill.style.width = profile.pct + '%';
      n.profileMeta.textContent = profile.next ? num(profile.next.words - profile.words) + ' words until ' + profile.next.name : 'Expert profile active';
      n.profileWords.textContent = num(profile.words) + ' words analyzed';
      empty(n.ladder);
      PROFILES.forEach((p2, i) => {
        const cls = i < profile.index ? 'is-complete' : i === profile.index ? 'is-current' : '';
        n.ladder.appendChild(h('div', { class: 'vx-step ' + cls, role: 'listitem', 'aria-current': i === profile.index ? 'step' : null }, [
          h('span', { class: 'vx-step-marker', 'aria-hidden': 'true', text: i < profile.index ? '✓' : '' }),
          h('b', { text: p2.name }),
          h('small', { text: p2.words ? num(p2.words) + ' words' : 'Start' }),
        ]));
      });
      empty(n.cloud);
      const top = TOP_WORDS[0][1];
      TOP_WORDS.forEach((pair) => {
        const weight = pair[1] / top;
        n.cloud.appendChild(h('span', { class: 'vx-cloud-word', style: { 'font-size': (12 + weight * 11).toFixed(1) + 'px', opacity: (0.55 + weight * 0.45).toFixed(2) } }, [
          pair[0], h('small', { text: String(pair[1]) }),
        ]));
      });
      n.taughtDict.textContent = String(this.dictionary.length);
      this.fit();
    }

    // --- The chat the words land in ---------------------------------------------

    renderScenario() {
      if (!this.dictRoot && !this.target) return;
      const sc = SCENARIOS[this.scenarioIndex];
      const t = this.target;
      this.chips.forEach((chip, index) => chip.setAttribute('aria-pressed', String(index === this.scenarioIndex)));
      this.targetWin.setAttribute('data-app', sc.app);
      t.chat.hidden = sc.app !== 'chat';
      t.mail.hidden = sc.app !== 'mail';
      if (sc.app === 'mail') {
        this.targetWin.setAttribute('aria-label', 'Mail: reply to Daniel Brooks');
      } else {
        const channel = sc.view === 'channel';
        this.targetWin.setAttribute('aria-label', channel ? 'Team chat: #launch' : 'Team chat: Rohan Mehta');
        this.renderChatHead(channel);
        this.renderMessages();
        t.chatComposer.placeholder.textContent = channel ? 'Message #launch' : 'Message Rohan Mehta';
        t.chatComposer.text.setAttribute('aria-label', channel ? 'Message to #launch' : 'Message to Rohan Mehta');
      }
      t.mailComposer.text.setAttribute('aria-label', 'Email to Daniel Brooks');
      this.resetComposer();
    }

    renderChatHead(channel) {
      const head = this.target.head;
      empty(head);
      if (channel) {
        head.appendChild(h('span', { class: 'vx-chat-title' }, [icon('hash', 14), h('span', { class: 'vx-chat-name', text: 'launch' })]));
        head.appendChild(h('span', { class: 'vx-chat-meta', text: '8 members' }));
      } else {
        head.appendChild(h('span', { class: 'vx-chat-title' }, [
          h('span', { class: 'vx-msg-av vx-av-rm vx-av-sm', 'aria-hidden': 'true', text: 'RM' }),
          h('span', { class: 'vx-chat-name', text: 'Rohan Mehta' }),
          h('span', { class: 'vx-presence', 'aria-hidden': 'true' }),
        ]));
        head.appendChild(h('span', { class: 'vx-chat-meta', text: 'Active now' }));
      }
      head.appendChild(h('span', { class: 'vx-chat-tools', 'aria-hidden': 'true' }, [icon('search', 14), icon('more', 14)]));
    }

    renderMessages() {
      const sc = SCENARIOS[this.scenarioIndex];
      const msgs = this.target.msgs;
      empty(msgs);
      const now = this.now;
      const base = sc.view === 'channel' ? [
        { who: 'Maya Chen', av: 'MC', cls: 'mc', at: minutesAgo(now, 22), text: 'Release notes draft is in the doc. Comments welcome before lunch.' },
        { who: 'Priya Nair', av: 'PN', cls: 'pn', at: minutesAgo(now, 6), text: 'Morning! Are we still on track for Thursday’s beta?' },
      ] : [
        { who: 'Rohan Mehta', av: 'RM', cls: 'rm', at: minutesAgo(now, 4), text: 'Kal ki client meeting kitne baje rakhein?' },
      ];
      msgs.appendChild(sc.view === 'channel'
        ? h('div', { class: 'vx-chat-intro' }, [
          h('span', { class: 'vx-chat-intro-mark', 'aria-hidden': 'true' }, icon('hash', 18)),
          h('p', { class: 'vx-chat-intro-name', text: 'launch' }),
          h('p', { class: 'vx-chat-intro-copy', text: 'Everything for Thursday’s beta: owners, dates and anything blocking.' }),
        ])
        : h('div', { class: 'vx-chat-intro' }, [
          h('span', { class: 'vx-chat-intro-mark vx-av-rm', 'aria-hidden': 'true', text: 'RM' }),
          h('p', { class: 'vx-chat-intro-name', text: 'Rohan Mehta' }),
          h('p', { class: 'vx-chat-intro-copy', text: 'This is the start of your messages with Rohan.' }),
        ]));
      msgs.appendChild(h('p', { class: 'vx-chat-day' }, h('span', { text: 'Today' })));
      for (const msg of base.concat(this.sent[sc.view] || [])) {
        msgs.appendChild(h('div', { class: 'vx-msg' + (msg.fresh ? ' is-new' : '') }, [
          h('span', { class: 'vx-msg-av vx-av-' + msg.cls, 'aria-hidden': 'true', text: msg.av }),
          h('div', { class: 'vx-msg-body' }, [
            h('p', { class: 'vx-msg-top' }, [h('span', { class: 'vx-msg-name', text: msg.who }), h('span', { class: 'vx-msg-time', text: clock12(msg.at) })]),
            h('p', { class: 'vx-msg-text', text: msg.text }),
          ]),
        ]));
        msg.fresh = false;
      }
    }

    composer() {
      const sc = SCENARIOS[this.scenarioIndex];
      return sc.app === 'mail' ? this.target.mailComposer : this.target.chatComposer;
    }

    resetComposer() {
      for (const c of [this.target.chatComposer, this.target.mailComposer]) {
        empty(c.typed);
        c.text.classList.remove('has-text');
        if (c.send) c.send.disabled = true;
      }
      this.target.mailSend.disabled = true;
    }

    paste(text) {
      const c = this.composer();
      empty(c.typed);
      const span = h('span', { class: 'vx-paste is-flash', text });
      c.typed.appendChild(span);
      c.text.classList.add('has-text');
      if (c.send) c.send.disabled = false;
      if (c.kind === 'mail') this.target.mailSend.disabled = false;
      this.flash(span);
      return span;
    }

    // A highlight that fades after the words land. A second one on the same
    // words (Polish replacing them) takes over from the first.
    flash(span) {
      const token = (span.vxFlash || 0) + 1;
      span.vxFlash = token;
      this.clock.after(60, () => { if (span.vxFlash === token) span.classList.add('is-fading'); }, 'fx');
      this.clock.after(1500, () => {
        if (span.vxFlash === token) span.classList.remove('is-flash', 'is-fading', 'is-gold');
      }, 'fx');
    }

    sendMessage() {
      const sc = SCENARIOS[this.scenarioIndex];
      const c = this.composer();
      const text = c.typed.textContent.trim();
      if (!text) return;
      if (sc.app === 'mail') {
        const toast = this.target.mailToast;
        toast.textContent = 'Sent to Daniel Brooks';
        toast.classList.add('is-shown');
        this.clock.after(2200, () => {
          toast.classList.remove('is-shown');
          this.clock.after(200, () => { toast.textContent = ''; }, 'fx');
        }, 'fx');
      } else {
        this.sent[sc.view].push({ who: 'Alex', av: 'A', cls: 'me', at: new Date(), text, fresh: true });
        this.renderMessages();
      }
      this.resetComposer();
      this.announce(sc.app === 'mail' ? 'Email sent.' : 'Message sent.');
    }

    selectScenario(index) {
      if (index === this.scenarioIndex) return;
      this.abortRun();
      this.scenarioIndex = index;
      this.renderScenario();
    }

    // Everything between the engine and the paste, the way the app runs it:
    // dictionary spellings, then fillers out, then the writing style.
    compose(sc) {
      let text = sc.engine;
      let dictHits = 0;
      for (const entry of this.dictionary) {
        if (!entry.from) continue;
        const re = new RegExp('(^|[^\\p{L}\\p{N}])' + escapeRegExp(entry.from) + '(?=$|[^\\p{L}\\p{N}])', 'giu');
        text = text.replace(re, (match, lead) => { dictHits++; return lead + entry.term; });
      }
      const tone = this.styles[sc.context];
      const out = styleText(text, tone);
      const fillers = (sc.engine.match(new RegExp('(^|[^\\p{L}])' + FILLER_SRC + '(?=$|[^\\p{L}])', 'gu')) || []).length;
      return { text: out, tone, dictHits, fillers };
    }

    // --- The flow bar ---------------------------------------------------------

    onPillClick() {
      this.toggleDictation();
    }

    toggleDictation() {
      const mode = this.fb.mode;
      if (mode === 'transcribing') return;
      if (mode === 'arming' || mode === 'recording') this.stopDictation();
      else this.startDictation();
    }

    // A result that offers Polish stays while the pointer is on the bar, as in
    // the app, and while the keyboard is on the Polish button itself.
    onPillPointer(inside) {
      const fb = this.fb;
      fb.hover = inside;
      this.syncHold();
      if (fb.mode === 'idle') {
        this.clock.cancelGroup('hover');
        if (inside) this.syncBar();
        else this.clock.after(160, () => this.syncBar(), 'hover');
      }
    }

    onPolishFocus(inside) {
      this.fb.polishFocus = inside;
      this.syncHold();
    }

    syncHold() {
      const fb = this.fb;
      if (fb.mode !== 'success' || !fb.canPolish) return;
      if (fb.hover || fb.polishFocus) this.holdSuccess();
      else this.releaseSuccess();
    }

    holdSuccess() {
      this.fb.hold = true;
      this.clock.cancelGroup('bar');
    }

    releaseSuccess() {
      if (!this.fb.hold) return;
      this.fb.hold = false;
      this.armIdle(SUCCESS_RELEASE_MS);
    }

    armIdle(ms) {
      this.clock.cancelGroup('bar');
      if (this.fb.hold) return;
      this.clock.after(ms, () => this.toIdle(), 'bar');
    }

    toIdle() {
      this.fb.hold = false;
      this.setBar('idle');
    }

    setBar(mode, options) {
      const fb = this.fb;
      if (!fb.pill) return;
      const opts = options || {};
      const text = opts.text || '';
      const lineShown = !!text && (mode === 'success' || mode === 'cancel' || mode === 'error' || mode === 'transcribing');
      if (lineShown) this.setLine(text, fb.lineShown);
      if (mode === 'success') fb.mark.setAttribute('data-kind', 'check');
      else if (mode === 'cancel') fb.mark.setAttribute('data-kind', 'x');
      else if (mode === 'error') fb.mark.setAttribute('data-kind', 'bang');
      fb.mode = mode;
      fb.canPolish = mode === 'success' && !!opts.canPolish;
      fb.lineShown = lineShown;
      if (mode !== 'success') fb.hold = false;
      if (mode === 'success' && fb.canPolish && fb.hover) fb.hold = true;
      this.syncBar();
      const state = mode === 'arming' || mode === 'recording' ? 'recording'
        : mode === 'transcribing' ? 'transcribing' : mode === 'success' ? 'success' : 'idle';
      if (state !== this.lastState) {
        this.lastState = state;
        this.emit('voxden:dictation', { state });
      }
    }

    // The words in the capsule sit at their final width from the first frame;
    // only the room around them springs. A line replaced while on screen
    // fades out under a copy while the new one fades in.
    setLine(text, wasShown) {
      const fb = this.fb;
      if (fb.lineText === text && wasShown) return;
      if (wasShown && fb.lineText && !this.flowReduced()) {
        fb.twin.textContent = fb.lineText;
        fb.twin.style.left = fb.line.offsetLeft + 'px';
        fb.twin.style.width = fb.label.getBoundingClientRect().width + 'px';
        fb.twin.classList.remove('is-fading');
        void fb.twin.offsetWidth;
        fb.twin.classList.add('is-fading');
        fb.label.classList.remove('is-swapping');
        void fb.label.offsetWidth;
        fb.label.classList.add('is-swapping');
      }
      fb.lineText = text;
      fb.label.textContent = text;
      this.ruler.textContent = text;
      const width = Math.ceil(this.ruler.getBoundingClientRect().width) + 1;
      fb.pill.style.setProperty('--vx-line', width + 'px');
    }

    syncBar() {
      const fb = this.fb;
      if (!fb.pill) return;
      const mode = fb.mode;
      const idle = mode === 'idle';
      const alwaysOpen = this.compactDict || !this.canHover;
      const open = idle && (fb.hover || fb.focus || alwaysOpen);
      const classes = ['vx-pill', 'is-' + mode];
      if (idle) classes.push(open ? 'is-open' : 'is-rest');
      if (idle && !this.settings.alwaysFlow) classes.push('is-away');
      if (fb.lineShown && mode === 'transcribing') classes.push('has-line');
      if (fb.canPolish) classes.push('can-polish');
      fb.pill.className = classes.join(' ');

      const recording = mode === 'recording' || mode === 'arming';
      setTabbable(fb.cancel, mode === 'recording');
      setTabbable(fb.polishBtn, fb.canPolish);
      const labels = {
        idle: 'Start dictation',
        arming: 'Stop and transcribe',
        recording: 'Stop and transcribe',
        transcribing: fb.lineShown ? 'Polishing' : 'Transcribing',
        success: 'Start a new dictation',
        cancel: 'Start a new dictation',
        error: 'Start a new dictation',
      };
      fb.hit.setAttribute('aria-label', labels[mode]);
      fb.hit.setAttribute('aria-disabled', String(mode === 'transcribing'));
      fb.hit.title = recording ? 'Stop and transcribe' : mode === 'transcribing' ? '' : 'Dictate';
      this.dictRoot.classList.toggle('vx-is-running', !idle);

      const active = document.activeElement;
      if ((active === fb.cancel && mode !== 'recording') || (active === fb.polishBtn && !fb.canPolish)) {
        fb.hit.focus({ preventScroll: true });
      }
    }

    startDictation() {
      if (!this.dictRoot) return;
      const mode = this.fb.mode;
      if (mode === 'transcribing') return;
      if (mode === 'arming' || mode === 'recording') {
        this.stopDictation();
        return;
      }
      this.clock.cancelGroup('run');
      this.clock.cancelGroup('bar');
      this.clock.cancelGroup('hover');
      const sc = SCENARIOS[this.scenarioIndex];
      const gen = ++this.gen;
      this.cue('start');
      this.resetComposer();
      const plan = speechPlan(sc.spoken);
      this.run = { gen, sc, plan, shown: 0, stopped: false, t0: this.clock.now, entry: null, span: null };
      this.setBar('arming');
      this.showCaptions(true);
      this.startWave();
      this.startLevels();
      this.announce('Listening. Press Space or click the flow bar to stop.');
      this.clock.after(ARMING_MS, () => { if (gen === this.gen && this.fb.mode === 'arming') this.setBar('recording'); }, 'run');
      plan.words.forEach((word, index) => {
        this.clock.after(word.start, () => { if (gen === this.gen) this.showWord(index); }, 'run');
      });
      this.clock.after(plan.total, () => { if (gen === this.gen) this.stopDictation(); }, 'run');
    }

    stopDictation() {
      const run = this.run;
      const mode = this.fb.mode;
      if (!run || run.stopped || (mode !== 'recording' && mode !== 'arming')) return;
      run.stopped = true;
      this.clock.cancelGroup('run');
      for (let i = run.shown; i < run.plan.words.length; i++) this.showWord(i);
      this.stopWave();
      this.stopLevels();
      this.setBar('transcribing');
      this.announce('Transcribing');
      const gen = run.gen;
      this.clock.after(CAPTION_LINGER_MS, () => { if (gen === this.gen) this.showCaptions(false); }, 'run');
      this.clock.after(TRANSCRIBE_MS, () => { if (gen === this.gen) this.finishDictation(); }, 'run');
    }

    finishDictation() {
      const run = this.run;
      const sc = run.sc;
      const out = this.compose(sc);
      run.span = this.paste(out.text);
      const entry = {
        id: 'd' + run.gen,
        at: new Date(),
        app: sc.app === 'mail' ? 'Mail' : 'Team chat',
        text: out.text,
        rewrites: sc.rewrites,
        polished: null,
      };
      run.entry = entry;
      this.history.unshift(entry);
      this.extra.words += wordCount(out.text);
      this.extra.dictations += 1;
      this.extra.style += out.fillers;
      this.extra.dictionary += out.dictHits;
      this.spend(run.plan.total / 60000);
      this.renderHome();
      this.renderFeed(entry.id);
      this.renderInsights();
      this.renderPolishPage();
      this.setBar('success', { text: out.text, canPolish: true });
      this.cue('success');
      this.announce('Pasted into ' + entry.app + '. Polish it from the flow bar for 0.25 credits.');
      this.armIdle(SUCCESS_MS);
    }

    polishFromBar() {
      const run = this.run;
      if (this.fb.mode !== 'success' || !this.fb.canPolish || !run || !run.entry) return;
      this.clock.cancelGroup('bar');
      const gen = run.gen;
      this.setBar('transcribing', { text: 'Polishing…' });
      this.announce('Polishing');
      this.clock.after(POLISH_MS, () => {
        if (gen !== this.gen) return;
        const polished = run.sc.rewrites.polish;
        const span = run.span;
        const placed = !!(span && span.isConnected);
        if (placed) {
          span.textContent = polished;
          span.classList.remove('is-fading');
          span.classList.add('is-flash', 'is-gold');
          this.flash(span);
        }
        run.entry.polished = { text: polished, mode: 'polish' };
        this.spend(POLISH_CREDITS);
        this.renderFeed(run.entry.id);
        this.renderPolishPage();
        this.setBar('success', { text: placed ? polished : 'Polished. Paste it with Ctrl+V' });
        this.announce(placed ? 'Polished: ' + polished : 'Polished. The message was already sent, so the new version is ready to paste.');
        this.armIdle(placed ? POLISHED_MS : 4200);
      }, 'run');
    }

    cancelDictation() {
      const mode = this.fb.mode;
      if (mode !== 'recording' && mode !== 'arming') return;
      this.gen++;
      this.clock.cancelGroup('run');
      this.stopWave();
      this.stopLevels();
      this.showCaptions(false);
      this.setBar('cancel', { text: 'Cancelled' });
      this.announce('Cancelled');
      this.armIdle(CANCEL_MS);
    }

    // A scenario switch ends whatever was running, without a notice.
    abortRun() {
      this.gen++;
      this.clock.cancelGroup('run');
      this.clock.cancelGroup('bar');
      this.stopWave();
      this.stopLevels();
      this.showCaptions(false);
      if (this.fb.mode !== 'idle') this.setBar('idle');
    }

    showCaptions(on) {
      const fb = this.fb;
      if (on) empty(fb.captionText);
      fb.captions.classList.toggle('is-shown', on);
    }

    showWord(index) {
      const run = this.run;
      if (!run || index < run.shown) return;
      const word = run.plan.words[index];
      const fb = this.fb;
      if (index > 0) fb.captionText.appendChild(document.createTextNode(' '));
      fb.captionText.appendChild(h('span', { class: 'vx-cap-word' + (word.filler ? ' is-filler' : ''), text: word.text }));
      run.shown = index + 1;
      // Two lines show; the newest stay in view.
      fb.captionBox.scrollTop = fb.captionBox.scrollHeight;
    }

    // The voice level for anything that follows along, about 25 times a
    // second while recording, from the sample's own timing.
    startLevels() {
      this.clock.cancelGroup('level');
      this.level = 0;
      const step = () => {
        const run = this.run;
        const mode = this.fb.mode;
        if (!run || (mode !== 'recording' && mode !== 'arming')) return;
        const target = mode === 'recording' ? this.voiceAt(this.clock.now - run.t0) : 0;
        this.level += (target - this.level) * (target > this.level ? 0.55 : 0.35);
        this.emit('voxden:voice-level', { level: Math.round(Math.max(0, Math.min(1, this.level)) * 1000) / 1000 });
        this.clock.after(LEVEL_MS, step, 'level');
      };
      step();
    }

    stopLevels() {
      this.clock.cancelGroup('level');
      if (this.level) {
        this.level = 0;
        this.emit('voxden:voice-level', { level: 0 });
      }
    }

    // The meter follows the real one (src/overlay.js updateWave): two crests
    // that travel, a shallow base while listening, voice adding range and
    // pace. The voice here is the sample's own timing.
    startWave() {
      this.stopWave();
      this.wave = { voice: 0, clock: 0, t: 0, bars: new Float32Array(13) };
      if (this.flowReduced()) {
        this.paintStaticWave();
        return;
      }
      this.clock.onFrame(this.onWaveFrame);
    }

    stopWave() {
      this.clock.offFrame(this.onWaveFrame);
      this.wave = null;
    }

    paintStaticWave() {
      this.clock.offFrame(this.onWaveFrame);
      const bars = this.fb.bars;
      const mid = (bars.length - 1) / 2;
      bars.forEach((bar, i) => {
        const position = (i - mid) / mid;
        const envelope = 0.7 + 0.3 * Math.cos(position * Math.PI / 2);
        const shape = 0.35 + 0.45 * envelope * (0.6 + 0.4 * Math.abs(Math.sin(i * 1.7)));
        bar.style.transform = 'scaleY(' + (3 / 21 + (15 / 21) * shape).toFixed(3) + ')';
      });
    }

    voiceAt(ms) {
      const run = this.run;
      if (!run) return 0;
      for (const word of run.plan.words) {
        if (ms < word.start) break;
        if (ms <= word.end) {
          const phase = (ms - word.start) / (word.end - word.start);
          const syllables = Math.max(1, Math.round((word.end - word.start) / 110));
          const pulse = 0.5 + 0.5 * Math.sin(phase * Math.PI * syllables * 2 - Math.PI / 2);
          return word.filler ? 0.38 + 0.08 * pulse : 0.62 + 0.38 * pulse;
        }
      }
      return 0.03;
    }

    onWaveFrame(dtMs) {
      const w = this.wave;
      if (!w || !this.run) return;
      const dt = Math.max(0.001, Math.min(0.05, dtMs / 1000));
      // The voice follows the script's own clock, so the meter and the words
      // stay in step however frames arrive.
      w.t = this.clock.now - this.run.t0;
      const voice = this.fb.mode === 'recording' ? this.voiceAt(w.t) : 0.02;
      const approach = (cur, target, tau) => cur + (target - cur) * (1 - Math.exp(-dt / tau));
      w.voice = approach(w.voice, voice, voice > w.voice ? 0.028 : 0.115);
      w.clock = (w.clock + dt * (2.2 + w.voice * 3.8)) % (Math.PI * 2);
      const bars = this.fb.bars;
      const mid = (bars.length - 1) / 2;
      const secs = w.t / 1000;
      for (let i = 0; i < bars.length; i++) {
        const position = (i - mid) / mid;
        const envelope = 0.7 + 0.3 * Math.cos(position * Math.PI / 2);
        const detail = 0.65 + 0.6 * (0.5 + 0.5 * Math.sin(secs * 5.3 + i * 1.9) * Math.sin(secs * 3.1 + i * 0.7));
        const ripple = 0.78 * (0.5 + 0.5 * Math.sin(w.clock - i * 0.62))
          + 0.22 * (0.5 + 0.5 * Math.sin(w.clock * 2 - i * 0.94 + 1.3));
        const listening = envelope * (0.025 + 0.19 * ripple);
        const speaking = Math.min(1, envelope * (0.18 + 0.82 * ripple) * (0.9 + 0.1 * detail) * (0.8 + 0.25 * detail));
        const target = listening + w.voice * (speaking - listening);
        const attack = 0.075 - w.voice * 0.045;
        w.bars[i] = approach(w.bars[i], target, target > w.bars[i] ? attack : 0.1);
        bars[i].style.transform = 'scaleY(' + (3 / 21 + (15 / 21) * w.bars[i]).toFixed(3) + ')';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Mounting. The first app mount and the first playground mount on the page
  // share one state. An empty data-voxden-demo is read as the app.
  let mounted = null;
  const mountedHosts = new WeakSet();

  function mount(appHost, dictHost) {
    const valid = (node) => (node && node.nodeType === 1 ? node : null);
    const app = valid(appHost);
    const dict = valid(dictHost);
    if (!app && !dict) return null;
    if ((app && mountedHosts.has(app)) || (dict && mountedHosts.has(dict))) return mounted;
    let demo = null;
    try {
      demo = new Demo(app, dict);
    } catch (err) {
      if (window.console && console.error) console.error('Voxden demo could not start:', err);
      return null;
    }
    if (app) mountedHosts.add(app);
    if (dict) mountedHosts.add(dict);
    mounted = demo;
    return demo;
  }

  function mountAll() {
    const hosts = Array.from(document.querySelectorAll('[data-voxden-demo]'));
    const kind = (node) => (node.getAttribute('data-voxden-demo') || 'app').toLowerCase();
    const app = hosts.find((node) => kind(node) !== 'dictation');
    const dict = hosts.find((node) => kind(node) === 'dictation');
    mount(app, dict);
  }

  window.VoxdenDemo = { version: '2.0.0', mount };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
})();
