'use strict';

// The sign-in gate. Voxden asks for an account before anything else, so this
// is the first thing a new install shows and the only thing a signed-out one
// shows. Google in the browser, or a six-digit code by email; both land on the
// same account. A native dialog keeps focus inside and Escape does nothing.
window.VoxdenSignIn = (() => {
  const dialog = document.getElementById('signin-gate');
  if (!dialog) return null;
  const $ = (id) => document.getElementById(id);
  const views = { out: $('signin-view-out'), code: $('signin-view-code'), google: $('signin-view-google') };
  const googleBtn = $('signin-google');
  const googleCancelBtn = $('signin-google-cancel');
  const emailInput = $('signin-email');
  const sendBtn = $('signin-send');
  const errorEl = $('signin-error');
  const footEl = $('signin-foot');
  const codeHintEl = $('signin-code-hint');
  const codeInput = $('signin-code');
  const verifyBtn = $('signin-verify');
  const codeErrorEl = $('signin-code-error');
  const backBtn = $('signin-back');
  let latest = {};
  let callbacks = null;
  let busy = false;
  let localError = '';

  function account() {
    return (latest && latest.account) || {};
  }

  function currentView() {
    const a = account();
    if (a.busy === 'google') return 'google';
    if (a.pendingEmail) return 'code';
    return 'out';
  }

  function setError(el, text) {
    el.textContent = text || '';
    el.hidden = !text;
  }

  function paint() {
    const a = account();
    const view = currentView();
    for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
    const working = busy || !!a.busy;
    const error = localError || a.lastError || '';
    const auth = a.auth || null;
    googleBtn.hidden = !!(auth && auth.google === false);
    googleBtn.disabled = working;
    sendBtn.disabled = working;
    sendBtn.textContent = a.busy === 'code' ? 'Sending…' : 'Send me a code';
    emailInput.disabled = working;
    setError(errorEl, view === 'out' ? error : '');
    if (footEl) {
      footEl.textContent = 'No password to remember. A six-digit code arrives by email.';
    }
    codeHintEl.textContent = a.pendingEmail
      ? 'We sent a six-digit code to ' + a.pendingEmail + '. It expires in ten minutes; check spam if it is slow.'
      : '';
    verifyBtn.disabled = working;
    verifyBtn.textContent = a.busy === 'verify' ? 'Signing in…' : 'Sign in';
    codeInput.disabled = working;
    backBtn.disabled = working;
    setError(codeErrorEl, view === 'code' ? error : '');
  }

  async function act(work) {
    if (busy) return;
    busy = true;
    localError = '';
    paint();
    try {
      const next = await work();
      if (next && callbacks) callbacks.render(next);
    } catch (err) {
      localError = (err && err.message) || 'Something went wrong. Try again.';
    } finally {
      busy = false;
      paint();
    }
  }

  googleBtn.addEventListener('click', () => {
    if (!window.voxden || !window.voxden.accountGoogleSignIn) return;
    act(() => window.voxden.accountGoogleSignIn());
  });
  // Cancel runs while the Google attempt is still pending, so it goes around
  // the busy guard; the attempt itself ends with the cancellation.
  googleCancelBtn.addEventListener('click', () => {
    if (!window.voxden || !window.voxden.accountGoogleCancel) return;
    window.voxden.accountGoogleCancel().then((next) => { if (next && callbacks) callbacks.render(next); }).catch(() => {});
  });
  sendBtn.addEventListener('click', () => {
    if (!window.voxden || !window.voxden.accountRequestCode) return;
    act(() => window.voxden.accountRequestCode(emailInput.value));
  });
  emailInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') sendBtn.click(); });
  verifyBtn.addEventListener('click', () => {
    if (!window.voxden || !window.voxden.accountVerifyCode) return;
    act(() => window.voxden.accountVerifyCode('', codeInput.value).then((next) => {
      if (next && next.account && next.account.signedIn) codeInput.value = '';
      return next;
    }));
  });
  codeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') verifyBtn.click(); });
  backBtn.addEventListener('click', () => {
    if (!window.voxden || !window.voxden.accountCancel) return;
    act(() => window.voxden.accountCancel());
  });
  // Escape must not dismiss the gate; there is nothing behind it to use.
  dialog.addEventListener('cancel', (event) => event.preventDefault());

  function open() {
    dialog.showModal();
    paint();
    const view = currentView();
    if (view === 'code') codeInput.focus();
    else if (view === 'out') emailInput.focus({ preventScroll: true });
    // Ask which routes the service offers each time the gate opens, so the
    // Google button steps aside on a service that has none and returns the
    // moment one is configured.
    if (window.voxden && window.voxden.accountAuthOptions) {
      window.voxden.accountAuthOptions().then((next) => { if (next && callbacks) callbacks.render(next); }).catch(() => {});
    }
  }

  return {
    render(data, actions) {
      latest = data || {};
      callbacks = actions || callbacks;
      const required = latest.signInRequired === true;
      if (required && !dialog.open) open();
      else if (!required && dialog.open) { localError = ''; dialog.close(); }
      if (dialog.open) paint();
    },
    isOpen() { return dialog.open; },
  };
})();
