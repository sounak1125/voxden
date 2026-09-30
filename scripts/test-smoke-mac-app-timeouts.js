'use strict';

// Platform-independent regressions for operations which previously made the
// real packaged-Mac startup check wait forever. No Electron app is launched.
const assert = require('node:assert/strict');
const http = require('node:http');
const { run, fetchTargets } = require('./smoke-mac-app');

async function stalledDiscovery(sendHeaders) {
  const server = http.createServer((_request, response) => {
    if (sendHeaders) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('['); // Headers succeed but the JSON body never finishes.
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const started = Date.now();
    await assert.rejects(fetchTargets(server.address().port, 100), /DevTools discovery.*failed within 100 ms/);
    assert(Date.now() - started < 3000, 'The discovery timeout must cover headers and body');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  const started = Date.now();
  assert.throws(() => run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100), /timed out after 100 ms/);
  assert(Date.now() - started < 3000, 'A hung native tool must be killed within its bound');
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(7)']), /exited 7/);
  assert.equal(run(process.execPath, ['-e', 'process.stdout.write("native-ok")']), 'native-ok');
  await stalledDiscovery(false);
  await stalledDiscovery(true);
  console.log('mac packaged-smoke timeouts: native process, HTTP headers and HTTP body passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
