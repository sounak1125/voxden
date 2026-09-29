/* Voxden — voxden.app
   The site's own behaviour, in one file, no dependencies: the nav, the
   region price, the latest release on the download buttons, the FAQ's
   deep links, the back-to-top button and the download page's first-run
   walkthrough. Scroll motion is the shared layer in assets/motion/; the
   home page's demo, light and features bring their own scripts. */
(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;

  /* ---------- arriving at a #link, and smooth scrolling after that ----------
     The browser jumps to the target while the page is still growing, so it
     can stop short; once everything has loaded, land on it again, unless
     the visitor has already scrolled. Smooth scrolling starts only then, so
     that landing is a jump, not a glide through everything above it. */
  var moved = false;
  var onMove = function () { moved = true; };
  ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(function (ev) { window.addEventListener(ev, onMove, { passive: true, once: true }); });
  var settle = function () {
    var id = location.hash.slice(1);
    var target = id && doc.getElementById(decodeURIComponent(id));
    if (target && !moved && !target.closest('details')) target.scrollIntoView({ block: 'start', behavior: 'instant' });
    root.classList.add('is-loaded');
  };
  if (doc.readyState === 'complete') root.classList.add('is-loaded');
  else window.addEventListener('load', function () { setTimeout(settle, 0); });

  /* ---------- nav ---------- */
  var nav = doc.querySelector('.nav');
  if (nav) {
    var burger = nav.querySelector('.nav-burger');
    if (burger) {
      var setOpen = function (open) {
        nav.classList.toggle('is-open', open);
        root.classList.toggle('nav-open', open);
        burger.setAttribute('aria-expanded', String(open));
      };
      burger.addEventListener('click', function () { setOpen(!nav.classList.contains('is-open')); });
      nav.querySelectorAll('.nav-sheet a').forEach(function (a) {
        a.addEventListener('click', function () { setOpen(false); });
      });
      doc.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && nav.classList.contains('is-open')) { setOpen(false); burger.focus(); }
      });
      window.matchMedia('(min-width: 768px)').addEventListener('change', function (m) { if (m.matches) setOpen(false); });
    }
  }

  /* ---------- region: India sees ₹349, everyone else $8 ----------
     Order: ?region=in|world for local preview, then a choice the visitor
     made here, then Cloudflare's country (cdn-cgi/trace on Pages), then
     the PC's time zone, then its language. Worldwide if none of those
     land. The app places an account by sign-in IP; this page is public
     and only picks which price to show first. No login, no "you are in
     India" copy. */
  var REGION_KEY = 'voxden-region';
  function setRegion(region, persist) {
    root.setAttribute('data-region', region);
    root.setAttribute('data-region-ready', '');
    doc.querySelectorAll('[data-region-set]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-region-set') === region));
    });
    if (persist) { try { localStorage.setItem(REGION_KEY, region); } catch (_) {} }
  }
  function queryRegion() {
    try {
      var q = new URLSearchParams(location.search).get('region');
      if (q === 'in' || q === 'world') return q;
    } catch (_) {}
    return null;
  }
  function detectRegion() {
    var fromQuery = queryRegion();
    if (fromQuery) return Promise.resolve(fromQuery);
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
  if (doc.querySelector('.only-in, .only-world')) {
    detectRegion().then(setRegion, function () { setRegion('world'); });
  }

  /* ---------- latest release from GitHub ----------
     Every download button names its system: data-release-link="win" or
     "mac" gets that file's address, and the same marks on
     data-release-size pick which file's size is shown. */
  var isMacVisitor = /Macintosh/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1);
  // The download box for this visitor's own system says so.
  doc.querySelectorAll('.dl-box[data-os]').forEach(function (a) {
    a.classList.toggle('is-own', a.getAttribute('data-os') === (isMacVisitor ? 'mac' : 'win'));
  });
  var releaseLinks = doc.querySelectorAll('[data-release-link]');
  if (releaseLinks.length) {
    fetch('https://api.github.com/repos/sounak1125/voxden/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rel) {
        if (!rel) return;
        var assets = rel.assets || [];
        var exe = assets.filter(function (a) { return /\.exe$/i.test(a.name); })[0];
        var dmg = assets.filter(function (a) { return /-mac-arm64\.dmg$/i.test(a.name); })[0];
        if (!exe && !dmg) return;
        var own = isMacVisitor ? dmg : exe;
        var pick = function (which) { return which === 'mac' ? dmg : which === 'win' ? exe : own; };
        releaseLinks.forEach(function (a) {
          var asset = pick(a.getAttribute('data-release-link'));
          if (asset) a.href = asset.browser_download_url;
        });
        var version = String(rel.tag_name || '').replace(/^v/, '');
        if (version) doc.querySelectorAll('[data-release-version]').forEach(function (el) { el.textContent = version; });
        doc.querySelectorAll('[data-release-size]').forEach(function (el) {
          var asset = pick(el.getAttribute('data-release-size'));
          var mb = asset && Math.round(asset.size / 1048576);
          if (mb) el.textContent = mb + ' MB';
        });
        if (rel.published_at) {
          var d = new Date(rel.published_at);
          doc.querySelectorAll('[data-release-date]').forEach(function (el) {
            el.textContent = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
          });
        }
      })
      .catch(function () {});
  }

  /* ---------- questions: a link to #faq-… opens that answer ---------- */
  var openFromHash = function (onLoad) {
    var id = location.hash.slice(1);
    if (!id) return;
    var target = doc.getElementById(id);
    var details = target && (target.tagName === 'DETAILS' ? target : target.closest('details'));
    if (!details) return;
    if (!onLoad) { details.open = true; return; }
    // On load the browser's own jump runs before the answer opens and falls
    // short as the page grows under it. Open this one without its easing,
    // so the page is at full height, and land on the question again.
    details.classList.add('is-instant');
    details.open = true;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
    requestAnimationFrame(function () { details.classList.remove('is-instant'); });
  };
  openFromHash(true);
  window.addEventListener('hashchange', function () { openFromHash(false); });

  /* ---------- back to top, at the very end of the page ----------
     Shown while the footer's last line is in view and the top of the page
     is not (a page that fits on one screen never shows it). Observers
     only, no scroll handler. While hidden it is inert: out of the tab
     order and hidden from assistive tech. After the jump, focus goes to
     the first stop on the page, the skip link. */
  var toTop = doc.querySelector('.to-top');
  var pageEnd = doc.querySelector('.footer-copy');
  var pageStart = doc.querySelector('main > :first-child');
  if (toTop && pageEnd && pageStart && 'IntersectionObserver' in window) {
    var atEnd = false;
    var atStart = true;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.target === pageEnd) atEnd = e.isIntersecting;
        else atStart = e.isIntersecting;
      });
      var shown = atEnd && !atStart;
      toTop.classList.toggle('is-shown', shown);
      toTop.inert = !shown;
    });
    io.observe(pageEnd);
    io.observe(pageStart);
    toTop.addEventListener('click', function () {
      var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: still ? 'instant' : 'smooth' });
      var first = doc.querySelector('.skip');
      if (first) first.focus({ preventScroll: true });
    });
  }

  /* ---------- the hero's shortcut: each system's keys in turn ----------
     Starts with this visitor's own system, presses its keys one after
     another and lets go, then switches to the other system's. It runs only
     while the line is on screen; with reduced motion it shows this
     visitor's own shortcut and holds still. */
  var keySwap = doc.querySelector('[data-key-swap]');
  if (keySwap) {
    var ownOs = /Macintosh/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1) ? 'mac' : 'win';
    keySwap.setAttribute('data-show', ownOs);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
      var keysOn = false;
      var keyWait = function (ms) {
        return new Promise(function (r) { setTimeout(r, ms); }).then(function () {
          return new Promise(function (r) {
            (function hold() { if (keysOn && !doc.hidden) r(); else setTimeout(hold, 300); })();
          });
        });
      };
      var keyLoop = async function () {
        var os = ownOs;
        for (;;) {
          keySwap.setAttribute('data-show', os);
          var keys = keySwap.querySelectorAll('[data-set="' + os + '"] .kbd');
          await keyWait(900);
          for (var i = 0; i < keys.length; i++) { keys[i].classList.add('is-down'); await keyWait(160); }
          await keyWait(700);
          keys.forEach(function (k) { k.classList.remove('is-down'); });
          await keyWait(1800);
          os = os === 'win' ? 'mac' : 'win';
        }
      };
      new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { keysOn = e.isIntersecting; });
      }).observe(keySwap);
      keyLoop();
    }
  }

  /* ---------- the download boxes' sweep runs only while it is on screen ---------- */
  if ('IntersectionObserver' in window) {
    var sweepIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle('is-live', e.isIntersecting); });
    });
    doc.querySelectorAll('.closing').forEach(function (el) { sweepIo.observe(el); });
  }
})();

/* ---------- download page: the first run on Windows and on a Mac ----------
   One screen, Windows on its front and a Mac on its back. A cursor plays
   one system's steps, the screen turns over, the other system plays, and
   around again. Picking a name, a tick or arriving at #mac keeps it on
   that system; "Play both" hands it back. Nothing runs off screen, and
   with reduced motion there is no cursor or turn: the ticks and names
   show each step's still. */
(function () {
  'use strict';
  var fr = document.getElementById('fr');
  if (!fr) return;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var stage = fr.querySelector('.fr-stage');
  var world = fr.querySelector('.fr-world');
  var cursor = fr.querySelector('.fr-cursor');
  var ring = fr.querySelector('.fr-ring');
  var ghost = fr.querySelector('.fr-ghost');
  var panel = fr.querySelector('.fr-panel');
  var resume = fr.querySelector('[data-resume]');
  var q = function (sel) { return stage.querySelector(sel); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var other = function (os) { return os === 'win' ? 'mac' : 'win'; };
  var CANCEL = {};
  // Seconds each scripted step takes, so its tick fills with it.
  var DUR = { win: [2.05, 2.05, 1.95, 4.9], mac: [3.5, 2.1, 4.5, 7.45] };
  // What a still shows for each step, with reduced motion.
  var STILL = { win: ['file', 'warn', 'more', 'done'], mac: ['dmg', 'blocked', 'settings', 'axon'] };

  var os = /Macintosh/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1) ? 'mac' : 'win';
  var auto = !reduced;
  var step = 0;
  var run = 0;
  var visible = false;

  // The ticks, one per step, for each system.
  fr.querySelectorAll('.fr-ticks').forEach(function (box) {
    var sys = box.getAttribute('data-for');
    fr.querySelectorAll('.fr-steps[data-for="' + sys + '"] .fr-t').forEach(function (t, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', 'Step ' + (i + 1) + ': ' + t.textContent);
      b.setAttribute('data-i', String(i + 1));
      b.appendChild(document.createElement('i'));
      box.appendChild(b);
    });
  });

  var setAuto = function (on) {
    auto = on && !reduced;
    fr.setAttribute('data-auto', auto ? 'on' : 'off');
    resume.hidden = auto || reduced;
  };
  var setOs = function (sys) {
    os = sys;
    fr.setAttribute('data-os', sys);
    stage.setAttribute('data-os', sys);
    fr.querySelectorAll('[data-pick]').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.getAttribute('data-pick') === sys));
    });
    panel.setAttribute('aria-labelledby', 'fr-tab-' + sys);
    step = 0;
  };
  var set = function (n, phase) {
    stage.setAttribute('data-phase', phase);
    if (n === step) return;
    step = n;
    fr.style.setProperty('--fr-p', String(n / 4));
    fr.style.setProperty('--fr-sd', DUR[os][n - 1] + 's');
    fr.querySelectorAll('.fr-steps[data-for="' + os + '"] .fr-step').forEach(function (li, i) {
      li.classList.toggle('is-on', i + 1 === n);
    });
    fr.querySelectorAll('.fr-ticks[data-for="' + os + '"] button').forEach(function (b, i) {
      b.classList.toggle('is-done', i + 1 < n);
      b.classList.remove('is-on');
      if (i + 1 === n) { void b.offsetWidth; b.classList.add('is-on'); }
    });
  };

  // Waits, holding while off screen, and stops if a newer run replaced it.
  var wait = async function (token, ms) {
    await sleep(ms);
    while (token === run && (!visible || document.hidden)) await sleep(300);
    if (token !== run) throw CANCEL;
  };
  var local = function (el) {
    var w = world.getBoundingClientRect(), r = el.getBoundingClientRect();
    return { x: r.left - w.left, y: r.top - w.top, w: r.width, h: r.height };
  };
  var point = function (el, dx, dy) {
    var l = local(el);
    var x = l.x + l.w * (dx == null ? 0.5 : dx), y = l.y + l.h * (dy == null ? 0.5 : dy);
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
  };
  var click = function () { ring.classList.remove('is-on'); void ring.offsetWidth; ring.classList.add('is-on'); };

  var SCRIPTS = {
    win: [
      async function (t) {
        set(1, 'file'); await wait(t, 500);
        point(q('.fr-open')); await wait(t, 1100);
        click(); await wait(t, 450);
      },
      async function (t) {
        set(2, 'warn'); await wait(t, 700);
        point(q('.fr-moreinfo')); await wait(t, 1000);
        click(); await wait(t, 350);
      },
      async function (t) {
        set(3, 'more'); await wait(t, 250);
        point(q('.fr-run')); await wait(t, 1300);
        click(); await wait(t, 400);
      },
      async function (t) {
        set(4, 'install'); point(world, 0.8, 0.78); await wait(t, 1900);
        set(4, 'done'); await wait(t, 3000);
      }
    ],
    mac: [
      async function (t) {
        ghost.style.transition = 'none'; ghost.style.transform = 'none';
        set(1, 'dmg'); await wait(t, 600);
        var app = q('.fr-app img'), folder = q('.fr-folder svg');
        point(app, 0.55, 0.55); await wait(t, 1000);
        click();
        var a = local(app), f = local(folder);
        ghost.style.left = a.x + 'px'; ghost.style.top = a.y + 'px';
        void ghost.offsetWidth; ghost.style.transition = '';
        set(1, 'drag'); await wait(t, 120);
        ghost.style.transform = 'translate(' + (f.x - a.x + (f.w - a.w) / 2) + 'px,' + (f.y - a.y + (f.h - a.h) / 2) + 'px)';
        point(folder, 0.55, 0.55); await wait(t, 950);
        click(); set(1, 'dropped'); await wait(t, 800);
      },
      async function (t) {
        set(2, 'blocked'); await wait(t, 700);
        point(q('.fr-done')); await wait(t, 1000);
        click(); await wait(t, 400);
      },
      async function (t) {
        set(3, 'settings'); await wait(t, 800);
        point(q('.fr-openany')); await wait(t, 1200);
        click(); await wait(t, 300);
        set(3, 'touch'); point(q('.fr-fp'), 0.6, 0.7); await wait(t, 1300);
        set(3, 'touchok'); await wait(t, 900);
      },
      async function (t) {
        set(4, 'mic'); await wait(t, 600);
        point(q('.fr-allow')); await wait(t, 1000);
        click(); await wait(t, 350);
        set(4, 'ax'); await wait(t, 600);
        point(q('.fr-toggle')); await wait(t, 1000);
        click(); set(4, 'axon'); await wait(t, 900);
        set(4, 'ready'); point(world, 0.8, 0.78); await wait(t, 3000);
      }
    ]
  };

  // Turns the screen to the other system.
  var turn = async function (token, sys) {
    fr.classList.add('is-turning');
    setOs(sys);
    stage.setAttribute('data-phase', STILL[sys][0]);
    await wait(token, 1250);
    fr.classList.remove('is-turning');
  };
  var play = async function (from, sys) {
    var token = ++run;
    fr.classList.remove('is-turning');
    try {
      if (sys && sys !== os) await turn(token, sys);
      step = 0;
      var i = from || 0;
      for (;;) {
        for (; i < 4; i++) await SCRIPTS[os][i](token);
        i = 0;
        step = 0;
        if (auto) await turn(token, other(os));
      }
    } catch (e) { if (e !== CANCEL) throw e; }
  };

  // With reduced motion: no cursor, no turn, one still per step.
  var still = function (sys, i) {
    run += 1;
    setOs(sys);
    set(i + 1, STILL[sys][i]);
  };
  var go = function (sys, i) { if (reduced) still(sys, i); else play(i, sys); };

  fr.classList.add('is-js');
  if (reduced) fr.classList.add('is-still');
  var pinned = location.hash === '#mac';
  setOs(pinned ? 'mac' : os);
  setAuto(!pinned);
  set(1, STILL[os][reduced ? 1 : 0]);
  if (reduced) still(os, 1);

  fr.querySelectorAll('[data-pick]').forEach(function (b) {
    b.addEventListener('click', function () {
      var sys = b.getAttribute('data-pick');
      setAuto(false);
      if (sys !== os) go(sys, 0);
    });
  });
  fr.querySelectorAll('.fr-ticks button').forEach(function (b) {
    b.addEventListener('click', function () {
      setAuto(false);
      go(b.parentNode.getAttribute('data-for'), Number(b.getAttribute('data-i')) - 1);
    });
  });
  resume.addEventListener('click', function () { setAuto(true); play(0); });
  // The page's own "On a Mac?" link, and #mac from elsewhere on the site.
  window.addEventListener('hashchange', function () {
    if (location.hash !== '#mac') return;
    setAuto(false);
    if (os !== 'mac') go('mac', 0);
  });

  if (reduced) return;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { visible = e.isIntersecting; fr.classList.toggle('is-away', !visible); });
    }, { threshold: 0.2 }).observe(fr);
  } else visible = true;
  setTimeout(function () { play(0); }, 500);
})();
