/* The island capsule that confirms a quick action, such as a copy, at the
   bottom of the window and then gets out of the way. */
(function initAppToast(root) {
  'use strict';
  const SHOW_MS = 1900;
  const LEAVE_MS = 220;
  let hideTimer = 0;
  let removeTimer = 0;

  function showAppToast(message) {
    const el = root.document.getElementById('app-toast');
    if (!el) return;
    el.querySelector('.app-toast-text').textContent = String(message || '');
    clearTimeout(hideTimer);
    clearTimeout(removeTimer);
    el.hidden = false;
    el.classList.remove('is-shown', 'is-leaving');
    // A second toast while one shows plays the entrance again.
    void el.offsetWidth;
    el.classList.add('is-shown');
    hideTimer = setTimeout(() => {
      el.classList.add('is-leaving');
      removeTimer = setTimeout(() => {
        el.hidden = true;
        el.classList.remove('is-shown', 'is-leaving');
      }, LEAVE_MS);
    }, SHOW_MS);
  }

  root.showAppToast = showAppToast;
})(window);
