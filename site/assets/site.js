/* Voxden — voxden.app
   Every interaction on the site, in one file, no dependencies:
   nav state, scroll reveals, card spotlight, the hero demo, the region
   price switch, latest-release lookup and the FAQ accordion. */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---------- nav ---------- */
  var nav = doc.querySelector('.nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('is-scrolled', window.scrollY > 8); };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    var burger = nav.querySelector('.nav-burger');
    if (burger) {
      burger.addEventListener('click', function () {
        var open = nav.classList.toggle('is-open');
        burger.setAttribute('aria-expanded', String(open));
      });
      nav.querySelectorAll('.nav-sheet a').forEach(function (a) {
        a.addEventListener('click', function () { nav.classList.remove('is-open'); burger.setAttribute('aria-expanded', 'false'); });
      });
    }
  }

  /* ---------- reveal on scroll ---------- */
  var revealTargets = doc.querySelectorAll('.reveal, [data-stagger]');
  if (reduced || !('IntersectionObserver' in window)) {
    revealTargets.forEach(function (el) { el.classList.add('is-in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-in');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.1 });
    revealTargets.forEach(function (el) {
      if (el.hasAttribute('data-stagger')) {
        Array.prototype.forEach.call(el.children, function (c, i) { c.style.setProperty('--i', i); });
      }
      io.observe(el);
    });
  }

  /* ---------- card spotlight follows the cursor ---------- */
  if (window.matchMedia('(hover: hover)').matches) {
    doc.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(2) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(2) + '%');
        card.classList.add('is-lit');
      }, { passive: true });
      card.addEventListener('pointerleave', function () { card.classList.remove('is-lit'); });
    });
    // pointerleave never fires when the page scrolls under a still cursor,
    // on touch, or when a tap opens another page: drop every spotlight then.
    var unlit = function () {
      doc.querySelectorAll('.card.is-lit').forEach(function (c) { c.classList.remove('is-lit'); });
    };
    window.addEventListener('scroll', unlit, { passive: true });
    doc.addEventListener('pointermove', function (e) {
      if (!(e.target.closest && e.target.closest('.card'))) unlit();
    }, { passive: true });
    doc.addEventListener('pointercancel', unlit);
    doc.addEventListener('visibilitychange', unlit);
    window.addEventListener('pagehide', unlit);
  }

  /* ---------- region: India sees ₹349, everyone else $8 ----------
     Order: a choice the visitor made here, then Cloudflare's country
     (served with the site once it is on Pages), then the PC's time zone,
     then its language. The app itself places an account by the IP it
     first signs in from; this only decides which price is shown first. */
  var REGION_KEY = 'voxden-region';
  function setRegion(region, persist) {
    root.setAttribute('data-region', region);
    doc.querySelectorAll('[data-region-set]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-region-set') === region));
    });
    if (persist) { try { localStorage.setItem(REGION_KEY, region); } catch (_) {} }
  }
  function detectRegion() {
    var saved = null;
    try { saved = localStorage.getItem(REGION_KEY); } catch (_) {}
    if (saved === 'in' || saved === 'world') return Promise.resolve(saved);
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 1500) : null;
    return fetch('/cdn-cgi/trace', { cache: 'no-store', signal: controller ? controller.signal : undefined })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        var m = /(?:^|\n)loc=([A-Z]{2})/.exec(text || '');
        if (m) return m[1] === 'IN' ? 'in' : 'world';
        throw new Error('no trace');
      })
      .catch(function () {
        var tz = '';
        try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
        if (/^Asia\/(Kolkata|Calcutta)$/.test(tz)) return 'in';
        var langs = navigator.languages || [navigator.language || ''];
        if (langs.some(function (l) { return /-IN$/i.test(l); })) return 'in';
        return 'world';
      })
      .then(function (region) { if (timer) clearTimeout(timer); return region; });
  }
  if (doc.querySelector('.only-in, .only-world, [data-region-set]')) {
    detectRegion().then(function (region) { setRegion(region, false); });
    doc.querySelectorAll('[data-region-set]').forEach(function (b) {
      b.addEventListener('click', function () { setRegion(b.getAttribute('data-region-set'), true); });
    });
  }

  /* ---------- latest release from GitHub ---------- */
  var releaseLinks = doc.querySelectorAll('[data-release-link]');
  if (releaseLinks.length) {
    fetch('https://api.github.com/repos/sounak1125/voxden/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        if (!rel) return;
        var exe = (rel.assets || []).filter(function (a) { return /\.exe$/i.test(a.name); })[0];
        if (!exe) return;
        releaseLinks.forEach(function (a) { a.href = exe.browser_download_url; });
        var version = String(rel.tag_name || '').replace(/^v/, '');
        if (version) doc.querySelectorAll('[data-release-version]').forEach(function (el) { el.textContent = version; });
        var mb = Math.round(exe.size / 1048576);
        if (mb) doc.querySelectorAll('[data-release-size]').forEach(function (el) { el.textContent = mb + ' MB'; });
        if (rel.published_at) {
          var d = new Date(rel.published_at);
          doc.querySelectorAll('[data-release-date]').forEach(function (el) {
            el.textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
          });
        }
      })
      .catch(function () {});
  }

  /* ---------- faq ---------- */
  doc.querySelectorAll('.faq').forEach(function (faq) {
    var buttons = faq.querySelectorAll('.faq-q');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        buttons.forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
        btn.setAttribute('aria-expanded', String(!open));
      });
    });
    var hash = location.hash && faq.querySelector(location.hash);
    if (hash && hash.classList.contains('faq-item')) {
      var q = hash.querySelector('.faq-q');
      if (q) q.setAttribute('aria-expanded', 'true');
    }
  });

  /* ---------- hero demo: press, speak, pasted ---------- */
  var demo = doc.getElementById('demo');
  if (demo) {
    var bar = demo.querySelector('.demo-bar');
    var wave = demo.querySelector('.demo-wave');
    var typed = demo.querySelector('.demo-typed');
    var langTag = demo.querySelector('.demo-lang');
    var keys = doc.querySelectorAll('[data-demo-key]');
    var lines = [
      { lang: 'English', text: 'Move the standup to 3 tomorrow and send the notes to Priya before she boards.' },
      { lang: 'Hinglish', text: 'Kal ka meeting 11 baje shift kar do, main thoda late pahunchunga.' },
      { lang: 'English', text: 'Add Kharagpur to the dictionary so it stops writing it wrong.' },
    ];
    for (var i = 0; i < 18; i++) {
      var b = doc.createElement('i');
      b.style.setProperty('--n', i);
      b.style.setProperty('--a', (0.25 + 0.75 * Math.abs(Math.sin(i * 1.7 + 0.4))).toFixed(2));
      wave.appendChild(b);
    }
    var setPhase = function (phase) {
      demo.setAttribute('data-phase', phase);
      bar.setAttribute('data-state', phase === 'recording' || phase === 'thinking' ? phase : 'idle');
    };
    var pressKeys = function (down) { keys.forEach(function (k) { k.classList.toggle('is-down', down); }); };

    var visible = true;
    var run = 0;
    var index = 0;
    var waiting = null;

    if (reduced) {
      typed.textContent = lines[0].text;
      langTag.textContent = lines[0].lang;
      setPhase('hold');
    } else {
      var loop = async function (token) {
        while (token === run) {
          if (!visible || doc.hidden) { await sleep(400); continue; }
          var line = lines[index % lines.length];
          index += 1;
          langTag.textContent = line.lang;
          setPhase('press');
          pressKeys(true);
          await sleep(190);
          pressKeys(false);
          if (token !== run) return;
          setPhase('recording');
          await sleep(1500 + line.text.length * 22);
          if (token !== run) return;
          setPhase('thinking');
          await sleep(620);
          if (token !== run) return;
          setPhase('typing');
          typed.textContent = '';
          for (var c = 0; c < line.text.length; c++) {
            if (token !== run) return;
            typed.textContent += line.text[c];
            await sleep(line.text[c] === ' ' ? 12 : 19);
          }
          setPhase('hold');
          waiting = { resolve: null };
          await new Promise(function (resolve) {
            waiting.resolve = resolve;
            setTimeout(resolve, 3400);
          });
          waiting = null;
          if (token !== run) return;
          typed.textContent = '';
          await sleep(350);
        }
      };
      var start = function () { run += 1; loop(run); };
      // Clicking the demo (or its keycaps) starts the next line at once.
      var nudge = function () {
        var phase = demo.getAttribute('data-phase');
        if (phase === 'hold' && waiting && waiting.resolve) { waiting.resolve(); return; }
        if (phase === 'idle' || phase === 'hold' || !phase) start();
      };
      demo.addEventListener('click', nudge);
      keys.forEach(function (k) { k.addEventListener('click', function (e) { e.stopPropagation(); nudge(); }); });
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { visible = e.isIntersecting; });
        }, { threshold: 0.2 }).observe(demo);
      }
      setPhase('idle');
      setTimeout(start, 900);
    }
  }
})();

/* ---------- download page: the first-run walkthrough ---------- */
(function () {
  'use strict';
  var ssd = document.getElementById('ssd');
  if (!ssd) return;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var stage = ssd.querySelector('.ssd-stage');
  var cursor = ssd.querySelector('.ssd-cursor');
  var click = ssd.querySelector('.ssd-click');
  var file = ssd.querySelector('.ssd-file');
  var moreInfo = ssd.querySelector('.ssd-moreinfo');
  var runAnyway = ssd.querySelector('.ssd-run');
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var run = 0;
  var visible = true;

  var moveTo = function (el, dx, dy) {
    var s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
    var x = r.left - s.left + r.width * (dx == null ? 0.5 : dx);
    var y = r.top - s.top + r.height * (dy == null ? 0.5 : dy);
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    click.style.left = x + 'px';
    click.style.top = y + 'px';
  };
  var ripple = function () { click.classList.remove('is-on'); void click.offsetWidth; click.classList.add('is-on'); };
  var set = function (step, phase) { ssd.setAttribute('data-step', String(step)); ssd.setAttribute('data-phase', phase); };
  var phases = { 1: 'file', 2: 'warn', 3: 'more', 4: 'install' };

  // file -> warn -> more -> install -> done, then around again.
  var play = async function (token, from) {
    var step = from || 1;
    while (token === run) {
      if (!visible || document.hidden) { await sleep(400); continue; }
      if (step === 1) {
        set(1, 'file'); stage.classList.remove('is-live');
        await sleep(300); moveTo(file, 0.5, 0.55); await sleep(900);
        ripple(); await sleep(140); ripple(); await sleep(500);
        if (token !== run) return;
        step = 2;
      }
      if (step === 2) {
        set(2, 'warn'); await sleep(700);
        moveTo(moreInfo, 0.5, 0.5); await sleep(1100);
        ripple(); await sleep(350);
        if (token !== run) return;
        step = 3;
      }
      if (step === 3) {
        set(3, 'more'); await sleep(250);
        moveTo(runAnyway, 0.5, 0.5); await sleep(1300);
        ripple(); await sleep(350);
        if (token !== run) return;
        step = 4;
      }
      if (step === 4) {
        set(4, 'install'); moveTo(stage, 0.78, 0.86); await sleep(1900);
        if (token !== run) return;
        set(4, 'done'); await sleep(3200);
        if (token !== run) return;
        step = 1;
      }
    }
  };
  var start = function (from) { run += 1; play(run, from); };

  if (reduced) {
    set(3, 'more');
    ssd.querySelectorAll('.ssd-step button').forEach(function (b) {
      b.addEventListener('click', function () {
        var s = Number(b.parentNode.getAttribute('data-go'));
        set(s, s === 4 ? 'done' : phases[s]);
      });
    });
    return;
  }
  ssd.querySelectorAll('.ssd-step button').forEach(function (b) {
    b.addEventListener('click', function () { start(Number(b.parentNode.getAttribute('data-go'))); });
  });
  ssd.querySelector('.ssd-replay').addEventListener('click', function () { start(1); });
  // The visitor can drive the dialog themselves; the cursor steps aside.
  moreInfo.addEventListener('click', function () { run += 1; stage.classList.add('is-live'); set(3, 'more'); });
  runAnyway.addEventListener('click', function () {
    stage.classList.add('is-live');
    var token = ++run;
    set(4, 'install');
    sleep(1900).then(function () { if (token === run) set(4, 'done'); });
  });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible = e.isIntersecting; });
    }, { threshold: 0.25 }).observe(ssd);
  }
  set(1, 'file');
  setTimeout(function () { start(1); }, 600);
})();
