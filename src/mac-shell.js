'use strict';

// The places where Voxden has to behave like a Mac app rather than a Windows
// one, kept out of main.js so each can be checked without Electron. Every
// function takes the platform as an argument and gives Windows exactly what
// main.js did before this file existed.

function isMac(platform) {
  return platform === 'darwin';
}

// Windows gets no application menu at all: null also removes the menu bar
// from its windows. On a Mac the key equivalents Cmd+C, Cmd+V, Cmd+X, Cmd+A
// and Cmd+Z are items of the Edit menu, so an app with no menu has none of
// them in its text fields -- no pasting a sign-in code, a dictionary word or a
// key. The Mac gets the standard app, File (Cmd+W), Edit and Window menus.
function applicationMenuTemplate(platform) {
  if (!isMac(platform)) return null;
  return [{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
}

function deviceName(platform) {
  return isMac(platform) ? 'this Mac' : 'this PC';
}

function pasteKeys(platform) {
  return isMac(platform) ? 'Cmd+V' : 'Ctrl+V';
}

function trayLabels(platform) {
  return isMac(platform)
    ? { launchAtLogin: 'Open at login', quit: 'Quit Voxden' }
    : { launchAtLogin: 'Start with Windows', quit: 'Exit Voxden' };
}

// The menu bar is 22 points tall and draws a status item at up to about 18.
// A single 32-pixel bitmap there comes out oversized or soft on a Retina
// screen, so the Mac icon carries an 18-point 1x and a 36-pixel 2x copy.
const MENU_BAR_POINTS = 18;

function menuBarImage(source, nativeImage) {
  const out = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const px = MENU_BAR_POINTS * scaleFactor;
    const rep = source.resize({ width: px, height: px, quality: 'best' });
    out.addRepresentation({ scaleFactor, width: px, height: px, buffer: rep.toPNG() });
  }
  return out;
}

// A login launch on Windows carries --hidden. macOS 13 and later start login
// items through SMAppService, which passes no arguments, so a Mac asks the
// system whether this launch was one.
function openedAtLogin(app, platform) {
  if (!isMac(platform) || !app || typeof app.getLoginItemSettings !== 'function') return false;
  try {
    return !!app.getLoginItemSettings().wasOpenedAtLogin;
  } catch (_) {
    return false;
  }
}

// macOS asks about the microphone the first time an app records. Asking at
// launch instead puts that question in front of the user before their first
// dictation, rather than failing it. Only an undecided status asks; a refusal
// stands until the user changes it in System Settings.
function askForMicrophone(systemPreferences, platform) {
  if (!isMac(platform) || !systemPreferences) return false;
  try {
    if (systemPreferences.getMediaAccessStatus('microphone') !== 'not-determined') return false;
    const asked = systemPreferences.askForMediaAccess('microphone');
    if (asked && typeof asked.catch === 'function') asked.catch(() => {});
    return true;
  } catch (_) {
    return false;
  }
}

// The paste is a Command+V posted by the helper, which macOS allows only once
// Voxden is ticked in Privacy & Security > Accessibility. True when that is
// why a paste failed; the system's own prompt, which offers to open that
// pane, is raised at the same time.
function pasteNeedsAccessibility(systemPreferences, platform) {
  if (!isMac(platform) || !systemPreferences || typeof systemPreferences.isTrustedAccessibilityClient !== 'function') return false;
  try {
    if (systemPreferences.isTrustedAccessibilityClient(false)) return false;
  } catch (_) {
    return false;
  }
  try { systemPreferences.isTrustedAccessibilityClient(true); } catch (_) {}
  return true;
}

// The flow bar floats over full-screen apps, and for that Electron turns
// Voxden into a menu-bar app with no Dock icon. Showing the dashboard then
// has to bring the app forward itself, or the window opens behind whatever
// the user is in.
function bringForward(app, platform) {
  if (!isMac(platform) || !app || typeof app.focus !== 'function') return;
  try { app.focus({ steal: true }); } catch (_) {}
}

// Where the traffic lights sit on the dashboard's 48-point title bar, so they
// line up with the logo row instead of hugging the top edge.
function trafficLightPosition(platform) {
  return isMac(platform) ? { x: 18, y: 17 } : undefined;
}

module.exports = {
  applicationMenuTemplate,
  deviceName,
  pasteKeys,
  trayLabels,
  menuBarImage,
  MENU_BAR_POINTS,
  openedAtLogin,
  askForMicrophone,
  pasteNeedsAccessibility,
  bringForward,
  trafficLightPosition,
};
