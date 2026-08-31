'use strict';

function suggestionsEnabled(settings) {
  if (!settings || typeof settings !== 'object') return true;
  return settings.suggestionsEnabled !== false;
}

// Module-specific, not `api`: app.html loads this into the same global scope as
// metrics.js, and the duplicate const threw before a line of this file ran.
const suggestionsApi = { suggestionsEnabled };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = suggestionsApi;
} else {
  globalThis.voxdenSuggestions = suggestionsApi;
}
