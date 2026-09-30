'use strict';

// Start visual fixtures with an explicit preference, independent of the host's
// Accessibility setting. Individual tests still switch to reduced motion.
module.exports = async function motionFixture(win, value = 'no-preference') {
  const debuggerApi = win.webContents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
  await debuggerApi.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value }],
  });
  const reduced = value === 'reduce';
  // CDP resolves before the MediaQueryList event reaches the app controller.
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await win.webContents.executeJavaScript(`
      matchMedia('(prefers-reduced-motion: reduce)').matches === ${reduced}
      && (!window.VoxdenFlowMotion || VoxdenFlowMotion.systemReduced === ${reduced})
    `)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Renderer did not receive the fixture motion preference: ' + value);
};
