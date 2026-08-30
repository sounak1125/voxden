'use strict';

function suggestionsEnabled(settings) {
  if (!settings || typeof settings !== 'object') return true;
  return settings.suggestionsEnabled !== false;
}

const api = { suggestionsEnabled };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  globalThis.voxdenSuggestions = api;
}
