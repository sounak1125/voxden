/*
 * Voxden motion: small, declarative scroll motion for the site, and the
 * scroll scene of the home page's app window.
 *
 * API: attributes in the HTML, no script calls.
 *
 *   data-motion="rise"       Fades in and rises 18 px (about 440 ms) the first
 *                            time the element comes into view. Other kinds:
 *                            "fade", "scale" (from 0.97) and "clip" (revealed
 *                            from its bottom edge up).
 *   data-reveal              The same as data-motion="rise".
 *   data-motion-delay="120"  Waits that many ms first.
 *   data-motion-stagger      On a parent: the data-motion elements inside come
 *                            in one after another, 75 ms apart, or the gap
 *                            given (data-motion-stagger="90").
 *   data-count="1213"        When seen, counts up to the number already
 *                            written inside ("1,213", "3.6×", "$8", "63 min").
 *                            Decimals follow the attribute; separators,
 *                            prefix and suffix stay; the width never changes.
 *   data-scene="app"         The home page's app window. motion.css tilts it
 *                            back and lets it rise flat with the scroll (CSS
 *                            scroll-driven animations, no script); where the
 *                            browser lacks them, this script does the same
 *                            while the window is on screen. Under 720 px it
 *                            is a plain rise; under reduced motion it holds
 *                            still.
 *
 * Nothing starts hidden unless this script has marked both <html> (.motion)
 * and the element itself (.m-wait), so without script, or for anything the
 * script has not seen, the page simply shows. Reduced motion shows
 * everything at once. The work runs in IntersectionObserver callbacks and
 * short rAF bursts; nothing listens to scroll. Only opacity and transform
 * move (and clip-path for "clip").
 *
 * window.VoxdenMotion.scene() gives the app scene's live state, which the
 * voice stream reads each frame to land its light on the moving window:
 *   { el, progress (0 tilted .. 1 flat), angle (rad), scale, perspective }
 * or null when the scene is off.
 */
(function () {
  'use strict';

  if (window.VoxdenMotion) return;

  const root = document.documentElement;
  const reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const canObserve = typeof window.IntersectionObserver === 'function';
  const REVEAL_SEL = '[data-motion], [data-reveal]';
  const SEEN_MARGIN = 0.08;      // seen once the top edge is 8 % above the viewport's bottom
  const STAGGER_MS = 75;
  const DURATION = { rise: 440, fade: 420, scale: 520, clip: 660 };
  const COUNT_MS = 1300;
  const SCENE_MIN_WIDTH = 720;
  const INTRO_MS = 800;

  let reduced = !!(reduceMQ && reduceMQ.matches);

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function num(v, d) {
    const n = parseFloat(v);
    return isFinite(n) ? n : d;
  }
  function painted() {
    try {
      return performance.getEntriesByType('paint').length > 0;
    } catch (_) {
      return true;
    }
  }
  function viewportHeight() {
    return window.innerHeight || root.clientHeight || 0;
  }

  // ---------------------------------------------------------------------------
  // Reveals.
  const groups = new Map();
  let revealIO = null;

  function kindOf(el) {
    const k = el.getAttribute('data-motion');
    return k && DURATION[k] ? k : 'rise';
  }

  function staggerOf(el) {
    const parent = el.parentElement && el.parentElement.closest('[data-motion-stagger]');
    if (!parent) return null;
    let g = groups.get(parent);
    if (!g) {
      g = { step: clamp(num(parent.getAttribute('data-motion-stagger'), STAGGER_MS), 20, 200), last: -Infinity };
      groups.set(parent, g);
    }
    return g;
  }

  function showNow(el) {
    el.classList.add('m-in');
    el.classList.remove('m-wait');
  }

  function reveal(el, now) {
    const kind = kindOf(el);
    let delay = Math.max(0, num(el.getAttribute('data-motion-delay'), 0));
    const g = staggerOf(el);
    if (g) {
      const start = Math.max(now + delay, g.last + g.step);
      delay = start - now;
      g.last = start;
    }
    if (delay > 0) el.style.setProperty('--m-delay', Math.round(delay) + 'ms');
    el.classList.add('m-anim', 'm-in');
    setTimeout(() => {
      el.classList.remove('m-anim', 'm-wait');
      el.style.removeProperty('--m-delay');
    }, delay + DURATION[kind] + 80);
    countsWith(el, delay + 140);
  }

  function onSeen(entries) {
    const now = performance.now();
    const seen = [];
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) seen.push(entries[i].target);
    }
    seen.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    for (let i = 0; i < seen.length; i++) {
      revealIO.unobserve(seen[i]);
      reveal(seen[i], now);
    }
  }

  // ---------------------------------------------------------------------------
  // Counts. The final number stays in the page for assistive tech the whole
  // time (.m-count-sr, visually hidden); only an aria-hidden copy counts,
  // inside a box locked to the final number's measured width and aligned
  // right, so nothing beside it moves whatever the digits' shapes.
  const pendingCounts = new Map();   // element -> count, waiting to start
  const running = new Set();
  let countIO = null;
  let countRaf = 0;

  // Reads only (the number's text and its width); mountCount writes.
  function prepareCount(el) {
    const raw = el.getAttribute('data-count');
    const target = parseFloat(raw);
    if (!isFinite(target) || target < 0) return null;
    const decimals = (String(raw).split('.')[1] || '').length;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !/\d/.test(node.nodeValue)) node = walker.nextNode();
    if (!node) return null;
    const text = node.nodeValue;
    // Digits with their separators, including no-break and thin spaces.
    const m = /\d(?:[\d.,']|[^\S \t\r\n])*/.exec(text);
    const token = m[0].replace(/\D+$/, '');
    const intPart = decimals ? token.slice(0, Math.max(0, token.length - decimals - 1)) : token;
    const range = document.createRange();
    range.setStart(node, m.index);
    range.setEnd(node, m.index + token.length);
    const width = range.getBoundingClientRect().width;
    if (!(width > 0)) return null;
    return {
      el, node, text, target, decimals, token, width,
      before: text.slice(0, m.index),
      after: text.slice(m.index + token.length),
      decSep: decimals ? token.charAt(token.length - decimals - 1) : '.',
      groupSep: (/\D/.exec(intPart) || [''])[0],
      sr: null, vis: null, digits: null, tail: null, shown: null, start: 0,
    };
  }

  function formatCount(c, v) {
    const parts = v.toFixed(c.decimals).split('.');
    let int = parts[0];
    if (c.groupSep) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, c.groupSep);
    return parts.length > 1 ? int + c.decSep + parts[1] : int;
  }

  // Digits not reached yet are figure spaces (one tabular digit wide) and
  // separators not reached yet are punctuation spaces, so the text itself
  // keeps the final number's width, not only its box.
  const FIGURE_SPACE = String.fromCharCode(0x2007);
  const PUNCT_SPACE = String.fromCharCode(0x2008);
  function paintCount(c, v) {
    let shown = formatCount(c, v);
    const missing = c.token.length - shown.length;
    for (let i = missing - 1; i >= 0; i--) shown = (/\d/.test(c.token.charAt(i)) ? FIGURE_SPACE : PUNCT_SPACE) + shown;
    if (shown === c.shown) return;
    c.shown = shown;
    c.digits.nodeValue = shown;
  }

  // "$1,213 words" becomes "$" [sr: 1,213] [aria-hidden, fixed width: 37] " words"
  function mountCount(c) {
    if (c.vis) return;
    c.sr = document.createElement('span');
    c.sr.className = 'm-count-sr';
    c.sr.textContent = c.token;
    c.vis = document.createElement('span');
    c.vis.className = 'm-count-vis';
    c.vis.setAttribute('aria-hidden', 'true');
    c.vis.style.width = c.width + 'px';
    c.digits = document.createTextNode('');
    c.vis.appendChild(c.digits);
    c.tail = document.createTextNode(c.after);
    const parent = c.node.parentNode;
    const next = c.node.nextSibling;
    parent.insertBefore(c.sr, next);
    parent.insertBefore(c.vis, next);
    parent.insertBefore(c.tail, next);
    c.node.nodeValue = c.before;
    paintCount(c, 0);
  }

  function finishCount(c) {
    running.delete(c);
    if (!c.vis) return;
    c.sr.remove();
    c.vis.remove();
    c.tail.remove();
    c.node.nodeValue = c.text;
    c.sr = c.vis = c.digits = c.tail = null;
  }

  function startCount(c, delay) {
    mountCount(c);
    c.start = performance.now() + delay;
    running.add(c);
    if (!countRaf) countRaf = requestAnimationFrame(tickCounts);
  }

  function tickCounts(now) {
    countRaf = 0;
    running.forEach((c) => {
      const t = (now - c.start) / COUNT_MS;
      if (t < 0) return;
      if (t >= 1) {
        finishCount(c);
        return;
      }
      paintCount(c, c.target * (1 - Math.pow(1 - t, 4)));
    });
    if (running.size) countRaf = requestAnimationFrame(tickCounts);
  }

  // Counts inside an element that is being revealed start with it.
  function countsWith(el, delay) {
    const list = el.matches('[data-count]') ? [el] : [];
    el.querySelectorAll('[data-count]').forEach((n) => list.push(n));
    for (let i = 0; i < list.length; i++) {
      const c = pendingCounts.get(list[i]);
      if (!c) continue;
      pendingCounts.delete(list[i]);
      if (countIO) countIO.unobserve(list[i]);
      startCount(c, delay);
    }
  }

  function onCountSeen(entries) {
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].isIntersecting) continue;
      const el = entries[i].target;
      countIO.unobserve(el);
      const c = pendingCounts.get(el);
      if (!c) continue;
      pendingCounts.delete(el);
      startCount(c, 80);
    }
  }

  function stopAllCounts() {
    running.forEach(finishCount);
    pendingCounts.forEach((c) => finishCount(c));
    pendingCounts.clear();
  }

  // ---------------------------------------------------------------------------
  // Registering elements: all reads first, then all writes.
  function register(items, counts) {
    const didPaint = painted();
    const vh = viewportHeight();
    const line = vh * (1 - SEEN_MARGIN);
    // Reads.
    const rects = items.map((el) => el.getBoundingClientRect());
    const found = counts.filter((el) => !pendingCounts.has(el) && !el.querySelector('.m-count-vis'))
      .map((el) => ({ el, rect: el.getBoundingClientRect(), c: prepareCount(el) }))
      .filter((f) => f.c);
    // Writes.
    const waiting = new Set();
    items.forEach((el, i) => {
      if (el.classList.contains('m-in') || el.classList.contains('m-wait')) return;
      const r = rects[i];
      const above = r.bottom <= 0 && r.height > 0;
      const inView = r.top < line && r.bottom > 0;
      if (above || (inView && didPaint)) showNow(el);
      else {
        el.classList.add('m-wait');
        waiting.add(el);
        revealIO.observe(el);
      }
    });
    // A number counts when it is first seen: with the element revealing it,
    // or on its own if it is not inside one.
    found.forEach(({ el, rect, c }) => {
      const host = el.closest('.m-wait');
      if (host && !waiting.has(host)) return;
      if (!host && rect.top < line && rect.bottom > 0 && didPaint) return;
      pendingCounts.set(el, c);
      mountCount(c);
      if (!host) countIO.observe(el);
    });
  }

  // Elements added after load (a component that builds itself later) join
  // in the same way; anything missed simply shows.
  function watchAdditions() {
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver((records) => {
      const items = [];
      const counts = [];
      for (let i = 0; i < records.length; i++) {
        const added = records[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (n.nodeType !== 1 || /^m-count/.test(n.className)) continue;
          if (n.matches(REVEAL_SEL)) items.push(n);
          if (n.matches('[data-count]')) counts.push(n);
          if (!n.firstElementChild) continue;
          n.querySelectorAll(REVEAL_SEL).forEach((e) => items.push(e));
          n.querySelectorAll('[data-count]').forEach((e) => counts.push(e));
        }
      }
      if (items.length || counts.length) register(items, counts);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------------
  // The app scene. The tilt is a pure function of the scroll position, the
  // same one motion.css gives view(block 0px) with the range
  // "cover 0% cover <range>": 0 while the window's top edge is at the
  // viewport's bottom, 1 once it is <range> of the viewport higher.
  const scene = document.querySelector('[data-scene="app"]');
  const cssScene = !!(window.CSS && CSS.supports && CSS.supports('animation-timeline', 'view()'));
  const S = {
    mode: 'off', top: 0, vh: 1, tilt: 10, scale: 0.94, perspective: 1400, range: 0.8,
    visible: false, raf: 0, intro: null, lastKey: '',
  };

  function readSceneConfig() {
    const cs = getComputedStyle(scene);
    S.tilt = num(cs.getPropertyValue('--m-scene-tilt'), 10);
    S.scale = num(cs.getPropertyValue('--m-scene-scale'), 0.94);
    S.perspective = num(cs.getPropertyValue('--m-scene-perspective'), 1400);
    S.range = num(cs.getPropertyValue('--m-scene-range'), 80) / 100;
  }

  // The window's resting top edge on the page: offsets ignore transforms.
  function layoutTop(el) {
    let y = 0;
    for (let n = el; n; n = n.offsetParent) y += n.offsetTop + (n === el ? 0 : n.clientTop);
    return y;
  }

  function measureScene() {
    if (!scene) return;
    S.top = layoutTop(scene);
    S.vh = viewportHeight() || 1;
  }

  function sceneProgress() {
    const y = window.pageYOffset || root.scrollTop || 0;
    return clamp((y - (S.top - (root.clientHeight || S.vh))) / Math.max(1, S.range * S.vh), 0, 1);
  }

  function modeNow() {
    if (!scene || reduced) return 'off';
    if (window.innerWidth < SCENE_MIN_WIDTH) return 'rise';
    if (cssScene) return 'css';
    return canObserve ? 'js' : 'off';
  }

  function sceneState() {
    if (S.mode !== 'css' && S.mode !== 'js') return null;
    let k = 1 - sceneProgress();
    if (S.intro) k *= S.intro.mix;
    return {
      el: scene,
      progress: 1 - k,
      angle: (S.tilt * k * Math.PI) / 180,
      scale: 1 - (1 - S.scale) * k,
      perspective: S.perspective,
    };
  }

  // Scroll-driven animations missing: set the same transform each frame
  // while the window is on screen, and nothing once it rests flat.
  function applySceneTransform() {
    const st = sceneState();
    if (!st) return;
    const flat = st.angle < 1e-5 && st.scale > 0.99999;
    const deg = (st.angle * 180) / Math.PI;
    const key = flat ? 'flat' : deg.toFixed(3) + ' ' + st.scale.toFixed(4);
    if (key === S.lastKey) return;
    S.lastKey = key;
    scene.style.transform = flat ? '' :
      'perspective(' + S.perspective + 'px) rotateX(' + deg.toFixed(3) + 'deg) scale(' + st.scale.toFixed(4) + ')';
  }

  function sceneLoop(now) {
    S.raf = 0;
    if (S.mode !== 'js' || !S.visible) return;
    if (S.intro) {
      const t = (now - S.intro.t0) / INTRO_MS;
      S.intro.mix = t >= 1 ? 1 : t * t * (3 - 2 * t);
      if (t >= 1) S.intro = null;
    }
    applySceneTransform();
    S.raf = requestAnimationFrame(sceneLoop);
  }

  function setSceneMode(next) {
    if (next === S.mode) return;
    const prev = S.mode;
    S.mode = next;
    if (prev === 'js') {
      scene.classList.remove('m-scene-js');
      scene.style.transform = '';
      S.lastKey = '';
      S.intro = null;
    }
    if (next === 'js') {
      scene.classList.add('m-scene-js');
      if (S.visible && !S.raf) S.raf = requestAnimationFrame(sceneLoop);
    }
    // A window that becomes a plain rise after load is simply shown.
    if (next === 'rise' && root.classList.contains('motion')) showNow(scene);
  }

  function initScene() {
    if (!scene) return;
    readSceneConfig();
    measureScene();
    const next = modeNow();
    if (next === 'js' && painted()) {
      // The page has already shown the window flat: ease the tilt in.
      const r = scene.getBoundingClientRect();
      if (r.top < viewportHeight() && r.bottom > 0) S.intro = { t0: performance.now(), mix: 0 };
    }
    setSceneMode(next);
    if (canObserve) {
      new IntersectionObserver((entries) => {
        S.visible = entries[entries.length - 1].isIntersecting;
        if (S.visible && S.mode === 'js' && !S.raf) S.raf = requestAnimationFrame(sceneLoop);
      }).observe(scene);
    }
    const onLayout = () => {
      measureScene();
      setSceneMode(modeNow());
    };
    if (window.ResizeObserver) new ResizeObserver(onLayout).observe(document.body);
    window.addEventListener('resize', onLayout);
    window.addEventListener('load', onLayout);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(onLayout).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  function onReduceChange() {
    reduced = !!(reduceMQ && reduceMQ.matches);
    if (reduced) {
      // Everything shows at once and stays put.
      root.classList.remove('motion');
      stopAllCounts();
    }
    if (scene) setSceneMode(modeNow());
  }

  function init() {
    initScene();
    if (reduceMQ) {
      if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', onReduceChange);
      else if (reduceMQ.addListener) reduceMQ.addListener(onReduceChange);
    }
    if (reduced || !canObserve) return;

    revealIO = new IntersectionObserver(onSeen, { rootMargin: '0px 0px ' + -SEEN_MARGIN * 100 + '% 0px' });
    countIO = new IntersectionObserver(onCountSeen, { rootMargin: '0px 0px -12% 0px' });
    const items = Array.from(document.querySelectorAll(REVEAL_SEL));
    if (scene && S.mode === 'rise') items.push(scene);
    register(items, Array.from(document.querySelectorAll('[data-count]')));
    root.classList.add('motion');
    watchAdditions();
  }

  window.VoxdenMotion = Object.freeze({ version: 1, scene: sceneState });
  init();
})();
