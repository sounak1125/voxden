/* One effective motion preference for the flow bar and its settings previews.
   Windows remains the default; an explicit choice applies to Voxden's flow
   bar only, so CSS and Canvas never disagree about whether to animate. */
(function initFlowMotion(root) {
  'use strict';

  function normalizePreference(value) {
    return value === 'full' || value === 'reduced' ? value : 'system';
  }

  function createController(media, element) {
    let preference = 'system';
    let systemReduced = !!media.matches;
    const listeners = new Set();
    const controller = {
      normalizePreference,
      get preference() { return preference; },
      get systemReduced() { return systemReduced; },
      get matches() { return preference === 'reduced' || (preference === 'system' && systemReduced); },
      setPreference(value) {
        const next = normalizePreference(value);
        if (next === preference) return;
        preference = next;
        sync(true);
      },
      addEventListener(type, listener) {
        if (type === 'change' && (typeof listener === 'function' || (listener && typeof listener.handleEvent === 'function'))) {
          listeners.add(listener);
        }
      },
      removeEventListener(type, listener) {
        if (type === 'change') listeners.delete(listener);
      },
    };

    function sync(notify) {
      element.dataset.flowMotion = controller.matches ? 'reduced' : 'full';
      if (!notify) return;
      const event = { type: 'change', target: controller, matches: controller.matches,
        preference, systemReduced };
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        if (typeof listener === 'function') listener.call(controller, event);
        else listener.handleEvent(event);
      }
    }

    media.addEventListener('change', () => {
      const next = !!media.matches;
      if (systemReduced === next) return;
      systemReduced = next;
      // The settings explanation must update even when the explicit choice
      // keeps the effective animation state unchanged.
      sync(true);
    });
    sync(false);
    return controller;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { normalizePreference, createController };
  } else if (root.document) {
    root.VoxdenFlowMotion = createController(
      root.matchMedia('(prefers-reduced-motion: reduce)'), root.document.documentElement);
  }
})(typeof window !== 'undefined' ? window : globalThis);
