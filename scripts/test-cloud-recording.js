'use strict';

// Exercise the actual renderer capture/transcription functions with synthetic
// microphone PCM and controlled API promises. No window, device or network.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const cloudSegments = require('../src/cloud-segments');
const speechGate = require('../src/speech-gate');
const chunking = require('../src/chunking');
const overlaySource = fs.readFileSync(require.resolve('../src/overlay'), 'utf8');
const { createCloudTranscriber } = require('../server/cloud');

function between(start, end) {
  const from = overlaySource.indexOf(start);
  const to = overlaySource.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, 'overlay test source markers must exist: ' + start);
  return overlaySource.slice(from, to);
}

const captureSource = [
  between('let capturing = false;', 'function recordingTitle('),
  between('let canRetry = false;', '// The cue\'s output device'),
  'let micDeviceId = "default";',
  between('function resetChunkState()', '// --- Wave rendering'),
  between('function mergePcm(chunks)', 'if (btnCancel) {'),
].join('\n');
const cancelSource = between("} else if (s.mode === 'cancel') {", "} else if (s.mode === 'success') {")
  .replace(/^} else if \(s.mode === 'cancel'\) \{/, '');

function voice(length, phase = 0) {
  return Float32Array.from({ length }, (_, i) => Math.sin((i + phase) * 0.07) * 0.2);
}

function join(parts) {
  const result = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Flush promise jobs without arbitrary wall-clock sleeps or timing assertions.
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function createHarness({ cloud = true, quality = 'auto', sampleRate = 16000, microphone = 'default', transcriber, lanes = null, gate = null, hindi = false } = {}) {
  const calls = [], parked = [], pasted = [], failures = [], hud = [], events = [], diagnostics = [];
  const mediaRequests = [], contextOptions = [];
  let active = 0, maxActive = 0;
  const track = { stop() { events.push('track-stopped'); }, onended: null };
  const node = () => ({ connect() {}, disconnect() {} });
  class FakeAudioContext {
    constructor(options) { this.state = 'running'; this.sampleRate = sampleRate; contextOptions.push(options); }
    createMediaStreamSource() { return node(); }
    createAnalyser() { return node(); }
    createScriptProcessor() { return node(); }
    createMediaStreamDestination() { return node(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }
  const context = vm.createContext({
    Float32Array, ArrayBuffer, DataView, console,
    AudioContext: FakeAudioContext,
    navigator: { mediaDevices: { getUserMedia: async options => {
      mediaRequests.push(JSON.parse(JSON.stringify(options)));
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } },
    performance: { now: () => 100 }, setInterval: () => 1, clearInterval() {},
    document: { body: { classList: { contains: () => false } } },
    voxdenCloudSegments: cloudSegments,
    voxdenSpeechGate: gate ? { ...speechGate, ...gate } : speechGate,
    voxdenChunking: {
      ...chunking,
      reconcileChunkTranscripts() { throw new Error('Cloud requested a boundary bridge'); },
      createChunker() { throw new Error('Auto/cloud unexpectedly started local chunking'); },
    },
    setHud(mode, message) { hud.push({ mode, message }); },
    window: { voxden: {
      transcribeLocal(wav, options) {
        const request = deferred();
        active++;
        maxActive = Math.max(maxActive, active);
        calls.push({ wav, options: { ...options }, request });
        events.push('request-' + calls.length);
        if (transcriber) Promise.resolve().then(() => transcriber(wav, options)).then(request.resolve, request.reject);
        return request.promise.finally(() => { active--; });
      },
      parkAudio(wav) { parked.push(wav); events.push('park'); return Promise.resolve(); },
      transcript(text) { pasted.push(text); events.push('paste'); },
      captureFailed(message) { failures.push(message); },
      captureReady() { events.push('capture-ready'); },
      captureEnded() { events.push('capture-ended'); },
      cloudFinishing() { events.push('cloud-finishing'); },
      cancelled() { events.push('cancelled'); },
      diag(name, data) { diagnostics.push({ name, data: { ...data } }); },
    } },
  });
  vm.runInContext(captureSource + '\n' + `
    cloudReady = ${!!cloud};
    cloudDictation = ${JSON.stringify(lanes)};
    cloudHindi = ${!!hindi};
    engineStatus = 'ready';
    dictationQuality = ${JSON.stringify(quality)};
    micDeviceId = ${JSON.stringify(microphone)};
    globalThis.captureHarness = {
      start: () => startCapture('whisper'),
      startHeld: () => startCapture('whisper', true),
      release: () => releaseMediaHold(),
      stop: () => finishCapture(true),
      discard: () => finishCapture(false),
      cancel: () => { const s = { text: 'Cancelled' }; let revealAfterState; ${cancelSource} },
      feed: pcm => processor.onaudioprocess({ inputBuffer: { getChannelData: () => pcm } }),
      isCapturing: () => capturing,
      jobs: () => chunkJobs.length,
      wav: pcm => encodeWav(pcm, OUT_RATE),
    };
  `, context);
  const api = context.captureHarness;
  return { ...api, calls, parked, pasted, failures, hud, events, mediaRequests, contextOptions, diagnostics, maxActive: () => maxActive, active: () => active,
    feedBlocks(pcm, blockSize = 2048) {
      for (let offset = 0; offset < pcm.length; offset += blockSize) api.feed(pcm.subarray(offset, offset + blockSize));
    },
  };
}

function wavBytes(wav) { return Buffer.from(wav); }
function assertWav(h, wav, pcm, message) {
  assert(wavBytes(wav).equals(wavBytes(h.wav(pcm))), message);
}

async function main() {
  // 4.4s of speech and a 704ms pause: past the cloud segment floor and pause.
  const PAUSE = 11264;
  const phraseA = join([voice(70400), new Float32Array(PAUSE)]);
  const phraseB = join([voice(70400, 73), new Float32Array(PAUSE)]);
  const tail = voice(2000, 11); // 125ms final word, below the request minimum.

  for (const microphone of ['default', 'test-usb-microphone']) {
    const h = createHarness({ microphone });
    await h.start();
    assert.strictEqual(h.mediaRequests.length, 1, 'capture opens one microphone stream');
    assert.deepStrictEqual(h.mediaRequests[0].audio.deviceId,
      microphone === 'default' ? undefined : { ideal: microphone }, 'capture uses the selected microphone');
    assert.strictEqual(h.mediaRequests[0].video, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(h.contextOptions)), [{ sampleRate: 16000 }], 'the audio graph runs at the speech models\' rate');
    await h.discard();
    assert(h.events.includes('track-stopped'), 'discard releases the microphone');
  }

  {
    // The microphone opens while other audio is still being paused. What it
    // hears until then is that audio, not the user: never recorded, never sent.
    const h = createHarness();
    await h.startHeld();
    h.feedBlocks(join([phraseA, phraseB]));
    await settle();
    assert.strictEqual(h.calls.length, 0, 'audio heard during the pause never becomes a cloud request');
    assert(!h.events.includes('capture-ready'), 'and the bar is not told it is recording yet');
    h.release();
    assert(h.events.includes('capture-ready'), 'recording is announced the moment the pause is done');
    h.feedBlocks(phraseA);
    await settle();
    assert.strictEqual(h.calls.length, 1);
    assertWav(h, h.calls[0].wav, phraseA, 'the recording starts with the first buffer after the pause, with nothing from before it');
    h.calls[0].request.resolve('after the pause');
    await settle();
    await h.stop();
    assert.deepStrictEqual(h.pasted, ['after the pause']);
    assert.strictEqual(h.calls.length, 1, 'held audio is not sent at stop either');
  }

  {
    const h = createHarness();
    const softWord = Float32Array.from(voice(16384), sample => sample * 0.045);
    const sentence = join([voice(70400), softWord, voice(12800, 91)]);
    await h.start();
    h.feedBlocks(sentence, 773);
    await settle();
    assert.strictEqual(h.calls.length, 0, 'soft syllables keep their sentence context');
    h.feedBlocks(new Float32Array(PAUSE));
    await settle();
    assert(h.isCapturing(), 'transcription starts while the user is still recording');
    assert.strictEqual(h.calls.length, 1, 'only the real pause starts a request');
    assertWav(h, h.calls[0].wav, join([sentence, new Float32Array(PAUSE)]),
      'one request contains the complete phrase, including quiet word endings');
    h.calls[0].request.resolve('keep the complete word');
    await settle();
    await h.stop();
    assert.deepStrictEqual(h.pasted, ['keep the complete word']);
    assert.strictEqual(h.calls.length, 1, 'completed recognition needs no extra request after stop');
  }

  {
    const attempts = new Map(), delays = [];
    let logical = 0, h;
    const provider = createCloudTranscriber({ apiKey: 'test-only', rescueModel: 'none', retryWait: async ms => { delays.push(ms); },
      fetchImpl: async (_url, request) => {
        const audio = JSON.parse(request.body).input_audio.data;
        const index = h.calls.findIndex(call => Buffer.from(call.wav).toString('base64') === audio);
        const count = (attempts.get(index) || 0) + 1;
        attempts.set(index, count);
        if (index === 1 && count <= 2) return { ok: false, status: 429, json: async () => ({ error: { message: 'Busy' } }) };
        return { ok: true, status: 200, json: async () => ({ text: ['keep', 'every', 'word'][index] }) };
      } });
    h = createHarness({ transcriber: async wav => {
      logical++;
      return (await provider.transcribe({ audioBase64: Buffer.from(wav).toString('base64'), format: 'wav' })).text;
    } });
    await h.start();
    h.feedBlocks(join([phraseA, phraseB, tail]));
    await settle();
    await h.stop();
    assert.deepStrictEqual(h.pasted, ['keep every word'], 'two rate limits on the middle segment preserve the whole ordered dictation');
    assert.deepStrictEqual([...attempts], [[0, 1], [1, 3], [2, 1]], 'only the rejected segment is retried, never successful audio');
    assert.deepStrictEqual(delays, [1000, 2000], 'temporary rate limits get increasing backoff');
    assert.strictEqual(logical, 3, 'recovery needs no full-recording resubmission');
    assert.strictEqual(h.maxActive(), 2, 'recovery permits two requests while preserving the concurrency bound');
    assert.deepStrictEqual(h.failures, []);
  }

  {
    const h = createHarness();
    await h.start();
    h.feedBlocks(phraseA);
    await settle();
    assert(h.isCapturing());
    assert.strictEqual(h.calls.length, 1, 'first natural phrase is submitted before stop');
    assert.deepStrictEqual(h.calls[0].options, { park: false, vad: false, cloud: true, segment: true });
    assertWav(h, h.calls[0].wav, phraseA, 'first request contains only the first phrase');

    h.feedBlocks(join([phraseB, tail]), 773);
    await settle();
    assert.strictEqual(h.jobs(), 2, 'ongoing final word stays buffered');
    assert.strictEqual(h.calls.length, 2, 'second phrase starts before the slow first request finishes');
    assertWav(h, h.calls[1].wav, phraseB, 'second request has no overlapping audio');
    // Complete in reverse order: completion order must never become word order.
    h.calls[1].request.resolve('again');
    await settle();
    assert.deepStrictEqual(h.pasted, [], 'partial text is not pasted during recording');

    const stopping = h.stop();
    await settle();
    assert.strictEqual(h.calls.length, 3, 'only remaining tail needs a request at stop');
    assert.strictEqual(h.parked.length, 1, 'full original recording is available for retry/history');
    assertWav(h, h.parked[0], join([phraseA, phraseB, tail]), 'parked audio has no overlap or request padding');
    const padded = new Float32Array(4800);
    padded.set(tail);
    assertWav(h, h.calls[2].wav, padded, 'short final word is retained and padded to the API minimum');
    h.calls[2].request.resolve('go');
    await settle();
    assert.deepStrictEqual(h.pasted, [], 'finished later segments wait for the first phrase');
    h.calls[0].request.resolve('again');
    await stopping;
    assert.deepStrictEqual(h.pasted, ['again again go'], 'ordered join preserves genuine repeated words');
    assert.strictEqual(h.calls.length, 3, 'no bridge or full-recording re-recognition');
    assert.strictEqual(h.maxActive(), 2, 'only two cloud requests run at once');
    const segments = h.diagnostics.filter(item => item.name === 'cloud-segment');
    assert.deepStrictEqual(segments.map(item => item.data.index), [1, 2, 0], 'diagnostics identify out-of-order completions');
    for (const { data } of segments) {
      assert(data.audioMs > 0 && data.queueMs >= 0 && data.requestMs >= 0, 'segment timing is nonnegative');
    }
    const finished = h.diagnostics.find(item => item.name === 'cloud-finish');
    assert.strictEqual(finished.data.segments, 3);
    assert.strictEqual(finished.data.audioMs, Math.round((phraseA.length + phraseB.length + tail.length) / 16));
    assert(finished.data.saveMs >= 0, 'recording-save timing is nonnegative');
    assert.deepStrictEqual(h.failures, []);
  }

  {
    const h = createHarness();
    const briefTail = voice(637, 29); // Quiet 40ms consonant; below the whole-clip speech gate duration.
    await h.start();
    h.feedBlocks(join([phraseA, briefTail]));
    await settle();
    h.calls[0].request.resolve('the first phrase');
    await settle();
    const stopping = h.stop();
    await settle();
    assert.strictEqual(h.calls.length, 2, 'a brief final spoken tail is never discarded by the whole-clip duration gate');
    const padded = new Float32Array(4800);
    padded.set(briefTail);
    assertWav(h, h.calls[1].wav, padded, 'all samples of the final consonant are submitted');
    h.calls[1].request.resolve('ends');
    await stopping;
    assert.deepStrictEqual(h.pasted, ['the first phrase ends']);
  }

  {
    // A word the model marked as cut off at a segment's end is rejoined with
    // the rest of it from the next segment.
    const h = createHarness();
    await h.start();
    h.feedBlocks(join([phraseA, voice(16000, 5)]));
    await settle();
    h.calls[0].request.resolve('I made this with Higgs-');
    const stopping = h.stop();
    await settle();
    h.calls[1].request.resolve('Field today.');
    await stopping;
    assert.deepStrictEqual(h.pasted, ['I made this with Higgsfield today.'], 'a cut word is pasted whole');
  }

  {
    // The model capitalises the first word of every clip, so an ordinary word
    // opening the second piece mid-sentence is lowered; a name is not.
    for (const [first, second, expected] of [
      ["it's on a", 'Like the image.', "it's on a like the image."],
      ['I asked', 'Kunal to send it.', 'I asked Kunal to send it.'],
      ['That was the end.', 'Like the image.', 'That was the end. Like the image.'],
      // A stutter is not a cut word: both pieces stay, and an ordinary word after it is lowered.
      ['when it comes f-', 'For him.', 'when it comes f- for him.'],
      ['I made it with Hig-', 'Higgsfield today.', 'I made it with Hig- Higgsfield today.'],
      ['I made it with Higgs-', 'field today.', 'I made it with Higgsfield today.'],
    ]) {
      const h = createHarness();
      await h.start();
      h.feedBlocks(join([phraseA, voice(16000, 5)]));
      await settle();
      h.calls[0].request.resolve(first);
      const stopping = h.stop();
      await settle();
      h.calls[1].request.resolve(second);
      await stopping;
      assert.deepStrictEqual(h.pasted, [expected], 'the pasted text joins "' + first + '" and "' + second + '" correctly');
    }
  }

  {
    // Under the 4 second floor even a real pause leaves the dictation whole.
    const h = createHarness();
    const brief = join([voice(16000 * 2), new Float32Array(12000), voice(16000, 31)]);
    await h.start();
    h.feedBlocks(brief);
    await settle();
    assert.strictEqual(h.calls.length, 0, 'a dictation under the floor waits for stop, pause or not');
    const stopping = h.stop();
    await settle();
    assert.strictEqual(h.calls.length, 1);
    assertWav(h, h.calls[0].wav, brief, 'and goes up as one clip');
    h.calls[0].request.resolve('a short thought');
    await stopping;
    assert.deepStrictEqual(h.pasted, ['a short thought']);
  }

  {
    const h = createHarness();
    const uninterrupted = voice(16000 * 12);
    await h.start();
    h.feedBlocks(uninterrupted, 4096);
    await settle();
    assert.strictEqual(h.calls.length, 0, 'continuous speech keeps complete context until stop');
    const stopping = h.stop();
    await settle();
    assert.strictEqual(h.calls.length, 1);
    assertWav(h, h.calls[0].wav, uninterrupted, 'continuous speech is recognized as one complete clip');
    h.calls[0].request.resolve('one complete utterance');
    await stopping;
    assert.deepStrictEqual(h.pasted, ['one complete utterance']);
  }

  {
    const h = createHarness();
    await h.start();
    h.feedBlocks(join([phraseA, phraseB, phraseA]));
    await settle();
    h.calls[1].request.reject(new Error('cloud service unavailable'));
    await settle();
    h.calls[0].request.resolve('late partial first phrase');
    await settle();
    await h.stop();
    assert.strictEqual(h.calls.length, 2, 'failure suppresses queued requests and full-recording retries');
    assert.deepStrictEqual(h.pasted, [], 'failed recording never pastes only its successful prefix');
    assert.deepStrictEqual(h.failures, ['cloud service unavailable']);
  }

  for (const duringStop of [false, true]) {
    const h = createHarness();
    await h.start();
    h.feedBlocks(join([phraseA, phraseB, tail]));
    await settle();
    const stopping = duringStop ? h.stop() : null;
    await settle();
    h.cancel(); // Exercise the actual main-state cancel branch, also during transcription.
    h.calls[0].request.resolve('late cancelled words');
    h.calls[1].request.resolve('more cancelled words');
    await settle();
    if (stopping) await stopping;
    assert.strictEqual(h.calls.length, 2, 'cancelled generation cannot start any request beyond the in-flight pair');
    assert.deepStrictEqual(h.pasted, [], 'cancel prevents late text from pasting');
    assert.deepStrictEqual(h.failures, [], 'cancelled jobs do not produce a transcription error');
    assert.strictEqual(h.diagnostics.filter(item => item.name === 'cloud-segment').length, 0,
      'cancelled generation does not publish late segment diagnostics');
  }

  {
    const h = createHarness();
    const silence = new Float32Array(64000);
    await h.start();
    h.feedBlocks(silence);
    await h.stop();
    assert.strictEqual(h.calls.length, 0, 'silence is filtered before any paid cloud request');
    assert.deepStrictEqual(h.pasted, []);
    assert.deepStrictEqual(h.failures, ['No speech']);
  }

  {
    const h = createHarness();
    await h.start();
    h.feedBlocks(join([phraseA, new Float32Array(12000)]));
    await settle();
    h.calls[0].request.resolve('spoken phrase');
    await settle();
    await h.stop();
    assert.strictEqual(h.calls.length, 1, 'silence-only tail does not cause an extra cloud request');
    assert.deepStrictEqual(h.pasted, ['spoken phrase']);
  }

  {
    const h = createHarness();
    const roomTone = Float32Array.from({ length: 12000 }, (_, i) => i % 2 ? 0.0012 : -0.0012);
    for (let i = 211; i < roomTone.length; i += 1499) roomTone[i] = 0.006;
    await h.start();
    h.feedBlocks(join([phraseA, roomTone]));
    await settle();
    h.calls[0].request.resolve('spoken phrase');
    await settle();
    const stopping = h.stop();
    await settle();
    assert.strictEqual(h.calls.length, 1, 'quiet room tone with isolated peaks must not cause a paid tail request');
    await stopping;
    assert.deepStrictEqual(h.pasted, ['spoken phrase'], 'background noise cannot add a hallucinated tail');
    assert.deepStrictEqual(h.failures, []);
  }

  {
    const h = createHarness();
    // 750ms is exactly 25 detection frames; the final voiced samples belong
    // entirely to an incomplete 30ms frame and cannot be ignored when flushing.
    const finalTail = join([new Float32Array(12000), voice(137, 41)]);
    await h.start();
    h.feedBlocks(join([phraseA, finalTail]));
    await settle();
    h.calls[0].request.resolve('spoken phrase');
    await settle();
    assert.strictEqual(h.calls.length, 1, 'unfinished final speech stays buffered until stop');
    const stopping = h.stop();
    await settle();
    assert.strictEqual(h.calls.length, 2, 'audible partial frame after a long pause must survive');
    assertWav(h, h.calls[1].wav, finalTail, 'final incomplete audio frame is retained without duplicating the first phrase');
    h.calls[1].request.resolve('ends');
    await stopping;
    assert.deepStrictEqual(h.pasted, ['spoken phrase ends']);
    assert.deepStrictEqual(h.failures, []);
  }

  {
    const h = createHarness({ cloud: false });
    const recording = join([phraseA, phraseB, tail]);
    await h.start();
    h.feedBlocks(recording);
    await settle();
    assert.strictEqual(h.calls.length, 0, 'local Auto still chooses its model after the complete clip');
    const stopping = h.stop();
    await settle();
    assert.strictEqual(h.calls.length, 1);
    assert.deepStrictEqual(h.calls[0].options, { cloud: false });
    assertWav(h, h.calls[0].wav, recording, 'local Auto receives the full recording');
    h.calls[0].request.resolve('local complete clip');
    await stopping;
    assert.deepStrictEqual(h.pasted, ['local complete clip']);
  }

  // --- Lanes: the relay advertised piece sizes and a body pool for this account.
  const LANES = { lanes: true, minSegmentMs: 4000, silenceMs: 700, longSegmentMs: 45000, longSilenceMs: 300, bodyConcurrency: 4 };
  const answerByPiece = (h, texts) => { for (const call of h.calls) call.request.resolve(texts[call.options.piece]); };

  {
    const h = createHarness({ lanes: LANES });
    await h.start();
    h.feedBlocks(join([phraseA, phraseB, phraseA, phraseB, phraseA, tail]));
    await settle();
    assert.strictEqual(h.calls.length, 4, 'with lanes, four body pieces run at once');
    assert.strictEqual(h.jobs(), 5, 'and the fifth waits its turn');
    assert.deepStrictEqual(h.calls.map(call => call.options),
      [0, 1, 2, 3].map(piece => ({ park: false, vad: false, cloud: true, segment: true, piece, final: false })),
      'each piece tells main its index, and that it is not the tail');
    assert.strictEqual(h.maxActive(), 4, 'never more than the advertised four while the user talks');
    assert(!h.events.includes('cloud-finishing'), 'nothing is hurried while the user talks');

    const stopping = h.stop();
    await settle();
    assert.deepStrictEqual(h.calls.slice(4).map(call => [call.options.piece, call.options.final]), [[5, true], [4, true]],
      'at stop the tail starts at once although the queue is full, then the waiting piece is released as tail');
    assert.strictEqual(h.maxActive(), 6, 'so all six are out together');
    const order = h.events.filter(event => event === 'cloud-finishing' || event === 'park' || event === 'request-5');
    assert.deepStrictEqual(order, ['cloud-finishing', 'park', 'request-5'],
      'main is told the user stopped once the speech gate passed, before the recording is saved');
    assert.strictEqual(h.events.filter(event => event === 'cloud-finishing').length, 1, 'once');
    answerByPiece(h, ['We started on the.', 'Table and then', 'we moved.', 'it over there', 'and', 'that was it.']);
    await stopping;
    assert.deepStrictEqual(h.pasted, ['We started on the Table and then we moved it over there and that was it.'],
      'answers join in piece order, and the stray stops at joins are gone');
    const wait = h.diagnostics.filter(item => item.name === 'cloud-wait').map(item => item.data);
    assert.deepStrictEqual(wait, [{ ms: 0, pendingAtStop: 5, hurried: 4, lanes: true }],
      'cloud-wait: five pieces were out at stop, four of them sent on the body lane');
    assert.deepStrictEqual(h.failures, []);
  }

  {
    // Six pieces still queued at stop, plus the tail, against a relay whose
    // tail pool answers 429 "busy" above four at once: the bar keeps to four,
    // so every piece answers.
    let tailOut = 0, peak = 0;
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const h = createHarness({ lanes: { ...LANES, bodyConcurrency: 1 }, transcriber: async (_wav, options) => {
      if (!options.final) { for (let i = 0; i < 5; i++) await tick(); return 'p' + options.piece; }
      tailOut++;
      peak = Math.max(peak, tailOut);
      try {
        if (tailOut > 4) throw Object.assign(new Error('Too many cloud requests at once.'), { code: 'busy', status: 429 });
        await tick();
        return 'p' + options.piece;
      } finally { tailOut--; }
    } });
    await h.start();
    h.feedBlocks(join([phraseA, phraseB, phraseA, phraseB, phraseA, phraseB, phraseA, tail]));
    await settle();
    assert.strictEqual(h.jobs(), 7, 'one body piece out, six waiting');
    await h.stop();
    assert.deepStrictEqual(h.failures, [], 'no piece met a busy relay');
    assert.strictEqual(peak, 4, 'four tail requests at most');
    assert.deepStrictEqual(h.pasted, ['p0 p1 p2 p3 p4 p5 p6 p7']);
  }

  for (const hindi of [false, true]) {
    // The Hinglish word lists join only for a user who dictates Hinglish or Hindi.
    const h = createHarness({ hindi });
    await h.start();
    h.feedBlocks(join([phraseA, voice(16000, 5)]));
    await settle();
    h.calls[0].request.resolve('Maine khana khaya aur.');
    const stopping = h.stop();
    await settle();
    h.calls[1].request.resolve('Main so gaya tha.');
    await stopping;
    assert.deepStrictEqual(h.pasted, [hindi ? 'Maine khana khaya aur main so gaya tha.' : 'Maine khana khaya aur. Main so gaya tha.'],
      'the bar passes the Hindi flag to the join (' + hindi + ')');
  }

  {
    // A smaller body pool: the tail still never waits behind it.
    const h = createHarness({ lanes: { ...LANES, bodyConcurrency: 2 } });
    await h.start();
    h.feedBlocks(join([phraseA, phraseB, phraseA, tail]));
    await settle();
    assert.strictEqual(h.calls.length, 2, 'the advertised pool of two holds the third piece back');
    const stopping = h.stop();
    await settle();
    assert.deepStrictEqual(h.calls.map(call => [call.options.piece, call.options.final]), [[0, false], [1, false], [3, true], [2, true]]);
    answerByPiece(h, ['one', 'two', 'three', 'four']);
    await stopping;
    assert.deepStrictEqual(h.pasted, ['one two three four']);
  }

  {
    // The relay's piece sizes are used: 2 seconds and a 300ms pause cut a
    // piece that today's 4 second floor would keep whole.
    const short = join([voice(16 * 2500), new Float32Array(16 * 400), voice(16 * 1000, 7)]);
    const legacy = createHarness();
    await legacy.start();
    legacy.feedBlocks(short);
    await settle();
    assert.strictEqual(legacy.calls.length, 0, 'without lanes a 2.5 s phrase waits for stop');
    await legacy.discard();
    const h = createHarness({ lanes: { ...LANES, minSegmentMs: 2000, silenceMs: 300 } });
    await h.start();
    h.feedBlocks(short);
    await settle();
    assert.strictEqual(h.calls.length, 1, 'with the advertised sizes it goes up while the user talks');
    await h.discard();
    assert(!h.events.includes('cloud-finishing'), 'a discarded recording hurries nothing');
  }

  {
    // The whole-clip speech gate throws the recording away: nothing is hurried,
    // the tail is never sent and nothing waiting is released.
    const h = createHarness({ lanes: { ...LANES, bodyConcurrency: 1 }, gate: { analyseSpeech: () => ({ speech: false }) } });
    await h.start();
    h.feedBlocks(join([phraseA, phraseB, tail]));
    await settle();
    assert.strictEqual(h.calls.length, 1);
    await h.stop();
    await settle();
    assert(!h.events.includes('cloud-finishing'), 'a recording the gate rejects is not hurried');
    assert.strictEqual(h.calls.length, 1, 'and neither its tail nor its waiting piece goes up');
    assert.deepStrictEqual(h.failures, ['No speech']);
  }

  for (const duringStop of [false, true]) {
    // Cancel never hurries anything. Once the gate has passed at stop the
    // relay was already told, and a cancel after that sends nothing more.
    const h = createHarness({ lanes: { ...LANES, bodyConcurrency: 1 } });
    await h.start();
    h.feedBlocks(join([phraseA, phraseB, tail]));
    await settle();
    const stopping = duringStop ? h.stop() : null;
    await settle();
    const sent = h.calls.length;
    h.cancel();
    for (const call of h.calls) call.request.resolve('cancelled words');
    await settle();
    if (stopping) await stopping;
    assert.strictEqual(h.events.filter(event => event === 'cloud-finishing').length, duringStop ? 1 : 0,
      duringStop ? 'told once at stop, never again on cancel' : 'a cancel while recording hurries nothing');
    assert.strictEqual(h.calls.length, sent, 'and starts no request');
    assert.deepStrictEqual(h.pasted, []);
  }

  {
    // Without advertised lanes the bar sends exactly what 2.1.10 sent.
    for (const lanes of [null, { ...LANES, lanes: false }]) {
      const h = createHarness({ lanes });
      await h.start();
      h.feedBlocks(join([phraseA, phraseB, phraseA, tail]));
      await settle();
      const stopping = h.stop();
      await settle();
      assert.strictEqual(h.maxActive(), 2, 'two at once');
      for (const call of h.calls) call.request.resolve('word');
      await settle();
      for (const call of h.calls) call.request.resolve('word');
      await stopping;
      assert(h.calls.every(call => !('piece' in call.options) && !('final' in call.options)), 'no piece or final in the options');
      assert(!h.events.includes('cloud-finishing'), 'nothing is hurried');
      assert.deepStrictEqual(h.pasted, ['word word word word']);
      assert.deepStrictEqual(h.diagnostics.filter(item => item.name === 'cloud-wait').map(item => item.data.lanes), [false]);
    }
  }

  console.log('ok cloud recording: bounded parallel phrases, ordered completion, exact audio, timing, final word, failure/cancel, silence, local Auto, lanes');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
