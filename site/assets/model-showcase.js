/* The local-model catalogue progressively enhances into a manual tab selector. */
(function () {
  'use strict';
  var showcase = document.getElementById('mdl');
  if (!showcase || !showcase.classList.contains('model-showcase')) return;
  var tablist = showcase.querySelector('.model-tabs');
  var tabs = Array.from(tablist.querySelectorAll('.model-tab'));
  var panels = Array.from(showcase.querySelectorAll('.model-panel'));
  var motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var active = -1;
  var transition = null;

  function select(index, animate) {
    if (index === active || index < 0 || index >= tabs.length) return;
    if (transition) { transition.cancel(); transition = null; }
    active = index;
    showcase.setAttribute('data-model', tabs[index].getAttribute('data-model'));
    showcase.style.setProperty('--model-index', String(index));
    tabs.forEach(function (tab, i) {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
      panels[i].inert = i !== index;
      panels[i].setAttribute('aria-hidden', String(i !== index));
    });
    if (animate && !motion.matches && typeof panels[index].animate === 'function') {
      transition = panels[index].animate([
        { opacity: 0, transform: 'translateY(10px)' },
        { opacity: 1, transform: 'translateY(0)' }
      ], { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    }
  }

  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Choose a speech model');
  tabs.forEach(function (tab, index) {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panels[index].id);
    panels[index].setAttribute('role', 'tabpanel');
    panels[index].setAttribute('aria-labelledby', tab.id);
    panels[index].tabIndex = 0;
    tab.addEventListener('click', function (event) {
      event.preventDefault();
      select(index, true);
    });
    tab.addEventListener('keydown', function (event) {
      var next = index;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else if (event.key === ' ') { event.preventDefault(); select(index, true); return; }
      else return;
      event.preventDefault();
      select(next, true);
      tabs[next].focus({ preventScroll: true });
    });
  });
  // An unenhanced page exposes all four model descriptions as ordinary articles.
  var linkedPanel = panels.findIndex(function (panel) { return '#' + panel.id === window.location.hash; });
  select(linkedPanel < 0 ? 0 : linkedPanel, false);
  showcase.classList.add('is-ready');
  if (typeof motion.addEventListener === 'function') {
    motion.addEventListener('change', function () {
      if (motion.matches && transition) { transition.cancel(); transition = null; }
    });
  }
})();
