import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { replSetupCode } from '../plugins/sleight/lib/repl-warmup.mjs';
import * as module from '../bench/compat/documentation.mjs';
import * as probe from '../bench/documentation-origin-probe.mjs';
import { openClient } from '../bench/compat/client.mjs';
import * as ownedClient from '../bench/compat/client.mjs';
import { fileURLToPath } from 'node:url';
const receipt = (collected = true) => ({ childCollected: collected, groupCollected: collected, started: true });
const docs = readFileSync(new URL('fixtures/native-api-docs.txt', import.meta.url), 'utf8');
const result = () => ({ content: [{ type: 'text', text: docs }, { type: 'text', text: '[sleight:guard-ready]\n' }] });
test('static format check warns on drift and verifies only the exact API reduction', () => {
  assert.equal(typeof module.checkDocumentationFormat, 'function');
  const ok = module.checkDocumentationFormat(docs);
  assert.equal(ok.status, 'pass');
  assert.equal(ok.removedCharacters, 201);
  assert.equal(ok.policyUnchanged, true);
  assert.equal(ok.outsideFenceUnchanged, true);
  assert.equal(module.checkDocumentationFormat(docs.replace('type Vec2', 'type Vec3')).status, 'warn');
});
test('the no-app probe runs only the fixed existing warmup, records shapes and closes its client', async () => {
  assert.equal(typeof module.documentationBootstrapChecks, 'function');
  const calls = []; let closed = false;
  const checks = await module.documentationBootstrapChecks({ command: 'fake' }, {}, { open: async () => ({
    call: async (name, args, timeout) => { calls.push([name, args, timeout]); return result(); },
    close: async () => { closed = true; return true; },
    cleanupReceipt: () => receipt(),
  }) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'js');
  assert.equal(calls[0][1].code, replSetupCode());
  assert.equal(calls[0][1].timeout_ms, 5000);
  assert.equal(calls[0][2], 6000);
  assert.equal(closed, true);
  assert.equal(checks.status, 'pass');
  assert.equal(checks.items[0].characters, docs.length);
  assert.equal(checks.completed, true);
  assert.equal(checks.policyUnchanged, true);
  assert.deepEqual(checks.cleanup, receipt());
  assert.ok(!JSON.stringify(checks).includes('Unknown runtime policy'));
});
test('prompts, incomplete bootstrap and unproved child cleanup prevent a probe pass', async () => {
  for (const mode of ['prompt', 'empty', 'error', 'cleanup', 'throw', 'abort']) {
    let closed = false;
    const controller = new AbortController();
    const checks = await module.documentationBootstrapChecks({ command: 'fake' }, {}, { signal: controller.signal, open: async options => ({
      call: async () => {
        if (mode === 'throw') throw Error('synthetic failure');
        if (mode === 'abort') controller.abort();
        if (mode === 'prompt') assert.deepEqual(await options.approve({}), { action: 'decline' });
        return mode === 'empty' ? { content: [] } : mode === 'error' ? { ...result(), isError: true } : result();
      },
      close: async () => { closed = true; return mode !== 'cleanup'; },
      cleanupReceipt: () => receipt(mode !== 'cleanup'),
    }) });
    assert.equal(closed, true);
    assert.notEqual(checks.status, 'pass', mode);
  }
});
test('startup failures preserve explicit collection receipts, and absent proof remains uncertain', async () => {
  for (const collected of [true, false, undefined]) {
    const error = Error('startup failed');
    if (collected !== undefined) error.cleanupReceipt = receipt(collected);
    const report = await module.documentationBootstrapChecks({}, {}, { open: async () => { throw error; } });
    assert.equal(report.cleanup?.childCollected, collected === true);
    assert.equal(report.cleanup?.groupCollected, collected === true);
    assert.notEqual(report.status, 'pass');
  }
});
test('the standalone probe releases its lock only after certain child and group collection', async () => {
  assert.equal(typeof probe.runDocumentationOriginProbe, 'function');
  for (const mode of ['collected', 'unproved', 'startup-unknown', 'startup-collected', 'resolve-failed']) {
    let released = false;
    const report = await probe.runDocumentationOriginProbe({
      exists: () => false, lock: async () => async () => { released = true; },
      resolve: () => mode === 'resolve-failed' ? { error: 'absent' } : { command: 'fake' },
      raw: async () => {
        if (mode.startsWith('startup')) {
          const error = Error('startup');
          if (mode === 'startup-collected') error.cleanupReceipt = receipt();
          throw error;
        }
        return { status: 'pass', cleanup: receipt(mode === 'collected') };
      },
    });
    assert.equal(released, ['collected', 'startup-collected', 'resolve-failed'].includes(mode), mode);
    assert.equal(report.lockRetained, !released, mode);
    if (!released) assert.equal(report.status, 'fail');
  }
});
test('the real owned client proves process-group collection and attaches it to startup errors', async () => {
  const fake = fileURLToPath(new URL('fixtures/compat-engine.mjs', import.meta.url));
  const client = await openClient({ command: process.execPath, args: [fake], requireGroupCollection: true,
    graceMs: 20, forceMs: 50 });
  assert.equal(await client.close(), true);
  assert.equal(typeof client.cleanupReceipt, 'function');
  assert.equal(client.cleanupReceipt().childCollected, true);
  assert.equal(client.cleanupReceipt().groupCollected, true);
  await assert.rejects(openClient({ command: process.execPath, args: [fake], env: { ...process.env, COMPAT_FAKE_MODE: 'initialize-hang' },
    requireGroupCollection: true, startupTimeoutMs: 30, graceMs: 20, forceMs: 50 }), error => {
    assert.equal(error.cleanupReceipt?.childCollected, true);
    assert.equal(error.cleanupReceipt?.groupCollected, true);
    return true;
  });
});
test('an abort before opening a client proves that no child needs collection', async () => {
  const controller = new AbortController(); controller.abort();
  const report = await module.documentationBootstrapChecks({}, {}, { signal: controller.signal,
    open: async () => { assert.fail('no process may start after abort'); } });
  assert.equal(report.cleanup?.childCollected, true);
  assert.equal(report.cleanup?.groupCollected, true);
  assert.equal(report.cleanup?.started, false);
});
test('raw capture reports result metadata without treating it as documentation origin', async () => {
  const report = await module.documentationBootstrapChecks({}, {}, { open: async () => ({
    call: async () => ({ ...result(), _meta: { 'codex/nodeReplExecutionDurationMs': 3 } }),
    close: async () => true, cleanupReceipt: () => receipt(),
  }) });
  assert.equal(report.status, 'pass');
  assert.equal(report.removedCharacters, 201);
  assert.deepEqual(report.metadataShape, { 'codex/nodeReplExecutionDurationMs': 'number' });
});
test('closing a leader cannot claim collection while its original child group remains', async () => {
  const fake = fileURLToPath(new URL('fixtures/compat-engine.mjs', import.meta.url));
  const client = await openClient({ command: process.execPath, args: [fake], env: { ...process.env, COMPAT_FAKE_MODE: 'group-child' },
    requireGroupCollection: true, graceMs: 20, forceMs: 50 });
  const collected = await client.close(), cleanup = client.cleanupReceipt();
  assert.equal(cleanup.childCollected, true);
  assert.equal(collected, cleanup.groupCollected);
  if (collected) assert.throws(() => process.kill(-client.pid, 0), { code: 'ESRCH' });
});
test('raw diagnostics pin computer surfaces and disable turbo and hand before resolve and launch', async () => {
  const inherited = { SLEIGHT_TURBO: '1', SLEIGHT_HAND: '1', SLEIGHT_SURFACES: 'browser', CUA_REPL_ENABLED_SURFACES: 'browser' };
  const expected = { SLEIGHT_TURBO: '0', SLEIGHT_HAND: '0', SLEIGHT_SURFACES: 'computer', CUA_REPL_ENABLED_SURFACES: 'computer' };
  let resolved, launched;
  await probe.runDocumentationOriginProbe({ env: inherited, exists: () => false, lock: async () => async () => {},
    resolve: env => { resolved = env; return { command: 'fake', env: inherited }; },
    raw: (server, env) => module.documentationBootstrapChecks(server, env, { open: async options => {
      launched = options.env;
      return { call: async () => result(), close: async () => true, cleanupReceipt: () => receipt() };
    } }),
  });
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(resolved[key], value, `resolve ${key}`);
    assert.equal(launched[key], value, `launch ${key}`);
  }
  assert.equal(inherited.SLEIGHT_TURBO, '1');
});
test('probe errors expose bounded categories without raw error, policy or path text', async () => {
  const cases = [
    ['operation-not-permitted', 'Failed to launch trusted kernel: Operation not permitted /private/secret-path'],
    ['permission-denied', 'Permission denied /private/secret-path'],
    ['sandbox', 'Sandbox launch failed /private/secret-path'],
    ['kernel', 'Kernel reset /private/secret-path'],
    ['native-error-code', 'Native error code: -25204 /private/secret-path'],
    ['unclassified', 'arbitrary failure /private/secret-path'],
  ];
  for (const [expected, message] of cases) for (const caught of [false, true]) {
    const report = await module.documentationBootstrapChecks({}, {}, { open: async () => ({
      call: async () => {
        if (caught) throw Error(message);
        return { isError: true, content: [{ type: 'text', text: message },
          { type: 'text', text: '# Computer Use Confirmations Policy\nPrivate policy text must never appear.' }] };
      },
      close: async () => true, cleanupReceipt: () => receipt(),
    }) });
    assert.equal(report.errorKind, expected, `${expected}, caught=${caught}`);
    assert.doesNotMatch(JSON.stringify(report), /secret-path|Private policy text|arbitrary failure/);
  }
});
test('caught system error codes classify without emitting the code or error path', async () => {
  for (const [code, expected] of [['EPERM', 'operation-not-permitted'], ['EACCES', 'permission-denied'], [-25204, 'native-error-code']]) {
    const report = await module.documentationBootstrapChecks({}, {}, { open: async () => {
      throw Object.assign(Error('hidden private path'), { code, cleanupReceipt: receipt() });
    } });
    assert.equal(report.errorKind, expected);
    assert.doesNotMatch(JSON.stringify(report), /hidden private path|-25204|EPERM|EACCES/);
  }
});
test('strict exited-group collection retries unknown read-only probes within four fifty-millisecond waits', async () => {
  assert.equal(typeof ownedClient.exitedGroupCollected, 'function');
  for (const [states, expected, waits] of [
    [[undefined, undefined, true], true, [50, 50]],
    [[undefined, undefined, undefined, undefined, undefined], false, [50, 50, 50, 50]],
    [[false, undefined, true], true, [20, 50]],
  ]) {
    let calls = 0; const observedWaits = [];
    const result = await ownedClient.exitedGroupCollected(42, {
      probe: pid => { assert.equal(pid, 42); return states[calls++]; },
      wait: async ms => { observedWaits.push(ms); },
    });
    assert.equal(result, expected);
    assert.equal(calls, states.length);
    assert.deepEqual(observedWaits, waits);
  }
});
test('raw structural diagnostics report the exact API fence and safe heading enums', async () => {
  const report = await module.documentationBootstrapChecks({}, {}, { open: async () => ({
    call: async () => result(), close: async () => true, cleanupReceipt: () => receipt(),
  }) });
  assert.deepEqual(report.structure, {
    nativeItemCount: 1, contentTextOnly: true, itemKeysKnown: true,
    apiFenceCount: 1, apiBodyCharacters: 4742,
    apiBodySha256: '646ebda5cf3d1536b0502c6291b59c2a13d1b50b98fc4e0f5fe6d5bb5fc490ab',
    expectedApiHashMatches: true, policyBoundaryPresent: true,
    headingsBeforePolicy: ['Computer Use', 'API', 'Output'], headingsAllowed: true,
    guardReadyCount: 1, guardMarkerMatch: true, formatReasons: [],
  });
});
test('raw structural rejection reports fixed reasons without unknown heading or policy text', async () => {
  for (const [mode, expected] of [['api', 'api-body-hash'], ['heading', 'heading-before-policy'], ['marker', 'guard-marker-mismatch']]) {
    const captured = result();
    if (mode === 'api') captured.content[0].text = docs.replace('type Vec2', 'type Vec3');
    if (mode === 'heading') captured.content[0].text = docs.replace('# Computer Use Confirmations Policy',
      '## /private/unknown-heading-secret\nUnknown private value.\n\n# Computer Use Confirmations Policy');
    if (mode === 'marker') captured.content[1].text = '[sleight:guard-WRONG]\n/private/marker-secret';
    const report = await module.documentationBootstrapChecks({}, {}, { open: async () => ({
      call: async () => captured, close: async () => true, cleanupReceipt: () => receipt(),
    }) });
    assert.ok(report.structure?.formatReasons.includes(expected), mode);
    assert.doesNotMatch(JSON.stringify(report), /unknown-heading-secret|marker-secret|Unknown private value/);
    if (mode === 'api') assert.equal(report.structure.expectedApiHashMatches, false);
    if (mode === 'heading') assert.ok(report.structure.headingsBeforePolicy.includes('unknown-heading'));
    if (mode === 'marker') assert.equal(report.structure.guardMarkerMatch, false);
  }
});
test('private bootstrap title diagnostics are explicit, bounded and omit section bodies and policy headings', async () => {
  const titles = ['Runtime safety notes', 'x'.repeat(160), 'Third heading', 'Fourth heading', 'Fifth heading'];
  const altered = docs.replace('# Computer Use Confirmations Policy',
    titles.map(title => `## ${title}\nprivate-section-body\n`).join('\n') +
    '\n# Computer Use Confirmations Policy\n## Private policy heading');
  const open = async () => ({ call: async () => ({ content: [{ type: 'text', text: altered }, { type: 'text', text: '[sleight:guard-ready]\n' }] }),
    close: async () => true, cleanupReceipt: () => receipt() });
  const report = await module.documentationBootstrapChecks({}, {}, { open, includeUnknownHeadingTitles: true });
  assert.equal(report.removedCharacters, 0, 'product rules remain unchanged');
  assert.equal(report.structure.unknownHeadingTitlesAvailable, true);
  assert.deepEqual(report.structure.unknownHeadingTitles, ['Runtime safety notes', 'x'.repeat(120), 'Third heading', 'Fourth heading']);
  assert.doesNotMatch(JSON.stringify(report), /private-section-body|Private policy heading|Fifth heading/);
  const generic = await module.documentationBootstrapChecks({}, {}, { open });
  assert.equal(Object.hasOwn(generic.structure, 'unknownHeadingTitles'), false);
  assert.doesNotMatch(JSON.stringify(generic), /Runtime safety notes|private-section-body|Private policy heading/);
});
test('standalone raw diagnostics explicitly request heading titles, but unexpected output remains redacted', async () => {
  let selected;
  await probe.runDocumentationOriginProbe({ exists: () => false, lock: async () => async () => {}, resolve: () => ({}),
    raw: async (server, env, options) => { selected = options.includeUnknownHeadingTitles; return { status: 'pass', cleanup: receipt() }; } });
  assert.equal(selected, true);
  const altered = docs.replace('# Computer Use Confirmations Policy', '## Private unknown heading\n\n# Computer Use Confirmations Policy');
  const report = await module.documentationBootstrapChecks({}, {}, { includeUnknownHeadingTitles: true, open: async () => ({
    call: async () => ({ content: [{ type: 'text', text: altered }, { type: 'text', text: 'unexpected app-like output' }] }),
    close: async () => true, cleanupReceipt: () => receipt(),
  }) });
  assert.equal(report.structure.unknownHeadingTitlesAvailable, false);
  assert.deepEqual(report.structure.unknownHeadingTitles, []);
  assert.doesNotMatch(JSON.stringify(report), /Private unknown heading|unexpected app-like output/);
});
test('structural diagnostics allow the exact observed Notes title and reject nearby unknown titles', async () => {
  for (const heading of ['Notes', 'Note', 'Notes extra']) {
    const full = docs.replace('\n# Computer Use Confirmations Policy', `\n## ${heading}\n\nLiteral body remains unchanged.\n\n# Computer Use Confirmations Policy`);
    const report = await module.documentationBootstrapChecks({}, {}, { includeUnknownHeadingTitles: true, open: async () => ({
      call: async () => ({ content: [{ type: 'text', text: full }, { type: 'text', text: '[sleight:guard-ready]\n' }],
        _meta: { 'codex/nodeReplExecutionDurationMs': 0 } }),
      close: async () => true, cleanupReceipt: () => receipt(),
    }) });
    assert.equal(report.removedCharacters, heading === 'Notes' ? 201 : 0);
    assert.equal(report.structure.headingsAllowed, heading === 'Notes');
    assert.ok(report.structure.headingsBeforePolicy.includes(heading === 'Notes' ? 'Notes' : 'unknown-heading'));
    assert.equal(report.policyUnchanged, true);
    assert.equal(report.outsideFenceUnchanged, true);
  }
});
