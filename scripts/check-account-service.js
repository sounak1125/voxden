'use strict';

// Public release check. Deliberately ignores the local launcher's environment
// and cached account: a customer's fresh install uses DEFAULT_BASE_URL.
const { DEFAULT_BASE_URL } = require('../src/account');

async function checkAccountService({ fetchImpl = globalThis.fetch, baseUrl = DEFAULT_BASE_URL } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:') throw new Error('The public account service must use HTTPS.');
  const get = async url => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error(url.pathname + ' returned HTTP ' + response.status);
    return response.json();
  };
  const health = await get(new URL('/healthz', base));
  if (health?.ok !== true) throw new Error('The account service health check did not pass.');
  const auth = await get(new URL(base.href.replace(/\/+$/, '') + '/auth/options'));
  if (!auth?.google?.clientId || typeof auth.google.clientId !== 'string') {
    throw new Error('Google sign-in is not configured on the public account service.');
  }
  if (auth?.email?.configured !== true) {
    throw new Error('Email sign-in is not configured on the public account service.');
  }
  return { baseUrl: base.href, healthy: true, googleConfigured: true, emailConfigured: true };
}

if (require.main === module) {
  checkAccountService().then(result => {
    console.log('Public account service is reachable and advertises Google and email sign-in: ' + result.baseUrl);
  }).catch(error => {
    const code = error.cause?.code || error.code;
    console.error('Release blocked: the public account service is not ready at ' + DEFAULT_BASE_URL + '.');
    console.error((code ? code + ': ' : '') + error.message);
    console.error('Deploy the account service, configure DNS/TLS, Google sign-in and email delivery, then retry. Local installers can still be built with npm run dist.');
    process.exitCode = 1;
  });
}

module.exports = { checkAccountService };
