'use strict';

// Electron 43 sizes a hidden offscreen window's page from its size on the
// real display, and on a 125% display the rounding skips values: asking for
// 1120 x 760 gives 1121 x 762, and no request gives a page 760 high. That
// leaves a max-width: 1000px media query on the wrong side of a 1000px test.
// So the window is sized close, then the page is pinned to the exact CSS
// viewport with device emulation.
async function fitViewport(win, width, height, settleMs = 60) {
  const contents = win.webContents;
  contents.disableDeviceEmulation();
  win.setContentSize(width, height);
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  let [innerWidth, innerHeight] = await contents.executeJavaScript('[innerWidth, innerHeight]');
  if (innerWidth === width && innerHeight === height) return true;
  contents.enableDeviceEmulation({
    screenPosition: 'desktop',
    screenSize: { width, height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 0,
    viewSize: { width, height },
    scale: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  [innerWidth, innerHeight] = await contents.executeJavaScript('[innerWidth, innerHeight]');
  return innerWidth === width && innerHeight === height;
}

module.exports = { fitViewport };
