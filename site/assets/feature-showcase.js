/* A scroll chapter tour. Native page scrolling, discrete horizontal previews. */
(() => {
  'use strict';
  const section = document.querySelector('.feature-showcase');
  if (!section) return;
  const story = section.querySelector('.feature-story');
  const chapters = [...section.querySelectorAll('.feature-chapter')];
  const visuals = chapters.map(chapter => chapter.querySelector('.feature-visual'));
  if (!story || chapters.length !== 4 || visuals.some(visual => !visual)) return;

  const desktopMotion = window.matchMedia('(min-width: 981px) and (min-height: 720px) and (prefers-reduced-motion: no-preference)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const stage = document.createElement('div');
  stage.className = 'feature-stage';
  const viewport = document.createElement('div');
  viewport.className = 'feature-stage-viewport';
  const navigation = document.createElement('nav');
  navigation.className = 'feature-stage-navigation';
  navigation.setAttribute('aria-label', 'Product preview chapters');
  chapters.forEach(chapter => {
    const link = document.createElement('a');
    link.href = '#' + chapter.id;
    link.textContent = chapter.dataset.feature;
    navigation.appendChild(link);
  });
  stage.append(viewport, navigation);
  story.appendChild(stage);

  const links = [...section.querySelectorAll('a[href^="#feature-"]')];
  let enhanced = false;
  let visible = false;
  let frame = 0;
  let current = -1;
  let observingScroll = false;
  let stageResize;
  let displayed = -1;
  let requested = 0;
  let slide = null;
  let slideVersion = 0;
  let navigationTarget = null;
  let navigationTimeout = 0;

  function resetSlides(index) {
    const version = ++slideVersion;
    if (slide) slide.animations.forEach(animation => animation.cancel());
    slide = null;
    displayed = index;
    viewport.classList.remove('is-transitioning');
    visuals.forEach((visual, i) => {
      visual.classList.toggle('is-active', i === index);
      visual.style.transform = i === index ? 'translate3d(0, 0, 0)' : 'translate3d(100%, 0, 0)';
      visual.style.visibility = i === index ? 'visible' : 'hidden';
      visual.inert = i !== index;
      if (i === index) visual.removeAttribute('aria-hidden');
      else visual.setAttribute('aria-hidden', 'true');
    });
    return version;
  }

  function showPanel(index, animate = true) {
    requested = index;
    if (!enhanced) return;
    if (!animate || !visible || document.hidden || reducedMotion.matches || displayed < 0) {
      resetSlides(index);
      return;
    }
    if (slide) {
      // Reverse an in-flight pair from its current position rather than jumping
      // back to an endpoint. A third target waits for the short movement to end.
      const reverse = index === slide.from;
      if ((index === slide.from || index === slide.to) && reverse !== slide.reversed) {
        slide.reversed = reverse;
        slide.animations.forEach(animation => animation.reverse());
      }
      return;
    }
    if (index === displayed) return;
    const outgoing = visuals[displayed];
    const incoming = visuals[index];
    const direction = index > displayed ? 1 : -1;
    const version = ++slideVersion;
    incoming.style.visibility = 'visible';
    incoming.style.transform = `translate3d(${direction * 100}%, 0, 0)`;
    visuals.forEach(visual => {
      visual.inert = true;
      visual.setAttribute('aria-hidden', 'true');
    });
    viewport.classList.add('is-transitioning');
    const options = { duration: 480, easing: 'cubic-bezier(.22, .68, .16, 1)', fill: 'forwards' };
    const animations = [
      outgoing.animate([{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${-direction * 100}%, 0, 0)` }], options),
      incoming.animate([{ transform: `translate3d(${direction * 100}%, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }], options)
    ];
    const movement = { animations, from: displayed, to: index, reversed: false };
    slide = movement;
    Promise.all(animations.map(animation => animation.finished)).then(() => {
      if (slideVersion !== version || !enhanced) return;
      const settled = movement.reversed ? movement.from : movement.to;
      resetSlides(settled);
      if (requested !== settled) showPanel(requested);
    }).catch(() => { /* Mode or visibility changes cancel safely at a full panel. */ });
  }

  function markCurrent(index) {
    if (index === current) return;
    current = index;
    // One uninterrupted fill moves directly to the selected chapter, including
    // the full right edge for the final chapter and rapid navigation reversals.
    navigation.style.setProperty('--feature-progress', String((index + 1) / chapters.length));
    chapters.forEach((chapter, i) => chapter.classList.toggle('is-active', i === index));
    if (enhanced) showPanel(index);
    else visuals.forEach((visual, i) => visual.classList.toggle('is-active', i === index));
    links.forEach(link => {
      if (link.hash === '#' + chapters[index].id) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    });
  }

  function sizeStage() {
    if (!enhanced) return;
    // Measure each window at its intrinsic height before filling the shared
    // viewport. Reading a stretched panel would only repeat the previous height.
    visuals.forEach(visual => { visual.style.height = 'auto'; visual.style.bottom = 'auto'; });
    // Round up: a fractional intrinsic height would otherwise clip the bottom
    // border of the tallest window by a pixel once the panels are stretched.
    const height = Math.ceil(Math.max(...visuals.map(visual => visual.getBoundingClientRect().height)));
    viewport.style.setProperty('--feature-preview-height', height + 'px');
    visuals.forEach(visual => { visual.style.removeProperty('height'); visual.style.removeProperty('bottom'); });
    // Center the complete window and chapter controls below the site header,
    // using their actual height so shorter laptop displays keep every link.
    const navHeight = document.querySelector('.nav')?.offsetHeight || 76;
    section.style.setProperty('--feature-stage-height', stage.offsetHeight + 'px');
    const top = Math.max(navHeight + 8, (window.innerHeight - stage.offsetHeight + navHeight) * .5);
    stage.style.setProperty('--feature-stage-top', Math.round(top) + 'px');
  }

  function paint() {
    frame = 0;
    if (!visible || document.hidden) return;
    // Read geometry once before the style writes. Each chapter owns its natural
    // space, so touch scrolling, scrollbars and keyboard page navigation work.
    const focal = window.innerHeight * .5;
    const centers = chapters.map(chapter => {
      const rect = chapter.getBoundingClientRect();
      return rect.top + rect.height * .5;
    });
    let nearest = 0;
    centers.forEach((center, i) => {
      if (Math.abs(center - focal) < Math.abs(centers[nearest] - focal)) nearest = i;
    });
    // A small boundary buffer prevents a trackpad hovering at the midpoint
    // from bouncing the preview back and forth between neighboring chapters.
    if (enhanced && current >= 0 && nearest !== current &&
      Math.abs(centers[nearest] - focal) + 28 > Math.abs(centers[current] - focal)) nearest = current;
    if (navigationTarget !== null) {
      nearest = navigationTarget;
      if (Math.abs(centers[navigationTarget] - focal) < 3) clearNavigationTarget();
    }
    markCurrent(nearest);
  }

  function queuePaint() {
    if (!frame && visible && !document.hidden) frame = window.requestAnimationFrame(paint);
  }

  function syncScrollListener() {
    const needsScroll = visible && !document.hidden;
    if (needsScroll && !observingScroll) {
      window.addEventListener('scroll', queuePaint, { passive: true });
      observingScroll = true;
    } else if (!needsScroll && observingScroll) {
      window.removeEventListener('scroll', queuePaint);
      observingScroll = false;
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    }
    if (!needsScroll && slide) resetSlides(requested);
    queuePaint();
  }

  function setMode() {
    const shouldEnhance = desktopMotion.matches;
    if (shouldEnhance !== enhanced) {
      clearNavigationTarget();
      if (slide) resetSlides(requested);
      enhanced = shouldEnhance;
      // Moving, rather than duplicating, keeps one accessible copy per preview.
      visuals.forEach((visual, i) => {
        if (enhanced) viewport.appendChild(visual);
        else {
          chapters[i].appendChild(visual);
          visual.inert = false;
          visual.removeAttribute('aria-hidden');
          visual.style.removeProperty('transform');
          visual.style.removeProperty('visibility');
        }
      });
      section.classList.toggle('is-scroll-driven', enhanced);
      displayed = -1;
      current = -1;
      markCurrent(0);
    }
    sizeStage();
    queuePaint();
  }

  // Genuine, bounded interaction inside the writing-style preview. Examples
  // illustrate the existing three app tones; no account or microphone access.
  const sampleTones = {
    formal: ['I will send the notes tomorrow. Let me know what you think.', 'Formal'],
    casual: ["I'll send the notes tomorrow. Let me know what you think.", 'Casual'],
    veryCasual: ["i'll send the notes tomorrow. let me know what you think", 'Very casual']
  };
  const toneButtons = [...section.querySelectorAll('[data-feature-tone]')];
  toneButtons.forEach(button => {
    button.addEventListener('click', () => {
      const sample = sampleTones[button.dataset.featureTone];
      if (!sample) return;
      toneButtons.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      const output = section.querySelector('.feature-tone-output');
      output.textContent = sample[0];
      section.querySelector('.feature-tone-label').textContent = sample[1];
      if (!reducedMotion.matches && typeof output.animate === 'function') {
        output.getAnimations().forEach(animation => animation.cancel());
        output.animate([{ opacity: .65, transform: 'translateX(5px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 200, easing: 'ease-out' });
      }
      sizeStage();
    });
  });

  // Native links preserve deep links and keyboard behavior. Align an enhanced
  // chapter's center with the viewport so its matching preview opens reliably.
  function clearNavigationTarget() {
    navigationTarget = null;
    window.clearTimeout(navigationTimeout);
    window.removeEventListener('wheel', clearNavigationTarget);
    window.removeEventListener('touchstart', clearNavigationTarget);
    window.removeEventListener('keydown', interruptNavigation);
  }
  function interruptNavigation(event) {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) clearNavigationTarget();
  }
  links.forEach(link => link.addEventListener('click', event => {
    if (!enhanced || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const chapter = chapters.find(item => '#' + item.id === link.hash);
    if (!chapter) return;
    event.preventDefault();
    clearNavigationTarget();
    navigationTarget = chapters.indexOf(chapter);
    markCurrent(navigationTarget);
    // Suppress intermediate chapter changes during a direct navigation jump.
    // Passive listeners only release that guard if the visitor takes over.
    window.addEventListener('wheel', clearNavigationTarget, { passive: true, once: true });
    window.addEventListener('touchstart', clearNavigationTarget, { passive: true, once: true });
    window.addEventListener('keydown', interruptNavigation);
    navigationTimeout = window.setTimeout(() => { clearNavigationTarget(); queuePaint(); }, 1800);
    history.replaceState(null, '', link.hash);
    chapter.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
  }));

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      syncScrollListener();
    }, { rootMargin: '120px 0px' });
    observer.observe(section);
  } else visible = true;
  if ('ResizeObserver' in window) {
    stageResize = new ResizeObserver(sizeStage);
    visuals.forEach(visual => stageResize.observe(visual));
  }
  desktopMotion.addEventListener('change', setMode);
  window.addEventListener('resize', () => { sizeStage(); queuePaint(); }, { passive: true });
  document.addEventListener('visibilitychange', syncScrollListener);
  setMode();
  syncScrollListener();
})();
