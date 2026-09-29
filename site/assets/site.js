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
     A button marked data-release-link="win" or "mac" always offers that
     system's file. An unmarked one offers this visitor's own: the Mac disk
     image on a Mac, the Windows installer everywhere else, and on a Mac it is
     also rewritten to say so. The same marks on data-release-size pick which
     file's size is shown. */
  var isMacVisitor = /Macintosh/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1);
  var APPLE_GLYPH = '<svg class="win-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>';
  function macButton(a, href) {
    var glyph = a.querySelector('.win-glyph');
    if (glyph) glyph.outerHTML = APPLE_GLYPH;
    a.childNodes.forEach(function (n) {
      if (n.nodeType === 3) n.nodeValue = n.nodeValue.replace('Voxden-Setup.exe', 'Voxden.dmg').replace('Windows', 'Mac');
    });
    if (href) a.setAttribute('href', href);
  }
  if (isMacVisitor) {
    doc.querySelectorAll('.nav-cta').forEach(function (a) { macButton(a, '/download#mac'); });
    doc.querySelectorAll('[data-release-link=""]').forEach(function (a) { macButton(a, '/download#mac'); });
    doc.querySelectorAll('[data-release-platform]').forEach(function (el) { el.textContent = 'macOS 12 or later · Apple silicon'; });
  }
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

  /* ---------- the closing's edge glow runs only while it is on screen ---------- */
  if ('IntersectionObserver' in window) {
    var glowIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.target.classList.toggle('is-live', e.isIntersecting); });
    });
    doc.querySelectorAll('.closing').forEach(function (el) { glowIo.observe(el); });
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
