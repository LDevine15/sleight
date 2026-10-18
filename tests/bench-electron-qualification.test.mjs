import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  APPS, CELLS, backgroundEvidence, cellsFor, main, parseArgs, percentile, prepareWorkspace, requiredCells, runQualification,
  scrubReceipt, timingSummary, validateReceipt,
} from '../bench/electron-qualification.mjs';
import { fakeDriver, fakeObserver } from '../bench/electron-qualification-fakes.mjs';

const identity = { pid: 501, pidBirth: 'b1', instance: 'i1', epoch: 1 };
const clock = () => { let t = 1000; return { now: () => t, advance: ms => { t += ms; }, sleep: async ms => { t += ms; } }; };
const temp = t => { const dir = mkdtempSync(join(tmpdir(), 'eq-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const quietIo = (over = {}) => ({ exists: () => false, permission: async () => false, ...over });

function receiptWith(cells, over = {}) {
  return { version: 1, kind: 'electron-qualification', mode: 'live', app: { bundleId: APPS.vscode.bundleId },
    profile: { temporary: true }, cleanup: { confirmed: true, appExited: true, profileRemoved: true, left: [] },
    timings: {}, cells, qualified: false, ...over };
}
const passed = (id, extra = {}) => ({ id, status: 'pass', ms: 5, identity, windows: [{ id: 77, epoch: 1, pid: 501, pidBirth: 'b1' }], ...extra });

test('live runs need --owner-away; dry runs need nothing; both together and unknown options refuse', () => {
  assert.throws(() => parseArgs([]), /OWNER_AWAY_REQUIRED/);
  assert.throws(() => parseArgs(['--dry-run', '--owner-away']), /CONFLICTING_MODE/);
  assert.throws(() => parseArgs(['--owner-away', '--frobnicate']), /INVALID_OPTIONS/);
  assert.throws(() => parseArgs(['--owner-away', '--apps', 'slack']), /UNKNOWN_APP/);
  assert.deepEqual(parseArgs(['--dry-run']).apps, ['vscode']);
  const live = parseArgs(['--owner-away', '--apps', 'vscode,cursor', '--samples', '5']);
  assert.equal(live.mode, 'live');
  assert.deepEqual(live.apps, ['vscode', 'cursor']);
  assert.equal(live.samples, 5);
});

test('background evidence counts fixture-frontmost samples, pointer travel and gaps in the 50 ms sampling', () => {
  const samples = [0, 50, 100, 150, 200].map((t, i) => ({ t: 1000 + t, front: i === 2 ? 501 : 90, x: 10, y: 10 + (i === 4 ? 3 : 0) }));
  const evidence = backgroundEvidence(samples, { startMs: 1000, endMs: 1200, fixturePid: 501 });
  assert.equal(evidence.samples, 5);
  assert.equal(evidence.fixtureFront, 1);
  assert.equal(evidence.pointerMovedPx, 3);
  assert.equal(evidence.covered, true);
  assert.deepEqual(evidence.frontPids, [90, 501]);
  const gap = backgroundEvidence(samples.filter((_, i) => i === 0 || i === 4), { startMs: 1000, endMs: 1200, fixturePid: 501 });
  assert.equal(gap.covered, false);
  assert.equal(backgroundEvidence([], { startMs: 0, endMs: 10, fixturePid: 1 }).covered, false);
});

test('percentiles are nearest rank, and summaries keep the sample count', () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(values, 50), 10);
  assert.equal(percentile(values, 90), 18);
  assert.deepEqual(timingSummary([30, 10, 20]), { n: 3, p50: 20, p90: 30 });
  assert.deepEqual(timingSummary([]), { n: 0, p50: null, p90: null });
});

test('a cell records pass, fail with its code, ms and the identity; an input cell fails without background proof', async () => {
  const c = clock();
  const cells = [
    { id: 'ok', run: async () => { c.advance(7); return { number: 3, unit: 'rows' }; } },
    { id: 'boom', run: async () => { throw new Error('ELECTRON_PARKED: native-modal'); } },
    { id: 'typed', input: true, run: async () => { c.advance(100); return {}; } },
    { id: 'moved', input: true, run: async () => { c.advance(100); return {}; } },
  ];
  const observer = fakeObserver({ now: c.now, fixturePid: () => 501, pointerAt: t => (t > 1150 ? 4 : 0) });
  const receipt = await runQualification({ app: APPS.vscode, cells, driver: fakeDriver({ now: c.now }), observer, io: quietIo(), clock: c });
  const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
  assert.equal(byId.ok.status, 'pass');
  assert.equal(byId.ok.ms, 7);
  assert.equal(byId.ok.number, 3);
  assert.deepEqual(Object.keys(byId.ok.identity).sort(), ['epoch', 'instance', 'pid', 'pidBirth']);
  assert.equal(byId.boom.status, 'fail');
  assert.equal(byId.boom.error, 'ELECTRON_PARKED: native-modal');
  assert.equal(byId.typed.status, 'pass');
  assert.equal(byId.typed.background.fixtureFront, 0);
  assert.equal(byId.moved.status, 'fail');
  assert.match(byId.moved.error, /BACKGROUND_POINTER_MOVED/);
});

test('a hold between cells waits; a macOS permission prompt stops the run unanswered, and cleanup still runs', async () => {
  const c = clock();
  let holds = 2, cleaned = 0, prompted = false;
  const io = quietIo({ exists: path => path === '/tmp/sleight-hold' && holds-- > 0,
    permission: async () => (prompted ? { process: 'UserNotificationCenter', title: 'Allow access?' } : false) });
  const cells = [
    { id: 'first', run: async () => { prompted = true; return {}; } },
    { id: 'second', run: async () => { throw new Error('must not run'); } },
  ];
  const driver = fakeDriver({ now: c.now });
  const cleanup = driver.cleanup;
  driver.cleanup = async () => { cleaned++; return cleanup(); };
  const receipt = await runQualification({ app: APPS.vscode, cells, driver, observer: fakeObserver({ now: c.now }), io, clock: c });
  assert.ok(receipt.heldMs >= 60000);
  assert.equal(receipt.cells[0].status, 'pass');
  assert.equal(receipt.cells[1].status, 'stopped');
  assert.equal(receipt.stopped.reason, 'permission-prompt');
  assert.equal(receipt.stopped.title, 'Allow access?');
  assert.equal(cleaned, 1);
  assert.equal(receipt.qualified, false);
});

test('receipt validation: identity, skips, reused windows, home paths, component time, cleanup and qualified claims', () => {
  const all = requiredCells(APPS.vscode).map(id => passed(id));
  const good = validateReceipt(receiptWith(all));
  assert.deepEqual(good.errors, []);
  assert.equal(good.qualified, true);

  const noIdentity = validateReceipt(receiptWith([...all.slice(1), { ...all[0], identity: { pid: 501, pidBirth: 'b1', epoch: 1 } }]));
  assert.ok(noIdentity.errors.some(e => e.startsWith('CELL_IDENTITY_MISSING')));
  const skipped = validateReceipt(receiptWith([{ id: all[0].id, status: 'skipped' }, ...all.slice(1)]));
  assert.deepEqual(skipped.errors, []);
  assert.equal(skipped.qualified, false);
  assert.ok(skipped.unqualified.some(e => e.startsWith('CELL_SKIPPED')));
  const reused = validateReceipt(receiptWith([...all.slice(1), { ...all[0], windows: [{ id: 77, epoch: 1, pid: 999, pidBirth: 'other' }] }]));
  assert.ok(reused.errors.includes('WINDOW_REUSED:77'));
  const home = validateReceipt(receiptWith(all, { note: 'wrote /Users/someone/x' }));
  assert.ok(home.errors.includes('SECRET_OUTPUT'));
  const secret = validateReceipt(receiptWith(all, { handle: { secret: 'abc' } }));
  assert.ok(secret.errors.includes('SECRET_OUTPUT'));
  const component = validateReceipt(receiptWith(all, { timings: { read: { scope: 'component', warm: { n: 20, p50: 1, p90: 2 } } } }));
  assert.ok(component.errors.includes('COMPONENT_TIME:read'));
  const dirty = validateReceipt(receiptWith(all, { cleanup: { confirmed: false, left: [4242] } }));
  assert.equal(dirty.qualified, false);
  assert.ok(dirty.errors.includes('CLEANUP_UNCONFIRMED'));
  const shared = validateReceipt(receiptWith(all, { profile: { temporary: false } }));
  assert.ok(shared.errors.includes('ISOLATION_FAILED'));
  const claimed = validateReceipt(receiptWith(all.slice(1), { qualified: true }));
  assert.ok(claimed.errors.includes('QUALIFIED_CLAIM_UNSUPPORTED'));
  assert.ok(claimed.unqualified.includes('REQUIRED_CELL_MISSING:' + all[0].id));
  const dry = validateReceipt(receiptWith(all, { mode: 'dry-run' }));
  assert.equal(dry.qualified, false);
  assert.ok(dry.unqualified.includes('DRY_RUN'));
});

test('VS Code needs every cell except the Cursor overlay row; Cursor runs the overlay probe first, then editor cells only', () => {
  const vscode = requiredCells(APPS.vscode);
  assert.ok(!vscode.includes('cursor-overlay'));
  for (const id of ['consent-card', 'connect', 'read', 'background-type', 'click', 'key', 'navigation', 'new-window', 'sheet-parking',
    'revoke', 'disconnect', 'quit', 'terminal-refusal', 'app-key-refusal', 'webview', 'worker-kill', 'host-kill', 'timings', 'contention']) {
    assert.ok(vscode.includes(id), id);
  }
  const cursor = cellsFor(APPS.cursor).map(cell => cell.id);
  assert.equal(cursor[cursor.indexOf('connect') + 1], 'cursor-overlay');
  assert.ok(!cursor.includes('webview') && !cursor.includes('host-kill'));
  assert.ok(cursor.includes('background-type') && cursor.includes('quit'));
  assert.equal(new Set(CELLS.map(cell => cell.id)).size, CELLS.length);
});

test('the harness never answers the debugger card: without the user\'s click the consent cell fails and nothing else runs', async () => {
  const c = clock();
  const driver = fakeDriver({ now: c.now });
  driver.connect = async () => ({ card: { shown: true, by: null, status: 'timeout', scope: null, ms: 120000 } });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now }), io: quietIo(), clock: c });
  const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
  assert.equal(byId['consent-card'].status, 'fail');
  assert.match(byId['consent-card'].error, /CONSENT_NEEDS_OWNER: .*never clicks it/);
  assert.equal(byId.read.status, 'skipped');
  assert.equal(byId.quit.status, 'skipped');
  assert.equal(receipt.consent.harnessClicks, false);
  assert.deepEqual(receipt.consent.cards.map(card => card.status), ['timeout']);
  assert.ok(validateReceipt({ ...receipt, qualified: false, consent: { harnessClicks: true } }).errors.includes('HARNESS_CLICKED_CONSENT'));
});

test('a Cursor overlay that Escape never clears skips the editor cells, which leaves Cursor unqualified', async () => {
  const c = clock();
  const driver = fakeDriver({ now: c.now, app: APPS.cursor, overlay: { present: true, clears: false } });
  const receipt = await runQualification({ app: APPS.cursor, driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }), io: quietIo(), clock: c,
    options: { trials: 2, samples: 2, aliveWaitMs: 0 } });
  const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
  assert.equal(byId['cursor-overlay'].status, 'fail');
  assert.equal(byId['background-type'].status, 'skipped');
  assert.equal(byId.quit.status, 'pass');
  assert.equal(receipt.qualified, false);
});

test('the whole fake VS Code run passes every cell through the five tools, and dry runs never qualify', async () => {
  const c = clock();
  const driver = fakeDriver({ now: c.now });
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }),
    io: quietIo(), clock: c, options: { trials: 3, samples: 4, aliveWaitMs: 0, mode: 'dry-run' } });
  const failed = receipt.cells.filter(cell => cell.status !== 'pass');
  assert.deepEqual(failed.map(cell => `${cell.id}: ${cell.error}`), []);
  const byId = Object.fromEntries(receipt.cells.map(cell => [cell.id, cell]));
  assert.equal(byId['background-type'].number, 3);
  assert.equal(byId['background-type'].detail.otherFront, true);
  assert.equal(byId['new-window'].detail.falseJoins, 0);
  assert.equal(byId['sheet-parking'].detail.staleRefusals, 1);
  assert.equal(byId.revoke.detail.replays, 0);
  assert.deepEqual(byId.contention.detail.map(row => row.busy), [0, 3]);
  assert.deepEqual(byId.contention.detail.map(row => row.cards), [0, 0], 'busy sessions refuse before their card');
  assert.equal(receipt.timings.read.scope, 'tool-call');
  assert.equal(receipt.timings.read.warm.n, 4);
  assert.equal(receipt.timings.read.cold.n, 4, 'cold samples are capped by coldSamples (default 5)');
  assert.equal(byId['host-kill'].detail.refusal, 'ELECTRON_OWNERSHIP_UNRESOLVED');
  assert.ok(driver.calls.every(call => ['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs'].includes(call.name)));
  assert.equal(driver.quitByPidCalls, 1, 'only the host-kill instance needs the pid-owned quit');
  assert.equal(receipt.cleanup.confirmed, true);
  assert.equal(receipt.qualified, false);
  assert.ok(receipt.validation.unqualified.includes('DRY_RUN'));
  assert.deepEqual(receipt.validation.errors, []);
});

test('dry-run main writes a scrubbed receipt and never takes the live lock or launches', async t => {
  const out = temp(t);
  const touched = [];
  const code = await main(['--dry-run', '--out', out, '--samples', '2', '--trials', '2'], {
    io: { exists: path => { touched.push(path); return false; }, permission: async () => false,
      acquireLock: async () => { throw new Error('dry run took the lock'); } },
    log: () => {},
  });
  assert.equal(code, 0);
  const [file] = readdirSync(out);
  const receipt = JSON.parse(readFileSync(join(out, file), 'utf8'));
  assert.equal(receipt.mode, 'dry-run');
  assert.equal(receipt.app.bundleId, 'com.microsoft.VSCode');
  assert.ok(!touched.includes('/tmp/sleight-live.lock'));
});

test('a live run keeps the lock when cleanup is unconfirmed, and releases it once cleanup is confirmed', async () => {
  for (const confirmed of [true, false]) {
    const c = clock();
    let released = 0;
    const driver = fakeDriver({ now: c.now });
    driver.cleanup = async () => ({ confirmed, appExited: confirmed, profileRemoved: confirmed, left: confirmed ? [] : [4242] });
    const code = await main(['--owner-away', '--out', '/nonexistent-never-written', '--samples', '2', '--trials', '2'], {
      io: quietIo({ acquireLock: async () => async () => { released++; } }), clock: c, log: () => {},
      liveRuntime: async () => ({ driverFor: () => driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }), close: async () => {} }),
      write: () => {},
    });
    assert.equal(released, confirmed ? 1 : 0);
    assert.equal(code, 1, 'a live fake run is unqualified either way');
  }
});

test('the live runtime refuses before any launch while an EPV3-4 to 7 interface is missing, and reads codesign fields', async () => {
  const { liveRuntime, missingContract, parseCodesign } = await import('../bench/electron-qualification-live.mjs');
  const exec = async () => { throw new Error('a live command ran'); };
  await assert.rejects(liveRuntime(parseArgs(['--owner-away']), { io: { permission: async () => false } },
    { exec, load: async name => (name === 'snapshot.mjs' ? { invalidateRefs() {} } : Promise.reject(new Error('absent'))) }), /ELECTRON_RUNTIME_MISSING: electron-admin\.mjs, .*nothing was launched/);
  assert.deepEqual(await missingContract(async () => ({ ensureHost() {} })), [
    'electron-runtime.mjs connectAppHost', 'electron-runtime.mjs selectAppConnection', 'electron-runtime.mjs createAppTurn', 'electron-runtime.mjs releaseAppConnection',
    'electron-runtime.mjs runWindowHelper', 'electron-identity.mjs deriveAppInstance', 'worker.mjs createAppTurnRuntime', 'worker.mjs serverAppSecret']);
  assert.deepEqual(parseCodesign('Executable=/x\nAuthority=Developer ID Application: Example (ABC)\nAuthority=Apple Root CA\nCDHash=abc123\nTeamIdentifier=ABC\n'),
    { signer: 'Developer ID Application: Example (ABC)', team: 'ABC', cdhash: 'abc123' });
});

test('scrubbing turns the home path into ~ and the user name into [user]', () => {
  const out = scrubReceipt({ a: '/Users/pat/Library/x', b: ['pat ran', { c: '/Users/pat' }] }, { home: '/Users/pat', user: 'pat' });
  assert.deepEqual(out, { a: '~/Library/x', b: ['[user] ran', { c: '~' }] });
});

test('the workspace has 200 row files, a 1,500-line file and a Markdown file', t => {
  const root = temp(t);
  const files = prepareWorkspace(root);
  assert.equal(readdirSync(join(root, 'rows')).length, 200);
  assert.equal(readFileSync(join(root, 'b-big.txt'), 'utf8').trimEnd().split('\n').length, 1500);
  assert.match(readFileSync(join(root, 'a-notes.md'), 'utf8'), /^# Notes/);
  assert.equal(files.scratch, join(root, 'a-scratch.txt'));
});

test('the native helper samples frontmost and pointer without activating anything, and sends no Apple events', () => {
  const source = readFileSync(new URL('../bench/electron-qualification.js', import.meta.url), 'utf8');
  for (const file of ['electron-qualification.js', 'electron-qualification-live.mjs', 'electron-qualification-worker.mjs', 'electron-qualification.mjs']) {
    const text = readFileSync(new URL('../bench/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /tell application|Application\(['"]|System Events|osascript', \['-e'/, file);
  }
  const emitted = [];
  let t = 0;
  const sandbox = {};
  runInNewContext(source + '\nthis.sampleLoop = sampleLoop;', sandbox);
  sandbox.sampleLoop({ intervalMs: 50, durationMs: 200 }, {
    front: () => 90, pointer: () => ({ x: 1, y: 2 }), stopped: () => false,
  }, { now: () => t, wait: ms => { t += ms; }, emit: value => emitted.push(value) });
  assert.equal(emitted.length, 4);
  assert.deepEqual(JSON.parse(JSON.stringify(emitted[0])), { t: 0, front: 90, x: 1, y: 2 });
});

// H2: the recipe the driver writes is one the registry and instanceFromRecipe accept for the same bundle.
test('the driver\'s recipe passes the registry and matches the bundle the runtime derives', async t => {
  const { recipeFromBundle } = await import('../bench/electron-qualification-live.mjs');
  const { deriveAppInstance } = await import('../plugins/sleight/lib/direct-browser/electron-identity.mjs');
  const { readRecipeRegistry, recipeFor, instanceFromRecipe } = await import('../plugins/sleight/lib/direct-browser/electron-recipes.mjs');
  const bundle = '/Applications/Visual Studio Code.app', executable = bundle + '/Contents/MacOS/Code';
  const inspect = () => ({ verified: true, codesign: { executable, identifier: 'com.microsoft.VSCode', cdhash: 'c'.repeat(40), team: 'UBF8T346G9',
    authority: 'Developer ID Application: Microsoft Corporation (UBF8T346G9)' }, electron: { CFBundleVersion: '39.2.3' },
    info: { CFBundleIdentifier: 'com.microsoft.VSCode', CFBundleName: 'Code', CFBundleShortVersionString: '1.105.0' } });
  const profile = '/private/tmp/eq/profiles/com.microsoft.VSCode';
  const derived = deriveAppInstance({ bundle, executable, profile, temporary: true, pid: 1, pidBirth: 'recipe' }, { inspect });
  const recipe = recipeFromBundle({ app: APPS.vscode, derived, executable, sha256: 'a'.repeat(64), bundlePath: bundle, workspace: '/private/tmp/eq/workspace' });
  assert.equal(recipe.signer, 'UBF8T346G9', 'the team id, not the Authority line');
  assert.equal(recipe.runtime, 'electron/39.2.3');
  assert.equal(recipe.cdhash, 'c'.repeat(40));
  const dir = temp(t), path = join(dir, 'recipes.json');
  (await import('node:fs')).writeFileSync(path, JSON.stringify({ version: 1, recipes: [recipe] }));
  const row = recipeFor(readRecipeRegistry(path), 'com.microsoft.VSCode');
  assert.equal(instanceFromRecipe(row, { profile, temporary: true, inspect }).pid, 0, 'no RECIPE_BUILD_CHANGED');
});

// H1, F2: the live worker composes a turn the installed worker's way and takes the app host's secret from its parent only.
test('the live worker uses the installed path: connectAppHost with the parent\'s secret, createAppTurn, createAppTurnRuntime', () => {
  const worker = readFileSync(new URL('../bench/electron-qualification-worker.mjs', import.meta.url), 'utf8');
  for (const call of ['runtimeMod.connectAppHost(', 'secret: msg.appSecret', 'runtimeMod.selectAppConnection(', 'windows: b.runtimeMod.runWindowHelper',
    'profile: b.host.profile', 'runtimeMod.createAppTurn(', 'workerMod.createAppTurnRuntime(', 'releaseAppConnection(']) assert.ok(worker.includes(call), call);
  for (const shortcut of ['ensureHost(', 'adminSecret', 'createAppRunners(', 'createAppSnapshot(', 'snapshotMod.snapshot']) assert.ok(!worker.includes(shortcut), shortcut);
  const live = readFileSync(new URL('../bench/electron-qualification-live.mjs', import.meta.url), 'utf8');
  assert.ok(live.includes('serverAppSecret()'), 'the driver holds the secret the way the MCP server does');
  assert.ok(!/adminSecret|randomBytes\(32\)/.test(live), 'and never makes its own');
});

// L3: the written receipt is the scrubbed one, so a home path in an error is not a secret in it.
test('a home path in a cell error is scrubbed before the receipt\'s secret check', async () => {
  const c = clock();
  const driver = fakeDriver({ now: c.now });
  driver.ownerInstances = async () => { throw Error('ENOENT: /Users/pat/Library/Application Support/Code'); };
  const receipt = await runQualification({ app: APPS.vscode, driver, observer: fakeObserver({ now: c.now, fixturePid: () => driver.identity()?.pid }),
    io: quietIo(), clock: c, options: { trials: 2, samples: 2, aliveWaitMs: 0, mode: 'dry-run' } });
  assert.match(receipt.cells.find(cell => cell.id === 'new-window').error, /ENOENT/);
  assert.ok(!receipt.validation.errors.includes('SECRET_OUTPUT'), receipt.validation.errors.join(' '));
  assert.ok(validateReceipt(receiptWith([], { note: '/Users/pat/x' })).errors.includes('SECRET_OUTPUT'), 'an unscrubbed path still fails');
});
