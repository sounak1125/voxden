(() => {
  'use strict';
  const theme = window.VoxdenAppTheme;
  const cards = [...document.querySelectorAll('.app-theme-card')];
  const status = document.getElementById('app-theme-status');
  let saved = theme.normalize(window.voxden?.initialAppTheme);
  let pending = null, saving = false;
  let displayed;

  function show(value) {
    const selected = theme.normalize(value);
    if (selected === displayed) return;
    displayed = theme.apply(selected);
    for (const card of cards) {
      const checked = card.dataset.appTheme === selected;
      card.setAttribute('aria-checked', String(checked));
      card.tabIndex = checked ? 0 : -1;
    }
    // Only monochrome brand marks change; the original colored SVGs stay intact.
    for (const image of document.querySelectorAll('[data-theme-icon]')) {
      const path = '../assets/hero-apps/' + image.dataset.themeIcon + (selected === 'white' ? '-ink' : '') + '.svg';
      if (image.getAttribute('src') !== path) image.setAttribute('src', path);
    }
    // Paint the palette together: an old dark card must not linger behind new
    // charcoal text. Finish color transitions only; geometry and motion keep
    // their existing clocks, including an in-progress sidebar resize.
    for (const animation of document.getAnimations()) {
      if (typeof animation.transitionProperty === 'string'
          && /color$|shadow$|^(fill|stroke)$/.test(animation.transitionProperty)) animation.finish();
    }
  }

  async function choose(value) {
    const next = theme.normalize(value);
    status.hidden = true;
    if (!saving && next === saved) return;
    pending = next;
    show(next);
    if (saving) return;
    saving = true;
    while (pending !== null) {
      const choice = pending;
      pending = null;
      try {
        const result = await window.voxden.setSettings({ appTheme: choice });
        saved = theme.normalize(result.appTheme);
      } catch (_) {
        if (pending === null) {
          status.textContent = 'Could not save your theme. Your previous theme is still selected.';
          status.hidden = false;
        }
      }
      if (pending === null) show(saved);
    }
    saving = false;
  }

  function render(data) {
    if (!data || data.appTheme === undefined || saving) return;
    saved = theme.normalize(data.appTheme);
    show(saved);
  }
  cards.forEach((card, index) => {
    card.addEventListener('click', () => choose(card.dataset.appTheme));
    card.addEventListener('keydown', event => {
      const key = event.key;
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(key)) return;
      event.preventDefault();
      const next = key === 'Home' ? 0 : key === 'End' ? cards.length - 1
        : (index + (['ArrowRight', 'ArrowDown'].includes(key) ? 1 : -1) + cards.length) % cards.length;
      cards[next].focus({ preventScroll: true });
      choose(cards[next].dataset.appTheme);
    });
  });
  window.voxden?.onAppTheme?.(value => render({ appTheme: value }));
  window.VoxdenThemeSettings = { render };
  show(saved);
})();
