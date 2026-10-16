import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeArmHooks } from '../bench/arm-hooks.mjs';

// lcu 0.11.2 refuses every call without its PreToolUse identity hook, which its own setup writes to the arm folder's project
// settings; the guarded world arm runs with --setting-sources '' and never loaded it (2026-10-16).
test('an arm keeps the hooks its own setup wrote, beside the bench hooks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'arm-hooks-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'settings.local.json');
  const pre = { matcher: 'mcp__lcu__js|mcp__lcu__js_reset', hooks: [{ type: 'mcp_tool', server: 'lcu', tool: 'set_turn_context' }] };
  writeFileSync(file, JSON.stringify({ permissions: { deny: ['Bash'] }, hooks: { PreToolUse: [pre], Stop: [{ hooks: [] }] } }));
  const bench = { hooks: { PreToolUse: [{ matcher: 'x', hooks: [] }], Elicitation: [{ matcher: '^lcu$', hooks: [] }] }, autoMemoryEnabled: false };
  const merged = mergeArmHooks(bench, file);
  assert.deepEqual(merged.hooks.PreToolUse, [{ matcher: 'x', hooks: [] }, pre]);
  assert.deepEqual(merged.hooks.Stop, [{ hooks: [] }]);
  assert.deepEqual(merged.hooks.Elicitation, bench.hooks.Elicitation);
  assert.equal(merged.permissions, undefined, 'only hooks come across');
  assert.equal(merged.autoMemoryEnabled, false);
  assert.deepEqual(mergeArmHooks(bench, join(dir, 'missing.json')), bench);
});
