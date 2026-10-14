// Disposable headless context only; no signed-in owner page.
// Playwright itself configures owned contexts, so this is not daily-profile qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { DownloadObserver } from '../downloads.mjs';

const playwrightPath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
let skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'real page test is reserved for sleight-arch' :
  !existsSync(playwrightPath) && 'playwright-core is unavailable';
let chromium;
if (!skip) {
  ({ chromium } = await import(pathToFileURL(playwrightPath).href));
  if (!existsSync(chromium.executablePath())) skip = 'disposable Chromium executable is unavailable';
}

test('same-name real downloads stay unattributed without broker causal evidence', { skip }, async t => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  t.after(() => browser.close());
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  const page = await context.newPage();
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/file')) {
      response.setHeader('Content-Disposition', 'attachment; filename="same.txt"');
      response.end('disposable fixture content');
    } else response.end('<!doctype html><p>download fixture</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = new EventEmitter();
  session.sessionId = 'fixture';
  const commands = [];
  session.send = async (...args) => { commands.push(args); return {}; };
  const observer = new DownloadObserver({ session, authorize: async () => true });
  const scope = { browserIncarnation: 'fixture', brokerEpoch: 1, clientSession: 'fixture', turn: 1,
    targetId: 'fixture', leaseGeneration: 1, frameId: 'fixture', documentGeneration: 1, operationSequence: 1, origin };
  try {
    await observer.start();
    await observer.arm(scope, { frameId: 'fixture', causalToken: 'one' });
    await observer.arm({ ...scope, operationSequence: 2 }, { frameId: 'fixture', causalToken: 'two' });
    await context.addCookies([{ name: 'fixture-login', value: 'fixture-only', url: origin }]);
    await page.goto(origin);
    const first = page.waitForEvent('download');
    await page.evaluate(url => { const link = document.createElement('a'); link.href = url; link.download = ''; link.click(); }, `${origin}/file-one`);
    const downloadOne = await first;
    const second = page.waitForEvent('download');
    await page.evaluate(url => { const link = document.createElement('a'); link.href = url; link.download = ''; link.click(); }, `${origin}/file-two`);
    const downloadTwo = await second;
    assert.equal(downloadOne.suggestedFilename(), 'same.txt');
    assert.equal(downloadTwo.suggestedFilename(), 'same.txt');
    // Playwright download handles expose no CDP GUID: never fabricate one from extension IDs.
    assert.equal(observer.records.size, 0);
    assert.deepEqual(commands, []);
    await downloadTwo.cancel();
    assert.equal(await downloadOne.failure(), null);
    assert.equal(observer.nativeSave(scope).next, 'native-save-handoff');
  } finally {
    observer.dispose();
    await new Promise(resolve => server.close(resolve));
  }
});
