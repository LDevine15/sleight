import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteTabError } from '../plugins/sleight/lib/tab-errors.mjs';

for (const raw of [
  'Automation is blocking automation because another extension UI is open.',
  'Error: net::ERR_BLOCKED_BY_CLIENT at https://example.invalid/page',
]) test('blocked browser reason receives inventory and owner guidance without retry instructions', () => {
  const out = rewriteTabError(raw);
  assert.ok(out.startsWith(raw));
  assert.match(out, /await cua.listTabs\(\)/);
  assert.match(out, /owner/);
  assert.match(out, /Do not retry/);
  assert.doesNotMatch(out, /\.close\(|\.goto\(|\.reload\(|disable.*extension/i);
});
test('client blocking does not claim that an extension caused it', () => {
  const out = rewriteTabError('Error: net::ERR_BLOCKED_BY_CLIENT');
  assert.match(out, /cause is unconfirmed/);
  assert.doesNotMatch(out, /because.*extension/);
});
test('ordinary caller output and other navigation failures remain unchanged', () => {
  for (const raw of [
    'caller output: Automation is blocking automation because another extension UI is open.',
    'Error: net::ERR_CONNECTION_RESET',
    'caller output\nAutomation is blocking automation because another extension UI is open.',
  ]) assert.equal(rewriteTabError(raw), raw);
});
