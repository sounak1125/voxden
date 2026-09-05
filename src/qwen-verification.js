'use strict';

function validateQwenProbe(probe) {
  if (!probe?.importOk) throw new Error(probe?.error || 'The accelerator could not import PyTorch.');
  if (!probe.tensorProbeOk) throw new Error(probe.error || 'PyTorch could not run on this GPU. Qwen stays on CPU.');
  if (!probe.qwenProbeOk && (!probe.qwenProbePending || probe.qwen_error)) {
    throw new Error(probe.qwen_error || 'The Qwen transcription check failed. Retry the GPU support download to repair it.');
  }
  return {
    importOk: true, tensorProbeOk: true,
    qwenProbeOk: !!probe.qwenProbeOk,
    qwenProbePending: !probe.qwenProbeOk && !!probe.qwenProbePending,
    gpuName: probe.gpuName || probe.gpu_name || '',
    at: new Date().toISOString(),
  };
}

module.exports = { validateQwenProbe };
