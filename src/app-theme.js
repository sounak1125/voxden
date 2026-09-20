/* Shared appearance contract; the flow bar and capture windows keep their theme. */
(function initAppTheme(root) {
  'use strict';
  const normalize = value => value === 'white' ? 'white' : 'voxden';
  // The native caption buttons sit on the title bar, which stays dark in
  // White too: only the content panel changes colour.
  const chrome = value => normalize(value) === 'white'
    ? { background: '#0B0D0E', symbols: '#A9B5AE' }
    : { background: '#101113', symbols: '#a3ada6' };
  const api = { normalize, chrome };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    api.apply = value => {
      const theme = normalize(value);
      if (root.document.documentElement.dataset.appTheme === theme) return theme;
      root.document.documentElement.dataset.appTheme = theme;
      root.document.documentElement.style.colorScheme = theme === 'white' ? 'light' : 'dark';
      return theme;
    };
    api.apply(root.voxden?.initialAppTheme);
    root.VoxdenAppTheme = api;
  }
})(typeof window === 'undefined' ? globalThis : window);
