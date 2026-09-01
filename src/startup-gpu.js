'use strict';

// The selected Qwen interpreter depends on Electron's GPU report. Starting the
// sidecar before that report resolves permanently chooses CPU for this app
// session, even when a verified CUDA or ROCm pack is installed.
async function startSidecarAfterGpuDetection(detectGpu, startSidecar, notify) {
  await detectGpu();
  startSidecar();
  if (typeof notify === 'function') notify();
}

module.exports = { startSidecarAfterGpuDetection };
