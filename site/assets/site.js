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
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var restTilt = function (el) {
    el.style.removeProperty('--tilt-x');
    el.style.removeProperty('--tilt-y');
  };
  var pointTilt = function (el, e, maxX, maxY) {
    var r = el.getBoundingClientRect();
    var nx = (e.clientX - r.left) / Math.max(r.width, 1);
    var ny = (e.clientY - r.top) / Math.max(r.height, 1);
    el.style.setProperty('--mx', (nx * 100).toFixed(2) + '%');
    el.style.setProperty('--my', (ny * 100).toFixed(2) + '%');
    el.style.setProperty('--tilt-y', ((nx - 0.5) * maxY).toFixed(2) + 'deg');
    el.style.setProperty('--tilt-x', ((0.5 - ny) * maxX).toFixed(2) + 'deg');
  };
  if (finePointer) {
    doc.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100).toFixed(2) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100).toFixed(2) + '%');
        card.classList.add('is-lit');
        if (card.classList.contains('shot-3d-window')) pointTilt(card, e, 12, 16);
      }, { passive: true });
      card.addEventListener('pointerleave', function () {
        card.classList.remove('is-lit');
        if (card.classList.contains('shot-3d-window')) restTilt(card);
      });
    });
    doc.querySelectorAll('.proof li').forEach(function (item) {
      item.addEventListener('pointermove', function (e) { pointTilt(item, e, 6, 8); }, { passive: true });
      item.addEventListener('pointerleave', function () { restTilt(item); });
    });
    // pointerleave never fires when the page scrolls under a still cursor,
    // on touch, or when a tap opens another page: drop every spotlight then.
    var unlit = function () {
      doc.querySelectorAll('.card.is-lit').forEach(function (c) {
        c.classList.remove('is-lit');
        if (c.classList.contains('shot-3d-window')) restTilt(c);
      });
      doc.querySelectorAll('.proof li').forEach(restTilt);
    };
    window.addEventListener('scroll', unlit, { passive: true });
    doc.addEventListener('pointermove', function (e) {
      if (!(e.target.closest && e.target.closest('.card, .proof li'))) unlit();
    }, { passive: true });
    doc.addEventListener('pointercancel', unlit);
    doc.addEventListener('visibilitychange', unlit);
    window.addEventListener('pagehide', unlit);
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

  /* ---------- hero demo: press, speak, pasted — Pro languages ----------
     Samples rotate through a representative set (scripts + Hinglish). The
     roster under the chrome lists every name from src/asr.js so the 60
     cloud languages plus Hinglish are visible without cycling all 61
     sentences in the hero. */
  var demo = doc.getElementById('demo');
  if (demo) {
    var bar = demo.querySelector('.demo-bar');
    var wave = demo.querySelector('.demo-wave');
    var typed = demo.querySelector('.demo-typed');
    var typedWrap = demo.querySelector('.demo-text');
    var langTag = demo.querySelector('.demo-lang');
    var rosterTrack = demo.querySelector('.demo-roster-track');
    var keys = doc.querySelectorAll('[data-demo-key]');
    var catalog = [
      'English', 'Hinglish', 'Afrikaans', 'Arabic', 'Armenian', 'Assamese', 'Azerbaijani',
      'Bengali', 'Bosnian', 'Bulgarian', 'Cantonese', 'Catalan', 'Chinese', 'Czech',
      'Danish', 'Dutch', 'Estonian', 'Filipino', 'Finnish', 'French', 'Galician',
      'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi', 'Hungarian', 'Icelandic',
      'Indonesian', 'Italian', 'Japanese', 'Kannada', 'Kazakh', 'Korean', 'Latvian',
      'Lithuanian', 'Macedonian', 'Malay', 'Malayalam', 'Marathi', 'Nepali',
      'Norwegian Bokmål', 'Odia', 'Persian', 'Polish', 'Portuguese', 'Punjabi',
      'Romanian', 'Russian', 'Slovak', 'Slovenian', 'Spanish', 'Swahili', 'Swedish',
      'Tamil', 'Telugu', 'Thai', 'Turkish', 'Ukrainian', 'Urdu', 'Vietnamese'
    ];
    var lines = [
      { lang: 'English', dir: 'ltr', text: 'Send this note to the shared channel when you wrap.' },
      { lang: 'Hinglish', dir: 'ltr', text: 'Standup delayed hai, notes baad mein daal dunga.' },
      { lang: 'Hindi', dir: 'ltr', text: 'चाय के बाद वाली मीटिंग आधे घंटे टाल दो।' },
      { lang: 'Spanish', dir: 'ltr', text: 'Adjunta el documento al hilo del proyecto.' },
      { lang: 'French', dir: 'ltr', text: 'Pose un rappel pour relire le brouillon ce soir.' },
      { lang: 'German', dir: 'ltr', text: 'Die Tabelle braucht noch die Zahlen von gestern.' },
      { lang: 'Arabic', dir: 'rtl', text: 'أرسل الملف النهائي قبل نهاية اليوم.' },
      { lang: 'Japanese', dir: 'ltr', text: '明日の朝、リマインダーをセットして。' },
      { lang: 'Korean', dir: 'ltr', text: '초안 저장하고 점심 후에 이어서 쓸게.' },
      { lang: 'Chinese', dir: 'ltr', text: '把这份草稿先存进共享文件夹。' },
      { lang: 'Bengali', dir: 'ltr', text: 'আজকের কাজগুলো লিস্ট করে রাখো।' },
      { lang: 'Tamil', dir: 'ltr', text: 'இன்றைய அஜெண்டாவை அனுப்பிவிடு.' },
      { lang: 'Russian', dir: 'ltr', text: 'Сохрани черновик и закрой вкладку.' },
      { lang: 'Portuguese', dir: 'ltr', text: 'Marca a revisão para depois do almoço.' },
      { lang: 'Turkish', dir: 'ltr', text: 'Taslağı kaydet, akşam bakacağım.' },
      { lang: 'Thai', dir: 'ltr', text: 'บันทึกฉบับร่างไว้ก่อน เดี๋ยวกลับมาแก้' }
    ];
    if (rosterTrack) {
      var rosterHtml = catalog.map(function (name) { return '<span>' + name + '</span>'; }).join('');
      rosterTrack.innerHTML = rosterHtml + rosterHtml;
    }
    var markRoster = function (lang) {
      if (!rosterTrack) return;
      Array.prototype.forEach.call(rosterTrack.children, function (el) {
        el.classList.toggle('is-on', el.textContent === lang);
      });
    };
    var showLang = function (line) {
      langTag.textContent = line.lang;
      langTag.style.animation = 'none';
      void langTag.offsetWidth;
      langTag.style.animation = '';
      if (typedWrap) typedWrap.setAttribute('dir', line.dir || 'ltr');
      markRoster(line.lang);
    };
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
    var demoPaused = false;
    var run = 0;
    var index = 0;
    var waiting = null;
    var demoWait = async function (ms, token) {
      var left = ms;
      while (left > 0 && token === run) {
        if (!visible || doc.hidden || demoPaused) { await sleep(200); continue; }
        var step = Math.min(left, 200);
        await sleep(step);
        left -= step;
      }
      return token === run;
    };

    if (reduced) {
      typed.textContent = lines[0].text;
      showLang(lines[0]);
      setPhase('hold');
    } else {
      var loop = async function (token) {
        while (token === run) {
          if (!visible || doc.hidden || demoPaused) { await sleep(400); continue; }
          var line = lines[index % lines.length];
          index += 1;
          showLang(line);
          setPhase('press');
          pressKeys(true);
          if (!(await demoWait(190, token))) return;
          pressKeys(false);
          setPhase('recording');
          if (!(await demoWait(900, token))) return;
          setPhase('thinking');
          if (!(await demoWait(420, token))) return;
          setPhase('typing');
          typed.textContent = '';
          for (var c = 0; c < line.text.length; c++) {
            if (token !== run) return;
            if (!visible || doc.hidden || demoPaused) { await sleep(200); c -= 1; continue; }
            typed.textContent += line.text[c];
            await sleep(line.text[c] === ' ' ? 12 : 18);
          }
          setPhase('hold');
          waiting = { resolve: null };
          await new Promise(function (resolve) {
            waiting.resolve = resolve;
            var hold = 2600;
            var stepHold = function () {
              if (token !== run) { resolve(); return; }
              if (!visible || doc.hidden || demoPaused) { setTimeout(stepHold, 200); return; }
              hold -= 200;
              if (hold <= 0) resolve();
              else setTimeout(stepHold, 200);
            };
            setTimeout(stepHold, 200);
          });
          waiting = null;
          if (token !== run) return;
          typed.textContent = '';
          if (!(await demoWait(280, token))) return;
        }
      };
      var start = function () { run += 1; loop(run); };
      var nudge = function () {
        var phase = demo.getAttribute('data-phase');
        if (phase === 'hold' && waiting && waiting.resolve) { waiting.resolve(); return; }
        if (phase === 'idle' || phase === 'hold' || !phase) start();
      };
      demo.addEventListener('click', nudge);
      demo.addEventListener('pointerenter', function () { demoPaused = true; });
      demo.addEventListener('pointerleave', function () { demoPaused = false; });
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
