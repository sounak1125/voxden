'use strict';

// Guards for the first-run dictation setup.
//
// All four failures these lock are invisible from inside one file. The engine
// picker offered Qwen3-ASR, which the runtime Voxden installs can never satisfy;
// the stored value outlived the option that set it; the setup offer keyed itself
// on the sidecar being dead, so an interrupted download hid the only button that
// could finish it; and the state describing the interruption lived in memory, so
// quitting erased it. Each symptom surfaces layers away from its cause, which is
// exactly the kind of thing that gets re-broken.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const mainSrc = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(SRC, 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(SRC, 'app.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(SRC, 'app.css'), 'utf8');
const sidecarSrc = fs.readFileSync(
  path.join(__dirname, '..', 'sidecar', 'transcribe.py'), 'utf8'
);

let failed = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    console.log('ok ' + name);
    return;
  }
  failed += 1;
  console.error('FAIL ' + name + ' (got ' + actual + ', want ' + expected + ')');
}

// 1. An engine this PC cannot run must not be offered -- but the option is
//    gated on detection, not deleted. Qwen3-ASR works on a Python that carries
//    torch and qwen_asr; it was only ever broken for the people who had neither,
//    and those are the people the unconditional "~3.4 GB" option was sold to.
check(
  'the markup still carries every engine',
  /<option value="whisper"/.test(htmlSrc)
    && /<option value="qwen3-asr"/.test(htmlSrc)
    && /<option value="parakeet"/.test(htmlSrc),
  true
);
check(
  'the sidecar reports what this PC can run, engine by engine',
  /engines\[engine_id\] = bool\(backend_probe\(engine_id\)\["available"\]\)/.test(sidecarSrc),
  true
);
check('and ships it in the check payload', /"engines": engines,/.test(sidecarSrc), true);
check(
  'main forwards it to the renderer',
  /asrEngineAvailable: engineAvailability,/.test(mainSrc),
  true
);

// The gate itself. Whisper is the fallback every engine drops back to, so it can
// never be hidden; Qwen needs a positive report; Parakeet is hidden only on an
// explicit no, so a sidecar that answers nothing does not strip the picker.
const offeredSrc = appSrc.slice(
  appSrc.indexOf('function asrEngineIsOffered'),
  appSrc.indexOf('function syncAsrEngineSelectOptions')
);
// eslint-disable-next-line no-new-func
const asrEngineIsOffered = new Function(offeredSrc + '; return asrEngineIsOffered;')();
check('whisper is always offered', asrEngineIsOffered('whisper', {}), true);
check('whisper survives an explicit no', asrEngineIsOffered('whisper', { whisper: false }), true);
check('qwen is hidden with no report', asrEngineIsOffered('qwen3-asr', {}), false);
check('qwen is hidden on a no', asrEngineIsOffered('qwen3-asr', { 'qwen3-asr': false }), false);
check('qwen appears on a yes', asrEngineIsOffered('qwen3-asr', { 'qwen3-asr': true }), true);
check('parakeet survives silence', asrEngineIsOffered('parakeet', {}), true);
check('parakeet hides on a no', asrEngineIsOffered('parakeet', { parakeet: false }), false);

// Gating the option must not amputate the engine. The backend has to stay, and
// something other than the picker has to be able to reach it -- a Python at a
// path findPython() does not probe is only addressable through the env var.
check('the sidecar still carries the backend', /class QwenBackend:/.test(sidecarSrc), true);
check(
  'and still routes the selected engine to it',
  /requested == "qwen3-asr":\s*\n\s*backend = QwenBackend\(\)/.test(sidecarSrc),
  true
);
// Written as one literal because a loose regex here passes on anything: `||`
// alternates against the empty string and matches every file on earth.
check(
  'the engine keeps an env escape hatch',
  mainSrc.includes(
    'VOXDEN_ASR_ENGINE: process.env.VOXDEN_ASR_ENGINE || settings.asrEngine,'
  ),
  true
);
check(
  'and the sidecar sanitizes whatever arrives in it',
  /return engine if engine in ENGINE_IDS else "whisper"/.test(sidecarSrc),
  true
);
check(
  'asr.js still knows the engine',
  require(path.join(SRC, 'asr.js')).normalizeAsrEngine('qwen3-asr'),
  'qwen3-asr'
);

// A selection the PC cannot honour is corrected rather than left to warn forever.
check(
  'an unrunnable stored engine falls back to whisper',
  /engineAvailability\[settings\.asrEngine\] === false\) \{\s*\n\s*settings\.asrEngine = 'whisper';/.test(mainSrc),
  true
);
check(
  'and the correction is persisted',
  /settings\.asrEngine = 'whisper';\s*\n\s*try \{ saveSettings\(\); \} catch \(_\) \{\}/.test(mainSrc),
  true
);
check(
  'the renderer never points the select at a missing option',
  /asrEngineIsOffered\(stored, data\.asrEngineAvailable\) \? stored : 'whisper'/.test(appSrc),
  true
);

// 2. A retired choice already sitting in settings.json has to be migrated, or
//    the removal above reaches new installs only.
check(
  'truly dead engines are named in one place',
  /RETIRED_ASR_ENGINES = new Set\(\['voxtral'\]\)/.test(mainSrc),
  true
);
check(
  'a retired engine falls back to whisper on load',
  /RETIRED_ASR_ENGINES\.has\([\s\S]{0,80}settings\.asrEngine = 'whisper'/.test(mainSrc),
  true
);
check(
  'the migration is written back to disk',
  /if \(migratedEngine\) \{[\s\S]{0,60}saveSettings\(\)/.test(mainSrc),
  true
);
check('no stale voxtral-only migration remains', /migratedVoxtral/.test(mainSrc), false);

// 3. Engine installed, weights missing: the sidecar starts, so nothing is ever
//    "unavailable" again and the offer used to vanish for good.
check(
  'an interrupted setup still offers to finish',
  /hasRuntime && !hasModel\) return true;/.test(mainSrc),
  true
);
check(
  'a machine with its own working Python is still left alone',
  /return sidecarState === 'unavailable';/.test(mainSrc),
  true
);
check(
  'the banner shows for an offer, not only for a breakage',
  /engineBannerEl\.hidden = !broken && !busy && !offer;/.test(appSrc),
  true
);
check(
  'the resume case does not claim dictation is dead',
  /Setup did not finish/.test(appSrc),
  true
);
check(
  'and its button says what it does',
  /needsEngine \? 'Set up dictation' : 'Finish setup'/.test(appSrc),
  true
);

// 4. A failure the user cannot see after a restart is a failure they cannot act
//    on. Only terminal states are written; the receipts on disk outrank them.
check('the setup state has a file', /function asrSetupStatePath\(\)/.test(mainSrc), true);
check(
  'a finished run is recorded',
  /function saveAsrSetupState\(\)[\s\S]{0,400}writeFileSync\(asrSetupStatePath\(\)/.test(mainSrc),
  true
);
check(
  'progress is not written per percent',
  /status !== 'error' && status !== 'cancelled' && status !== 'installed'\) return;/.test(mainSrc),
  true
);
check(
  'an interrupted run is restored at launch',
  /loadStores\(\);\s*\n\s*loadAsrSetupState\(\);/.test(mainSrc),
  true
);
check(
  'installed receipts outrank a stale failure note',
  /asrRuntimeManager\.installed\(\) && asrModelManager\.installed\(\)\) return;/.test(mainSrc),
  true
);
check(
  'removing the engine clears the note',
  /asr-runtime-remove[\s\S]{0,400}rmSync\(asrSetupStatePath\(\)/.test(mainSrc),
  true
);

// 5. A repair path that does not require the app to be broken first.
for (const id of ['speech-setup-install', 'speech-setup-cancel', 'speech-setup-remove']) {
  check('settings has #' + id, htmlSrc.includes('id="' + id + '"'), true);
}
check(
  'the card renders on every payload',
  /renderSpeechSetup\(data\);/.test(appSrc),
  true
);
check(
  'download is wired',
  /speechSetupInstallBtn\.addEventListener[\s\S]{0,300}installAsrRuntime\(\)/.test(appSrc),
  true
);
check(
  'cancel is wired',
  /speechSetupCancelBtn\.addEventListener[\s\S]{0,300}cancelAsrRuntime\(\)/.test(appSrc),
  true
);
// removeAsrRuntime shipped in preload for three releases with no caller.
check(
  'remove is wired',
  /speechSetupRemoveBtn\.addEventListener[\s\S]{0,900}removeAsrRuntime\(\)/.test(appSrc),
  true
);
check(
  'removing 3.2 GB asks first',
  /speechSetupRemoveBtn\.addEventListener[\s\S]{0,700}window\.confirm\(/.test(appSrc),
  true
);
// The prompt is modal to the handler but not to the button, so a second click
// while it is open queues a second prompt. Confirming one then leaves a stack
// of identical dialogs to dismiss, which reads as the prompt not going away.
check(
  'the remove button is guarded before the prompt opens',
  /speechSetupRemoveBtn\.addEventListener[\s\S]{0,400}disabled\) return;[\s\S]{0,120}disabled = true;[\s\S]{0,400}window\.confirm\(/.test(appSrc),
  true
);
check(
  'the language pack remove button is guarded too',
  /languagePackRemoveBtn\.disabled\) return;/.test(appSrc),
  true
);
// pip advice is useless to someone who has no Python -- which is exactly the
// state removing the engine leaves them in.
check(
  'a removed engine offers the download rather than a pip command',
  /asrRuntimeWouldHelp[\s\S]{0,200}The speech engine is not installed\./.test(appSrc),
  true
);
check(
  'the card names the Hugging Face fallback it prevents',
  /fetch it from Hugging Face/.test(appSrc),
  true
);
check('the card has styling', /\.speech-setup-card \{/.test(cssSrc), true);

assert.strictEqual(failed, 0, failed + ' asr setup test(s) failed');
console.log('all asr setup tests passed');
