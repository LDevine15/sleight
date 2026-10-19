import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { appleToolsPresent, prepareHandHost } from '../plugins/sleight/lib/direct-browser/host.mjs';

// Compile the shipping sources with the production compiler and an empty SDK module cache.
// No host is launched, so this test cannot show a menu, consent card or hand window.
test('first hand build compiles both shipping helpers from a cold module cache and reports progress', {
  skip: process.platform !== 'darwin' && 'requires macOS', timeout: 610000,
}, async t => {
  assert.equal(await appleToolsPresent(), true, 'Apple tools must be present before invoking xcrun');
  const root = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-hand-cold-')))));
  const cacheRoot = join(root, 'cache'), events = [];
  const result = await prepareHandHost({ cacheRoot, onProgress: event => {
    events.push(event);
    t.diagnostic(JSON.stringify(event));
  } });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.deepEqual(events.filter(e => e.stage === 'compile').map(e => e.helper), ['peer-host', 'consent-host']);
  assert.equal(events.at(-1).status, 'ready');
  assert.equal(events.at(-1).cached, false);
  const key = events.at(-1).key;
  assert.match(key, /^[a-f0-9]{64}$/);
  for (const name of ['peer-host', 'consent-host']) assert.ok(lstatSync(join(cacheRoot, key, name)).size > 1000);
  assert.equal(existsSync(join(cacheRoot, 'build.lock')), false);
  events.length = 0;
  assert.equal((await prepareHandHost({ cacheRoot, onProgress: e => events.push(e) })).status, 'ready');
  assert.equal(events.at(-1).cached, true);
  assert.equal(events.some(e => e.stage === 'compile'), false);
});
