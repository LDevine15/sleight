import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { rewriteTabError } from '../plugins/sleight/lib/tab-errors.mjs';

test('unavailable viewport names the capability and a documented discovery read', async () => {
  for (const prefix of ['', 'Error: ']) {
    const raw = prefix + 'Capability is not available: viewport';
    const out = rewriteTabError(raw);
    assert.ok(out.startsWith(raw));
    assert.match(out, /Next: await tab.capabilities.list\(\)/);
    assert.doesNotMatch(out, /setViewport|emulat|\.get\("viewport"\)/);
    let reads = 0;
    const capabilities = new Proxy({ list: async () => { reads++; return []; } }, {
      get(target, key) { if (!(key in target)) throw new Error(`unsupported capability method ${String(key)}`); return target[key]; },
    });
    await runInNewContext('(async () => { await tab.capabilities.list(); })()', { tab: { capabilities } });
    assert.equal(reads, 1);
  }
});
test('unrecognized capabilities and caller prose preserve the original error', () => {
  for (const raw of [
    'Capability is not available: unknown-mode',
    'Capability is not available: ' + 'x'.repeat(1000),
    'caller output: Capability is not available: viewport',
    'caller output\nCapability is not available: viewport',
  ]) assert.equal(rewriteTabError(raw), raw);
});
