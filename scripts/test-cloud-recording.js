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

function createHarness({ cloud = true, quality = 'auto', sampleRate = 16000, microphone = 'default', transcriber } = {}) {
  const calls = [], parked = [], pasted = [], failures = [], hud = [], events = [];
  const mediaRequests = [];
  let active = 0, maxActive = 0;
  const track = { stop() { events.push('track-stopped'); }, onended: null };
  const node = () => ({ connect() {}, disconnect() {} });
  class FakeAudioContext {
    constructor() { this.state = 'running'; this.sampleRate = sampleRate; }
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
    voxdenSpeechGate: speechGate,
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
      cancelled() { events.push('cancelled'); },
      diag() {},
    } },
  });
  vm.runInContext(captureSource + '\n' + `
    cloudReady = ${!!cloud};
    engineStatus = 'ready';
    dictationQuality = ${JSON.stringify(quality)};
    micDeviceId = ${JSON.stringify(microphone)};
    globalThis.captureHarness = {
      start: () => startCapture('whisper'),
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
  return { ...api, calls, parked, pasted, failures, hud, events, mediaRequests, maxActive: () => maxActive,
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
  const phraseA = join([voice(51200), new Float32Array(6400)]);
  const phraseB = join([voice(51200, 73), new Float32Array(6400)]);
  const tail = voice(2000, 11); // 125ms final word, below the request minimum.

  for (const microphone of ['default', 'test-usb-microphone']) {
    const h = createHarness({ microphone });
    await h.start();
    assert.strictEqual(h.mediaRequests.length, 1, 'capture opens one microphone stream');
    assert.deepStrictEqual(h.mediaRequests[0].audio.deviceId,
      microphone === 'default' ? undefined : { ideal: microphone }, 'capture uses the selected microphone');
    assert.strictEqual(h.mediaRequests[0].video, false);
    await h.discard();
    assert(h.events.includes('track-stopped'), 'discard releases the microphone');
  }

  {
    const h = createHarness();
    const softWord = Float32Array.from(voice(16384), sample => sample * 0.045);
    const sentence = join([voice(25600), softWord, voice(12800, 91)]);
    await h.start();
    h.feedBlocks(sentence, 773);
    await settle();
    assert.strictEqual(h.calls.length, 0, 'soft syllables keep their sentence context');
    h.feedBlocks(new Float32Array(6400));
    await settle();
    assert(h.isCapturing(), 'transcription starts while the user is still recording');
    assert.strictEqual(h.calls.length, 1, 'only the real pause starts a request');
    assertWav(h, h.calls[0].wav, join([sentence, new Float32Array(6400)]),
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
    const provider = createCloudTranscriber({ apiKey: 'test-only', retryWait: async ms => { delays.push(ms); },
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
    assert.strictEqual(h.maxActive(), 1, 'recovery preserves one request at a time');
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
    assert.strictEqual(h.calls.length, 1, 'next cloud request waits for the in-flight one');
    h.calls[0].request.resolve('again');
    await settle();
    assert.strictEqual(h.calls.length, 2, 'queued second phrase starts while still recording');
    assertWav(h, h.calls[1].wav, phraseB, 'second request has no overlapping audio');
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
    await stopping;
    assert.deepStrictEqual(h.pasted, ['again again go'], 'ordered join preserves genuine repeated words');
    assert.strictEqual(h.calls.length, 3, 'no bridge or full-recording re-recognition');
    assert.strictEqual(h.maxActive(), 1, 'variable response times cannot reorder simultaneous cloud requests');
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
    h.calls[0].request.resolve('partial first phrase');
    await settle();
    h.calls[1].request.reject(new Error('cloud service unavailable'));
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
    await settle();
    if (stopping) await stopping;
    assert.strictEqual(h.calls.length, 1, 'cancelled generation cannot start queued cloud requests');
    assert.deepStrictEqual(h.pasted, [], 'cancel prevents late text from pasting');
    assert.deepStrictEqual(h.failures, [], 'cancelled jobs do not produce a transcription error');
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

  console.log('ok cloud recording: live cloud phrases, serialized order, exact audio, final word, failure/cancel, silence, local Auto');
}

main().catch(err => { console.error(err); process.exitCode = 1; });
