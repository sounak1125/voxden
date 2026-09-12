'use strict';

// Native dialog provides focus containment and keyboard radio navigation.
window.VoxdenOnboarding = (() => {
  const dialog = document.getElementById('model-welcome');
  const choices = document.getElementById('model-welcome-choices');
  const start = document.getElementById('model-welcome-start');
  const later = document.getElementById('model-welcome-later');
  const status = document.getElementById('model-welcome-status');
  const progress = document.getElementById('model-welcome-progress');
  const meter = document.getElementById('model-welcome-meter');
  const pro = document.getElementById('sidebar-pro');
  const names = { parakeet: 'Parakeet v3', 'qwen3-asr': 'Qwen3-ASR', whisper: 'Whisper large-v3' };
  let latest = {}, callbacks, deferred = false, pending = false, finished = false;
  const selected = () => choices.querySelector('input:checked').value;
  const bytesLabel = n => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.ceil(n / 1e6) + ' MB';

  function paint() {
    const state = latest.asrRuntimeState || {};
    const busy = pending || !!latest.asrOperation;
    choices.disabled = busy || finished;
    start.disabled = busy;
    later.disabled = state.status === 'cancelling';
    later.textContent = busy ? 'Cancel download' : finished ? 'Close' : 'Choose later';
    start.textContent = finished ? 'Start dictating' : busy ? 'Setting up…' : 'Download ' + names[selected()];
    progress.hidden = !busy;
    if (Number.isFinite(state.progress)) meter.value = Math.max(0, Math.min(100, state.progress));
    else meter.removeAttribute('value');
    status.classList.toggle('is-error', state.status === 'error');
    status.textContent = finished ? 'Your model is installed. Use ' + (latest.shortcutLabel || 'your dictation shortcut') + ' to start speaking.'
      : busy || ['error', 'cancelled'].includes(state.status) ? state.message || 'Preparing your model…'
      : 'Only your selected model will download. You can switch in Settings later.';
    for (const label of choices.querySelectorAll('[data-model-size]')) {
      const id = label.dataset.modelSize;
      const packId = id === 'parakeet' && latest.asrDevice === 'directml' ? 'parakeet-fp32' : id;
      const model = id === 'whisper' ? latest.asrModel : latest.speechModels?.packs?.find(p => p.id === packId);
      if (model) label.textContent = model.installed ? 'Installed' : bytesLabel(model.downloadBytes || 0);
    }
  }
  function close() {
    deferred = true;
    dialog.close();
    document.getElementById('nav-dictation')?.focus();
  }
  choices.addEventListener('change', paint);
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending && !latest.asrOperation) close(); });
  later.addEventListener('click', async () => {
    if (!pending && !latest.asrOperation) return close();
    later.disabled = true;
    try {
      const next = await window.voxden.cancelAsrRuntime();
      if (next) callbacks.render(next);
    } catch (error) { status.textContent = error.message; }
    finally { later.disabled = false; }
  });
  start.addEventListener('click', async () => {
    if (finished) return close();
    if (pending || latest.asrOperation) return;
    pending = true;
    paint();
    try {
      const next = await window.voxden.setupLocalModel(selected());
      if (next) {
        finished = next.asrRuntimeState?.status === 'installed' && next.modelPlan?.ready === true;
        callbacks.render(next);
      }
    } catch (error) {
      latest = { ...latest, asrRuntimeState: { status: 'error', message: error.message || 'Setup failed. Try again.' } };
    } finally { pending = false; paint(); }
  });
  document.getElementById('sidebar-pro-upgrade').addEventListener('click', () => callbacks.openBilling());
  return {
    render(data, actions) {
      latest = data;
      callbacks = actions;
      pro.hidden = data.account?.plan === 'pro' || data.localModelChosen === false;
      // The sign-in gate comes first; the model choice waits behind it.
      if (data.localModelChosen === false && !deferred && !dialog.open && data.signInRequired !== true) dialog.showModal();
      if (dialog.open) paint();
    },
    open() { deferred = false; finished = false; dialog.showModal(); paint(); },
  };
})();
