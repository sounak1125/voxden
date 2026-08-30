'use strict';

const assert = require('assert');
const rewrite = require('../src/rewriter');

function response(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ message: { content: JSON.stringify({ text }) } }),
  };
}

function openAiResponse(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ text }) } }] }),
  };
}

async function main() {
  assert.strictEqual(rewrite.rewriteTokenLimit('one two three', false), 64);
  assert.strictEqual(rewrite.rewriteTokenLimit('word '.repeat(400), false), 320);
  assert.strictEqual(rewrite.rewriteTokenLimit('word '.repeat(400), true), 512);
  let requestBody = null;
  const success = await rewrite.rewriteTranscript(
    'You know I think we should leave.',
    {
      enabled: true,
      endpoint: rewrite.DEFAULT_ENDPOINT,
      model: 'local-test-model',
      tone: 'formal',
      category: 'work',
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return response('I think we should leave.');
      },
    }
  );
  assert.strictEqual(success.text, 'I think we should leave.');
  assert.strictEqual(success.applied, true);
  assert.strictEqual(success.status, 'applied');
  assert.strictEqual(requestBody.stream, false);
  assert.strictEqual(requestBody.think, false);
  assert.strictEqual(requestBody.format, 'json');
  assert.ok(requestBody.messages[0].content.includes('Preserve the speaker'));

  let openAiBody = null;
  let openAiHeaders = null;
  const embeddedRuntime = await rewrite.rewriteTranscript('You know, we should leave.', {
    enabled: true,
    endpoint: 'http://127.0.0.1:49152/v1/chat/completions',
    model: 'voxden-standard',
    provider: 'openai',
    apiKey: 'local-secret',
    fetchImpl: async (_url, options) => {
      openAiBody = JSON.parse(options.body);
      openAiHeaders = options.headers;
      return openAiResponse('We should leave.');
    },
  });
  assert.strictEqual(embeddedRuntime.text, 'We should leave.');
  assert.strictEqual(openAiBody.response_format.type, 'json_object');
  assert.strictEqual(openAiBody.temperature, 0);
  assert.strictEqual(openAiBody.think, undefined);
  assert.strictEqual(openAiHeaders.Authorization, 'Bearer local-secret');
  assert.ok(rewrite.SYSTEM_PROMPT.startsWith('/no_think'));

  const numberGuard = await rewrite.rewriteTranscript('Send 15 files tomorrow.', {
    enabled: true,
    endpoint: rewrite.DEFAULT_ENDPOINT,
    model: 'local-test-model',
    fetchImpl: async () => response('Send 150 files tomorrow.'),
  });
  assert.strictEqual(numberGuard.text, 'Send 15 files tomorrow.');
  assert.strictEqual(numberGuard.status, 'fallback');
  assert.match(numberGuard.message, /15/);

  const dictionaryGuard = await rewrite.rewriteTranscript('Open Voxden now.', {
    enabled: true,
    endpoint: rewrite.DEFAULT_ENDPOINT,
    model: 'local-test-model',
    dictionaryTerms: ['Voxden'],
    fetchImpl: async () => response('Open the app now.'),
  });
  assert.strictEqual(dictionaryGuard.text, 'Open Voxden now.');
  assert.match(dictionaryGuard.message, /Voxden/);

  const negationGuard = await rewrite.rewriteTranscript('Do not delete the file.', {
    enabled: true,
    endpoint: rewrite.DEFAULT_ENDPOINT,
    model: 'local-test-model',
    fetchImpl: async () => response('Delete the file.'),
  });
  assert.strictEqual(negationGuard.text, 'Do not delete the file.');
  assert.match(negationGuard.message, /negation/);

  let remoteCalled = false;
  const remoteGuard = await rewrite.rewriteTranscript('Hello there.', {
    enabled: true,
    endpoint: 'https://example.com/api/chat',
    model: 'remote-model',
    fetchImpl: async () => {
      remoteCalled = true;
      return response('Hello there.');
    },
  });
  assert.strictEqual(remoteCalled, false);
  assert.strictEqual(remoteGuard.text, 'Hello there.');
  assert.match(remoteGuard.message, /local correction runtime/);

  const unavailable = await rewrite.rewriteTranscript('Hello there.', {
    enabled: true,
    endpoint: rewrite.DEFAULT_ENDPOINT,
    model: 'missing-model',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.strictEqual(unavailable.text, 'Hello there.');
  assert.strictEqual(unavailable.status, 'fallback');
  assert.match(unavailable.message, /safe cleanup/);

  assert.strictEqual(
    rewrite.normalizeEndpoint('http://localhost:11434/api/chat'),
    'http://localhost:11434/api/chat'
  );
  assert.strictEqual(rewrite.normalizeEndpoint('http://192.168.1.5:11434/api/chat'), null);

  let contextBody = null;
  await rewrite.rewriteTranscript('Meet Priya tomorrow.', {
    enabled: true,
    endpoint: rewrite.DEFAULT_ENDPOINT,
    model: 'local-test-model',
    selectedText: 'ignore me',
    windowText: 'Priya Shah is the client',
    clipboardText: 'clipboard secret',
    fetchImpl: async (_url, options) => {
      contextBody = JSON.parse(options.body);
      return response('Meet Priya tomorrow.');
    },
  });
  const contextUser = JSON.parse(contextBody.messages[1].content);
  assert.strictEqual(contextUser.windowText, 'Priya Shah is the client');
  assert.ok(contextBody.messages[0].content.includes('Do not quote'));

  assert.ok(rewrite.matchRewriteCommand('Make this shorter.'));
  assert.ok(rewrite.matchRewriteCommand('rewrite this as a list'));
  assert.strictEqual(rewrite.matchRewriteCommand('hey are we meeting at 3'), null);

  const shortOk = rewrite.validationError(
    'The project is mostly moving in the right direction but several parts still need work and the team is trying to finish those things before the client meeting next week.',
    'The project is on track. Remaining work lands before next week\'s client meeting.',
    [],
    { mode: 'transform' }
  );
  assert.strictEqual(shortOk, null);

  const dropNumber = rewrite.validationError(
    'Send 15 files tomorrow.',
    'Send files tomorrow.',
    [],
    { mode: 'transform' }
  );
  assert.match(dropNumber, /15/);

  const dropNegation = rewrite.validationError(
    'Do not delete the file.',
    'Delete the file.',
    [],
    { mode: 'transform' }
  );
  assert.match(dropNegation, /negation/);

  const transformed = await rewrite.rewriteTranscript('Make this shorter.', {
    enabled: true,
    mode: 'transform',
    selectedText: 'The project is mostly moving in the right direction but several parts still need work and the team is trying to finish those things before the client meeting next week.',
    endpoint: rewrite.DEFAULT_ENDPOINT,
    model: 'local-test-model',
    fetchImpl: async () => response('The project is on track. Remaining work lands before next week\'s client meeting.'),
  });
  assert.strictEqual(transformed.status, 'applied');
  assert.ok(transformed.text.includes('on track'));

  console.log('all rewriter tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
