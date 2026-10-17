import { test, after } from 'node:test';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedCode, GUARD_MARK, GUARD_OMIT_MARK, GUARD_END, sameElement } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';

const expected = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };
const tree = (window = expected, rows = '\t1 button Save, ID: Save') =>
  `Window: ${JSON.stringify(window.title)}, App: ${window.app}.\n0 standard window${window.url ? `, URL: ${window.url}` : ''}\n${rows}`;
// Obtain the ordinary native options from the relay, so the default tests exercise its routing.
const leaseDir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-guard-default-')));
after(() => removeTemp(leaseDir));
function defaultOptions() {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(line => JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory: leaseDir, holder: 'default-test' }) });
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  try {
    call(1, 'let app = await cua.getApp("TextEdit")');
    serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: tree() }],
      _meta: { 'codex/toolSurface': { app: { appId: 'fixture.app' } } } } }) + '\n');
    call(2, 'await app.typeText("x");');
    const code = sent.find(message => message.id === 2)?.params.arguments.code ?? '';
    const update = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(code)?.[1] ?? '{}');
    return Object.fromEntries(['firstOff', 'focused', 'quietEdits', 'bind'].map(key => [key, update[key]]));
  } finally { relay.dispose(); }
}

function fixture({ current = () => tree(), action = () => {}, screenshotState, strict = false, ordinary = false } = {}) {
  const calls = [], output = [];
  const raw = {
    async getAXState(options) { calls.push(['read', options]); return current(); },
    async getAXStateAndScreenshot(options) {
      calls.push(['both', options]);
      const state = screenshotState ? screenshotState(options) : current();
      if (options?.emit !== false) output.push(state);
      return { state, screenshot: new Uint8Array([1, 2, 3]) };
    },
    async getScreenshot() { calls.push(['screenshot']); return new Uint8Array([1]); },
  };
  for (const name of ['click', 'drag', 'scroll', 'selectText', 'setValue', 'performSecondaryAction', 'paste', 'pressKey', 'typeText']) {
    raw[name] = async (...args) => { calls.push([name, ...args]); return action(name, args); };
  }
  const engine = strict ? new Proxy(raw, { get(object, key) {
    if (key in object || typeof key === 'symbol' || key === 'then') return object[key];
    throw Error('unsupported engine method ' + key);
  } }) : raw;
  const context = { app: engine, cua: { getApp: async () => engine, listApps: async () => [{ id: 'fixture.app', displayName: expected.app, windows: [{ id: 1, title: expected.title }] }] }, nodeRepl: { write: value => output.push(value), emitImage: async () => {} } };
  const run = (code, options = ordinary ? defaultOptions() : {}, target = expected) => runInNewContext(`(async () => { ${guardedCode(code, target, 'changed window', undefined, { focused: true, ...options })} })()`, context);
  return { run, raw, calls, output, context };
}

test('lean calls keep a strict native handle across calls and report an unchanged action compactly', async () => {
  const f = fixture({ strict: true });
  await f.run('globalThis.saved = await cua.getApp("fixture.app");');
  await f.run('await saved.click(1);');
  await f.run('await saved.pressKey("a");');
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'pressKey').length, 1);
  const compactor = createReadCompactor({ leanCalls: true });
  compactor.process([{ type: 'text', text: tree() }]);
  const content = compactor.process([{ type: 'text', text: f.output.at(-1) }], { action: compactor.beginAction('await app.pressKey("a");') });
  assert.match(content[0].text, /^Window: /);
  assert.match(content[0].text, /no change since/);
  assert.doesNotMatch(content[0].text, /1 button Save/);
});

test('lean action results retain changed rows, explicit full reads and stale-number refusals', () => {
  const compactor = createReadCompactor({ leanCalls: true });
  compactor.process([{ type: 'text', text: tree() }]);
  const next = tree(expected, '\t2 button Save, ID: Save');
  const marked = [{ type: 'text', text: GUARD_MARK + next + GUARD_END }];
  const action = compactor.beginAction('await app.click(1);');
  const content = compactor.process(marked, { action });
  assert.match(content[0].text, /other elements have new numbers/);
  assert.ok(compactor.staleIndex(expected, 'await app.click(1);'));
  assert.equal(compactor.process(marked, { forceFull: true })[0].text, next);
  const changed = tree(expected, '\t2 button Done, ID: Done');
  const changedContent = compactor.process([{ type: 'text', text: GUARD_MARK + changed + GUARD_END }],
    { action: compactor.beginAction('await app.click(2);') });
  assert.match(changedContent[0].text, /\+ \t2 button Done, ID: Done/);
  assert.match(changedContent[0].text, /- \tbutton Save, ID: Save/);
  const defaultCompactor = createReadCompactor({ leanCalls: false });
  defaultCompactor.process([{ type: 'text', text: tree() }]);
  assert.equal(defaultCompactor.process([{ type: 'text', text: GUARD_MARK + tree() + GUARD_END }],
    { action: defaultCompactor.beginAction('await app.click(1);') })[0].text, tree());
});

test('the relay selects compact native results only for lean calls and honors explicit full reads', async t => {
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  for (const leanCalls of [false, true]) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const sent = [], received = [];
    serverIn.on('data', data => sent.push(JSON.parse(data.toString())));
    clientOut.on('data', data => received.push(JSON.parse(data.toString())));
    const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-lean-calls-')));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, leanCalls, changeReview: false,
      inputLease: new InputLease({ directory, holder: 'lean-test' }) });
    t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); removeTemp(directory); });
    const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    const reply = (id, text) => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }],
      _meta: { 'codex/toolSurface': { app: { appId: 'fixture.app' } } } } }) + '\n');
    call(1, 'let app = await cua.getApp("fixture.app");'); await settle(); reply(1, tree()); await settle();
    call(2, 'await app.click(1);'); await settle();
    assert.ok(sent.some(message => message.id === 2), 'the saved app handle can act without acquisition');
    reply(2, GUARD_MARK + tree() + GUARD_END); await settle();
    const result = received.find(message => message.id === 2).result.content[0].text;
    if (leanCalls) { assert.match(result, /no change since/); assert.doesNotMatch(result, /1 button Save/); }
    else assert.equal(result, tree());
    call(3, 'await app.getAXState({ disableDiffing: true });'); await settle();
    reply(3, GUARD_MARK + tree() + GUARD_END); await settle();
    assert.equal(received.find(message => message.id === 3).result.content[0].text, tree());
  }
});

test('a combined observation supplies the first action and a full post-call header', async () => {
  const f = fixture();
  await f.run('await app.getAXStateAndScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  assert.equal(f.calls[0][1].disableDiffing, true);
  assert.equal(f.output.at(-1), GUARD_MARK + tree() + GUARD_END);
});

test('a final combined read avoids an extra read and preserves hidden output semantics', async () => {
  for (const emit of [true, false]) {
    const f = fixture();
    await f.run(`await app.click(1); const observed = await app.getAXStateAndScreenshot({ emit: ${emit} });
      if (observed.screenshot[2] !== 3) throw new Error('screenshot changed');`);
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'both']);
    assert.equal(f.calls.at(-1)[1].emit, emit);
    if (!emit) assert.equal(f.output.at(-1), GUARD_OMIT_MARK + tree() + GUARD_END);
    else assert.equal(f.output.at(-1), tree());
  }
});

test('combined read always requests a full tree, even when its caller requests a diff', async () => {
  const f = fixture({ screenshotState: options => options?.disableDiffing ? tree() : '+ 2 button Other' });
  await f.run('await app.getAXStateAndScreenshot({ disableDiffing: false }); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
});

test('each action invalidates the combined snapshot before checking title, app and URL again', async () => {
  for (const key of ['title', 'app', 'url']) {
    let changed = false;
    const f = fixture({ current: () => tree(changed ? { ...expected, [key]: 'other' } : expected),
      action: () => { changed = true; } });
    await assert.rejects(f.run('await app.getAXStateAndScreenshot(); await app.click(1); await app.click(1);'), /changed window/);
    assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  }
});

test('every native method checks the identity returned by a combined observation', async () => {
  for (const expression of ['click(1)', 'drag([1,1],[2,2])', 'scroll(1,"down",1)', 'selectText(1,"x")',
    'setValue(1,"x")', 'performSecondaryAction(1,"Raise")', 'paste("x")', 'pressKey("a")', 'typeText("x")']) {
    const f = fixture({ current: () => tree({ ...expected, url: 'file:///tmp/b.txt' }) });
    await assert.rejects(f.run(`await app.getAXStateAndScreenshot(); await app.${expression};`), /changed window/);
    assert.deepEqual(f.calls.map(c => c[0]), ['both']);
  }
});

test('a renumbered element is followed only when its line is in the new tree exactly once', async () => {
  for (const [after, clicks] of [['\t2 button Delete\n\t3 button Save, ID: Save', [2, 3]],
    ['\t2 button Delete\n\t3 button Save, ID: Save\n\t4 button Save, ID: Save', [2]]]) {
    let changed = false;
    const f = fixture({ current: () => tree(expected, changed ? after : '\t2 button Save, ID: Save'), action: () => { changed = true; } });
    const done = f.run('await app.getAXStateAndScreenshot(); await app.click(2); await app.click(2);');
    if (clicks.length === 1) await assert.rejects(done, /changed what element 2 is/); else await done;
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), clicks);
  }
});

test('a combined snapshot cannot preserve a stale number, ID or label after an action', async () => {
  for (const selector of ['2', '{ id: "Save" }', '{ label: "Save" }']) {
    let changed = false;
    const f = fixture({ current: () => tree(expected, changed ? '\t2 button Delete\n\t3 button Save, ID: Save' : '\t2 button Save, ID: Save'),
      action: () => { changed = true; } });
    const done = f.run(`await app.getAXStateAndScreenshot(); await app.click(2); await app.click(${selector});`);
    if (selector === '2') {
      // The line Claude saw ("button Save, ID: Save") is now 3, once: the click goes there.
      await done;
      assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2], ['click', 3]]);
    } else {
      await done;
      assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2], ['click', 3]]);
    }
  }
});

test('a read that drops an element\'s attributes under load still matches that element', async () => {
  // Under load the engine read "button Two" where it had read "button Description: 2, ID: Two".
  const full = '\t2 button Description: 1, ID: One\n\t3 button Description: 2, ID: Two';
  const bare = '\t2 button One\n\t3 button Two';
  let clicks = 0;
  const f = fixture({ current: () => tree(expected, clicks ? bare : full), action: () => { clicks++; } });
  await f.run('await app.click(2); await app.click(3);');
  assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 2], ['click', 3]]);
  let moved = 0;
  const g = fixture({ current: () => tree(expected, moved ? '\t2 button One\n\t3 button Three' : full), action: () => { moved++; } });
  await assert.rejects(g.run('await app.click(2); await app.click(3);'), /changed what element 3 is/);
});

test('sameElement accepts only a bare line named by the fuller line\'s ID or label', () => {
  assert.equal(sameElement('button Description: 2, ID: Two', 'button Two'), true);
  assert.equal(sameElement('button Two', 'button Description: 2, ID: Two'), true);
  assert.equal(sameElement('button Description: 2, ID: Two', 'button 2'), true, 'by description');
  assert.equal(sameElement('toggle button Description: Bold, ID: bold', 'toggle button Bold'), true);
  for (const now of ['button Three', 'checkbox Two', 'button Two, ID: Other', 'button', 'button Tw', undefined]) {
    assert.equal(sameElement('button Description: 2, ID: Two', now), false, String(now));
  }
  assert.equal(sameElement(undefined, undefined), true);
});

test('keys, text, paste and coordinates go ahead without a read only after typing, pasting or a plain key', async () => {
  // After a click, Return or a shortcut the next action reads, which also waits for a panel to open.
  const sequence = 'await app.click(1); await app.typeText("x"); await app.pressKey("Return"); await app.paste("y"); await app.click([5, 5]); await app.drag([1, 1], [2, 2]);';
  const f = fixture();
  await f.run(sequence);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'typeText', 'pressKey', 'read', 'paste', 'click', 'read', 'drag', 'read']);
  const keys = fixture();
  await keys.run('await app.typeText("a"); await app.pressKey("b"); await app.pressKey("Left"); await app.pressKey("super+shift+g"); await app.typeText("/tmp"); await app.pressKey("Return");');
  assert.deepEqual(keys.calls.map(c => c[0]), ['read', 'typeText', 'pressKey', 'pressKey', 'pressKey', 'read', 'typeText', 'pressKey', 'read']);
  const careful = fixture();
  await careful.run(sequence, { careful: true });
  assert.deepEqual(careful.calls.map(c => c[0]), ['read', 'click', 'read', 'typeText', 'read', 'pressKey', 'read', 'paste', 'read', 'click', 'read', 'drag', 'read']);
  // The first action of a call is still checked, and a numbered action after another still reads.
  const first = fixture();
  await first.run('await app.typeText("x"); await app.click(1);');
  assert.deepEqual(first.calls.map(c => c[0]), ['read', 'typeText', 'read', 'click', 'read']);
});

for (const action of ['app.pressKey("a")', 'app.pressKey("Return")', 'app.typeText("x")', 'app.paste("x")',
  'app.click([5,5])', 'app.drag([1,1],[2,2])', 'app.scroll([5,5], "down", 1)'])
  test('first-off skips only the first guard read for ' + action, async () => {
    for (const [options, reads] of [[{}, 2], [{ firstOff: true }, 1], [{ firstOff: true, careful: true }, 2],
      [{ firstOff: true, fileOnly: true }, 2]]) {
      const f = fixture({ strict: true }); await f.run('await ' + action + ';', options);
      assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, JSON.stringify(options));
      assert.equal(f.output.at(-1), GUARD_MARK + tree() + GUARD_END);
    }
  });

for (const action of ['app.click(1)', 'app.click({id:"Save"})', 'app.click({label:"Save"})',
  'app.setValue(1,"x")', 'app.selectText(1,"x")', 'app.performSecondaryAction(1)'])
  test('first-off retains a fresh lookup for ' + action, async () => {
    const f = fixture({ strict: true }); await f.run('await ' + action + ';', { firstOff: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', action.match(/app\.(\w+)/)[1], 'read']);
  });

for (const action of ['app.click([5,5])', 'app.pressKey("super+o")', 'app.pressKey("Return")',
  'app.pressKey("Escape")', 'app.pressKey("Tab")', 'app.pressKey("Space")'])
  test('first-off keeps the next settle read after ' + action, async () => {
    const f = fixture({ strict: true }); await f.run('await ' + action + '; await app.typeText("x");', { firstOff: true });
    assert.deepEqual(f.calls.map(c => c[0]), [action.match(/app\.(\w+)/)[1], 'read', 'typeText', 'read']);
  });

test('first-off leaves the first numbered baseline unset until its fresh lookup', async () => {
  const f = fixture({ strict: true });
  await f.run('await app.typeText("x"); await app.click(1);', { firstOff: true, literals: [1], seenLines: { 1: 'button Save, ID: Save' } });
  assert.deepEqual(f.calls.map(c => c[0]), ['typeText', 'read', 'click', 'read']);
});

test('first-off uses an explicit in-call read and still refuses its changed window', async () => {
  const f = fixture({ strict: true, current: () => tree({ ...expected, title: 'other.txt' }) });
  await assert.rejects(f.run('await app.getAXState(); await app.typeText("x");', { firstOff: true }), /changed window/);
  assert.equal(f.calls.some(c => c[0] === 'typeText'), false);
});

test('first-off resets each call and does not use the prior inventory for its skipped read', async () => {
  const f = fixture({ strict: true });
  f.context.cua.listApps = () => { assert.fail('first-off must not inventory to reuse the skipped first read'); };
  const prior = { text: tree(), id: 'fixture.app', title: 'a.txt', windows: [{ title: 'a.txt' }] };
  for (let i = 0; i < 2; i++) {
    f.calls.length = 0;
    await f.run('await app.typeText("x"); await app.pressKey("a");', { firstOff: true, prior });
    assert.deepEqual(f.calls.map(c => c[0]), ['typeText', 'pressKey', 'read']);
  }
  f.calls.length = 0; await f.run('await app.typeText("x");');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'typeText', 'read']);
});

test('first-off still refuses input after lease expiry or replacement, before any read or write', async t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-first-off-lease-')));
  t.after(() => removeTemp(dir)); const path = join(dir, 'lease.json');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const record of [{ token: 'owner', expires: 0 }, { token: 'successor', expires: Date.now() + 30000 }]) {
    writeFileSync(path, JSON.stringify(record)); let reads = 0, writes = 0;
    const raw = new Proxy({ getAXState: async () => { reads++; return tree(); }, typeText: async () => { writes++; } }, {
      get(object, key) { if (key in object || typeof key === 'symbol' || key === 'then') return object[key]; throw Error('unsupported fake ' + key); },
    });
    const code = guardedCode('await app.typeText("x");', expected, 'changed window', { path, token: 'owner' }, { firstOff: true });
    try {
      await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(raw, { getApp: async () => raw }, { write() {} }), /ownership lost or expired/);
      assert.equal(reads, 0); assert.equal(writes, 0);
    } finally { delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup; }
  }
});

test('bind sends seven clicks from one capture and retains the final read', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => `\t${i + 1} button Description: Key ${i + 1}, ID: key-${i + 1}`).join('\n');
  for (const [options, reads] of [[{}, 8], [{ bind: true }, 2], [{ bind: true, careful: true }, 8]]) {
    const f = fixture({ strict: true, current: () => tree(expected, rows) });
    await f.run(Array.from({ length: 7 }, (_, i) => `await app.click(${i + 1});`).join('\n'), options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(f.output.at(-1), GUARD_MARK + tree(expected, rows) + GUARD_END);
  }
});

test('bound Calculator-style clicks take no inventory or AX read between clicks', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => `\t${i + 1} button Description: ${i + 1}, ID: key-${i + 1}`).join('\n');
  const f = fixture({ strict: true, current: () => tree(expected, rows) });
  let inventories = 0, clock = 0;
  f.context.performance = { now: () => clock };
  f.context.cua.listApps = async options => {
    assert.equal(options.emit, false); inventories++; clock += 11;
    return [{ id: 'fixture.app', displayName: expected.app, isRunning: true }];
  };
  await f.run(Array.from({ length: 7 }, (_, i) => `await app.click(${i + 1});`).join('\n'), { bind: true, timing: true });
  assert.equal(inventories, 0);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', ...Array(7).fill('click'), 'read']);
  const metrics = f.output.filter(line => line.startsWith('[sleight:guard-timing]')).map(line => JSON.parse(line.slice(22)));
  assert.deepEqual(metrics.filter(m => m.phase === 'bound-windows'), []);
});

test('a plain button swapping to a look-alike document stays bound until the final read', async () => {
  let replaced = false;
  const replacement = { ...expected, url: 'file:///tmp/look-alike/a.txt' };
  const rows = '\t1 button First\n\t2 button Second';
  const f = fixture({ strict: true, current: () => tree(replaced ? replacement : expected, rows),
    action: () => { replaced = true; } });
  f.context.cua.listApps = () => { assert.fail('bound actions must not request a window inventory'); };
  await f.run('await app.click(1); await app.click(2);', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
  assert.equal(f.output.at(-1), GUARD_MARK + tree(replacement, rows) + GUARD_END);
});

test('macOS listApps without windows does not disable a bound capture', async () => {
  const f = fixture({ strict: true, current: () => tree(expected, '\t1 button First\n\t2 button Second') });
  // Installed Mac adapter: id, displayName, isRunning, lastUsedDate and useCount; no windows.
  f.context.cua.listApps = async () => [{ id: 'fixture.app', displayName: expected.app, isRunning: true }];
  await f.run('await app.click(1); await app.click(2);', { bind: true });
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
});

for (const title of ['Delete', 'Remove Group', 'Revert', 'Discard', 'Erase', 'Empty Trash', 'Close', 'Quit', 'Exit',
  'Sign Out', 'Log Out', 'Reset', 'Clear', 'Replace', "Don't Save", 'Do Not Save', 'Save', 'OK', 'Done', 'Apply',
  'Continue', 'Proceed', 'Next', 'Back', 'Finish', 'Confirm', 'Accept', 'Cancel', 'Dismiss'])
  test('binding reads after a plain confirming button: ' + title, async () => {
    const f = fixture({ current: () => tree(expected, '\t1 button ' + title + '\n\t2 button Second') });
    await f.run('await app.click(1); await app.click(2);', { bind: true });
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
  });

for (const line of ['button Delete, ID: opener', 'button Description: Delete, ID: opener',
  'button (enabled) Description: Remove Group, ID: opener', 'button ID: opener, Description: Save',
  'button Description: Delete, Help: Delete the last digit, ID: opener',
  'button Description: Browse…, ID: opener', 'close button, ID: opener', 'close button (enabled), ID: opener']) {
  for (const target of ['1', '{ id: "opener" }', '{ line: ' + JSON.stringify(line) + ' }']) {
    for (const careful of [false, true]) {
      test(`confirming row refreshes before a stale click: ${line}, ${target}, careful=${careful}`, async () => {
        let changed = false;
        const f = fixture({ strict: true,
          current: () => tree(expected, changed ? '\t3 sheet Confirm\n\t1 button Cancel\n\t2 button Confirm unrelated deletion'
            : '\t1 ' + line + '\n\t2 button Second'), action: () => { changed = true; } });
        if (target === '1' && line.startsWith('close button')) {
          await assert.rejects(f.run(`await app.click(${target}); await app.click(2);`, { bind: true, careful }),
            /element 1 is the window's close button; close a window by label or with Cmd\+W/);
          assert.deepEqual(f.calls.map(c => c[0]), ['read']);
          return;
        }
        await assert.rejects(f.run(`await app.click(${target}); await app.click(2);`, { bind: true, careful }),
          /changed what element 2 is/);
        assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
        assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 1]]);
      });
    }
  }
}

for (const line of ['button Description: Delete, ID: opener', 'button ID: opener, Description: Delete']) {
  test('a label click refreshes after the displayed confirming label: ' + line, async () => {
    let changed = false;
    const f = fixture({ strict: true, current: () => tree(expected,
      changed ? '\t1 button Cancel\n\t2 button Other' : '\t1 ' + line + '\n\t2 button Second'),
    action: () => { changed = true; } });
    await assert.rejects(f.run('await app.click({ label: "Delete" }); await app.click(2);', { bind: true }),
      /changed what element 2 is/);
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
  });
}

for (const line of ['button Description: Mode, Help: Delete the last digit, ID: mode',
  'button Description: Mode, Secondary Actions: Delete, Cancel, ID: mode',
  'button Description: Mode, Help: Browse…, ID: mode', 'button Mode, ID: Delete',
  'button Help: Delete, ID: mode', 'button Secondary Actions: Delete, Cancel, ID: mode']) {
  test('binding ignores confirming words in unrelated fields: ' + line, async () => {
    const f = fixture({ strict: true, current: () => tree(expected, '\t1 ' + line + '\n\t2 button Second') });
    await f.run('await app.click(1); await app.click(2);', { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
  });
}

for (const field of ['Help', 'Secondary Actions', 'ID', 'Value']) {
  for (const value of ['Delete', 'Browse…', 'Open...']) {
    test(`leading ${field} metadata never supplies an opener label: ${value}`, async () => {
      const line = `button ${field}: ${value}${field === 'ID' ? '' : ', ID: mode'}`;
      const f = fixture({ strict: true, current: () => tree(expected, '\t1 ' + line + '\n\t2 button Second') });
      f.context.cua.listApps = () => { assert.fail('bound clicks must not request an inventory'); };
      await f.run('await app.click(1); await app.click(2);', { bind: true });
      assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
    });
  }
}

test('setValue invalidates binding before the next element action', async () => {
  let changed = false;
  const f = fixture({ current: () => tree(expected, changed ? '\t1 text field Editor\n\t2 button Other' : '\t1 text field Editor\n\t2 button Second'),
    action: () => { changed = true; } });
  await assert.rejects(f.run('await app.setValue(1,"x"); await app.click(2);', { bind: true }), /changed what element 2 is/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'setValue', 'read']);
});

test('first-off checks another window handle in the same app even with a focus confirmation', async () => {
  const f = fixture();
  let keys = 0;
  f.context.otherRaw = { getAXState: async () => tree({ ...expected, title: 'other.txt' }), pressKey: async () => { keys++; } };
  await assert.rejects(f.run('const other = globalThis.__sleightDocumentGuard.wrap(globalThis.otherRaw); await other.pressKey("super+a");',
    { firstOff: true, focused: true }), /changed window/);
  assert.equal(keys, 0);
});

for (const target of ['2', '{ id: "second" }', '{ label: "Second" }', '{ line: "button Second, ID: second" }', '"Second"'])
  test('bind keeps the capture number for ' + target + ' until a read occurs', async () => {
    let acted = false;
    const f = fixture({ strict: true,
      current: () => tree(expected, acted ? '\t1 button First\n\t2 button Other\n\t3 button Second, ID: second' : '\t1 button First\n\t2 button Second, ID: second'),
      action: () => { acted = true; } });
    await f.run(`await app.click(1); await app.click(${target});`, { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'click', 'read']);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [1, 2]);
  });

for (const line of ['menu button Actions', 'pop up button Choices', 'menu bar item File', 'menu item Save',
  'link Details', 'tab General', 'disclosure triangle More', 'button Browse…', 'button Browse...'])
  test('bind reads after the resolved opener ' + line, async () => {
    const f = fixture({ strict: true, current: () => tree(expected, '\t1 ' + line + ', ID: opener\n\t2 button Next') });
    await f.run('await app.click({ id: "opener" }); await app.click(2);', { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'click', 'read']);
  });

for (const key of ['super+o', 'Return', 'Escape', 'Space', 'Tab'])
  test('bind keeps the read before an element after ' + key, async () => {
    const f = fixture({ strict: true });
    await f.run(`await app.pressKey(${JSON.stringify(key)}); await app.click(1);`, { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'pressKey', 'read', 'click', 'read']);
  });

for (const target of ['{ id: "duplicate" }', '{ label: "Duplicate" }', '{ line: "button Duplicate, ID: duplicate" }', '"Duplicate"'])
  test('bind reads when the first capture is non-unique for ' + target, async () => {
    let acted = false;
    const rows = '\t1 button First\n\t2 button Duplicate, ID: duplicate';
    const f = fixture({ strict: true, current: () => tree(expected, rows + (acted ? '' : '\n\t3 button Duplicate, ID: duplicate')),
      action: () => { acted = true; } });
    await f.run(`await app.click(1); await app.click(${target});`, { bind: true });
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read', 'click', 'read']);
  });

test('bind checks a computed number against the code read after another action', async () => {
  let acted = false;
  const f = fixture({ strict: true, current: () => tree(expected, acted ? '\t1 button First\n\t2 button Other' : '\t1 button First\n\t2 button Second'),
    action: () => { acted = true; } });
  await assert.rejects(f.run('const s = await app.getAXState(); const n = Number(/(\\d+) button Second/.exec(s)[1]); await app.click(1); await app.click(n);',
    { bind: true, literals: [1] }), /element 2 changed since this call read the window/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
});

test('bind compares literal numbers against explicit reads the call actually took', async () => {
  let acted = false;
  const f = fixture({ strict: true, current: () => tree(expected, acted ? '\t1 button First\n\t2 button Other' : '\t1 button First\n\t2 button Second'),
    action: () => { acted = true; } });
  await assert.rejects(f.run('await app.click(1); await app.getAXState(); await app.click(2);', { bind: true }), /changed what element 2 is/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
});

test('the default combines capture binding and quiet edits and resets on the next call', async () => {
  const f = fixture({ ordinary: true, strict: true, current: () => tree(expected, '\t1 text field Editor\n\t2 button Next') });
  await f.run('await app.pressKey("super+a"); await app.typeText("x"); await app.click(1); await app.typeText("y"); await app.click(2);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'pressKey', 'typeText', 'click', 'typeText', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.click(2);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
});

test('bind preserves the first-action remap when the same literal is repeated', async () => {
  const f = fixture({ strict: true, current: () => tree(expected, '\t1 button Other\n\t2 button Target, ID: target') });
  await f.run('await app.click(1); await app.click(1);', { bind: true, literals: [1],
    seenLines: { 1: 'button Target, ID: target' }, uniqueSeen: [1] });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [2, 2]);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 2);
});

test('bind follows repeated literals through successive observed remaps', async () => {
  let clicks = 0;
  const f = fixture({ strict: true, current: () => tree(expected, '\t1 button Other\n' +
    (clicks ? '\t2 button Different\n\t3 button Target, ID: target' : '\t2 button Target, ID: target')),
    action: () => { clicks++; } });
  await f.run('await app.click(1); await app.getAXState(); await app.click(1); await app.click(1);',
    { bind: true, literals: [1], seenLines: { 1: 'button Target, ID: target' }, uniqueSeen: [1] });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [2, 3, 3]);
  assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
});

const editKeys = ['super+a', 'cmd+c', 'command+x', 'meta+z', 'super+shift+z', 'cmd+b', 'cmd+i', 'cmd+u',
  ...['Left', 'Right', 'Up', 'Down', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].flatMap(key =>
    [key, 'super+' + key, 'alt+shift+' + key, 'ctrl+' + key])];
for (const key of editKeys) test('quiet-edits skips the next read after ' + key, async () => {
  for (const [options, reads] of [[{}, key.includes('+') ? 3 : 2], [{ quietEdits: true }, 2],
    [{ quietEdits: true, careful: true }, 4]]) {
    const f = fixture({ strict: true });
    await f.run(`await app.typeText("a"); await app.pressKey(${JSON.stringify(key)}); await app.typeText("x");`, options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, JSON.stringify(options));
  }
});

for (const role of ['text field', 'text area', 'text entry area', 'search field', 'search text field', 'combo box'])
  for (const target of ['1', '{ id: "editor" }', '{ label: "Editor" }'])
    test('quiet-edits recognizes ' + role + ' clicked by ' + target, async () => {
      for (const next of ['typeText("x")', 'paste("x")']) for (const [options, reads] of
        [[{}, 3], [{ quietEdits: true }, 2], [{ quietEdits: true, careful: true }, 3]]) {
        const f = fixture({ strict: true, current: () => tree(expected, '\t1 ' + role + ' Description: Editor, ID: editor') });
        await f.run(`await app.click(${target}); await app.${next};`, options);
        assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, JSON.stringify(options));
        assert.deepEqual(f.calls.find(c => c[0] === 'click'), ['click', 1]);
      }
    });

for (const action of ['click(1)', 'click([5,5])', ...['super+o', 'super+s', 'super+n', 'super+p', 'super+shift+g',
  'Return', 'Escape', 'Tab', 'Space', 'super+shift+a', 'ctrl+a', 'super+alt+z'].map(key => `pressKey("${key}")`)])
  test('quiet-edits retains the settle read after ' + action, async () => {
    const f = fixture({ strict: true, current: () => tree(expected, '\t1 button Description: text field, ID: editor') });
    await f.run(`await app.${action}; await app.typeText("x");`, { quietEdits: true });
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
  });

test('quiet-edits field clicks skip only typing or paste and keep element lookups fresh', async () => {
  for (const next of ['pressKey("super+a")', 'click([5,5])', 'click(1)', 'click({id:"editor"})', 'click({label:"Editor"})']) {
    const f = fixture({ strict: true, current: () => tree(expected, '\t1 text field Description: Editor, ID: editor') });
    await f.run(`await app.click(1); await app.${next};`, { quietEdits: true });
    assert.equal(f.calls.filter(c => c[0] === 'read').length, 3);
  }
});

test('the default skips reads between edit shortcuts and typing, and careful reads every time', async () => {
  for (const [options, reads] of [[undefined, 2], [{ careful: true }, 3], [{ careful: true, fileOnly: true }, 3]]) {
    const f = fixture({ ordinary: true, strict: true });
    await f.run('await app.pressKey("super+a"); await app.typeText("x");', options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads);
  }
});

test('a window change mid-batch stops the next numbered action, and careful mode stops keys too', async () => {
  for (const [code, options, stopped] of [['await app.typeText("a"); await app.typeText("x");', {}, false],
    ['await app.typeText("a"); await app.typeText("x");', { careful: true }, true], ['await app.click(1); await app.typeText("x");', {}, true],
    ['await app.click(1); await app.click(1);', {}, true]]) {
    let changed = false;
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'b.txt' } : expected), action: () => { changed = true; } });
    const done = f.run(code, options);
    if (stopped) await assert.rejects(done, /changed window/); else await done;
  }
});

test('a prior read with no inventory is used as it is, and a degraded read still finds an element by ID', async () => {
  const f = fixture({ current: () => tree(expected, '\t1 button One\n\t2 button Two') });
  f.context.cua.listApps = async () => { f.calls.push(['listApps']); return []; };
  await f.run('await app.click({ id: "Two" });', { prior: { text: tree(expected, '\t1 button One\n\t2 button Two'), windows: null } });
  assert.deepEqual(f.calls.map(c => c[0]), ['click', 'read'], 'no inventory and no read before the click');
  assert.deepEqual(f.calls.find(c => c[0] === 'click'), ['click', 2], 'the bare line named Two');
  const ambiguous = fixture({ current: () => tree(expected, '\t1 button Two\n\t2 button Two') });
  await assert.rejects(ambiguous.run('await app.click({ id: "Two" });'), /2 elements|no element/);
  const attributed = fixture({ current: () => tree(expected, '\t1 button Description: 2, ID: Deux') });
  await assert.rejects(attributed.run('await app.click({ id: "Two" });'), /no element/);
});

test('the first action goes where the line Claude saw moved, and stops when that line is gone or ambiguous', async () => {
  // TextEdit gave a saved document a URL and 14 became File (textedit-save, 2026-10-09).
  const f = fixture({ current: () => tree(expected, '\t14 menu bar item File\n\t15 menu bar item Format') });
  await f.run('await app.click(14);', { seenLines: { 14: 'menu bar item Format' }, literals: [14], uniqueSeen: [14] });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 15]]);
  assert.ok(f.output.some(o => /click\(14\) went to element 15, the same "menu bar item Format": the window renumbered since you read it/.test(o)));
  const gone = fixture({ current: () => tree(expected, '\t14 menu bar item File\n\t15 menu bar item Edit') });
  await assert.rejects(gone.run('await app.click(14);', { seenLines: { 14: 'menu bar item Format' }, literals: [14] }),
    /click\(14\): element 14 changed since you read the window \(was "menu bar item Format", now "menu bar item File"\)[\s\S]*15 menu bar item Edit/);
  const twice = fixture({ current: () => tree(expected, '\t14 menu bar item File\n\t15 menu bar item Format\n\t16 menu bar item Format') });
  await assert.rejects(twice.run('await app.click(14);', { seenLines: { 14: 'menu bar item Format' }, literals: [14] }), /changed since you read the window/);
  // A bare role says nothing about which element it was.
  const bare = fixture({ current: () => tree(expected, '\t14 group\n\t15 container (selected)') });
  await assert.rejects(bare.run('await app.click(14);', { seenLines: { 14: 'container (selected)' }, literals: [14], uniqueSeen: [14] }), /changed since you read the window/);
  // Claude saw two such rows: the one left may be the other row's.
  const dup = fixture({ current: () => tree(expected, '\t14 text Inbox\n\t15 button Delete') });
  await assert.rejects(dup.run('await app.click(14);', { seenLines: { 14: 'button Delete' }, literals: [14], uniqueSeen: [] }), /changed since you read the window/);
  // With a second literal, that number shifted too and nothing after the first action would catch it.
  const two = fixture({ current: () => tree(expected, '\t14 menu bar item File\n\t15 menu bar item Format\n\t20 button Go') });
  await assert.rejects(two.run('await app.click(14); await app.click(19);', { seenLines: { 14: 'menu bar item Format', 19: 'button Go' }, literals: [14, 19], uniqueSeen: [14, 19] }),
    /changed since you read the window/);
  assert.deepEqual([gone, twice, bare, dup, two].flatMap(x => x.calls.filter(c => c[0] === 'click')), []);
  const same = fixture({ current: () => tree(expected, '\t14 menu bar item Format') });
  await same.run('await app.click(14);', { seenLines: { 14: 'menu bar item Format' }, literals: [14] });
  assert.deepEqual(same.calls.filter(c => c[0] === 'click'), [['click', 14]]);
});

test('a number the code read itself in this call is checked against that read, not the tree before the call', async () => {
  // ZCode, 2026-10-12: a click closed a dialog, the code read again and matched the button's new
  // number, and sleight stopped that correct click against the older tree.
  let closed = false;
  const before = '\t5 container Resettable quota\n\t21 button Close';
  const after = '\t4 container\n\t5 button Back to workspace';
  const f = fixture({ current: () => tree(expected, closed ? after : before), action: (name, args) => { if (args[0] === 21) closed = true; } });
  await f.run(`await app.click(21);
    const s = await app.getAXState({ emit: false });
    const m = s.match(/(\\d+) button Back to workspace/);
    await app.click(Number(m[1]));`, { seenLines: { 21: 'button Close' }, literals: [21] });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click'), [['click', 21], ['click', 5]]);
  // The same computed number with no read in the call keeps the older tree as its reference.
  closed = false;
  const g = fixture({ current: () => tree(expected, closed ? after : before), action: (name, args) => { if (args[0] === 21) closed = true; } });
  await assert.rejects(g.run('await app.click(21); const n = 5; await app.click(n);', { seenLines: { 21: 'button Close' }, literals: [21] }),
    /an earlier action in this call changed what element 5 is/);
  // A computed number whose element moved after the code read goes to that line when it's unique,
  // and stops when it isn't; a combined read counts as the code's read too.
  let moved = false;
  const k = fixture({ current: () => tree(expected, moved ? '\t5 button Back to workspace\n\t6 text entry area (settable) Placeholder: Ask' : '\t5 text entry area (settable) Placeholder: Ask'),
    action: (name) => { if (name === 'pressKey') moved = true; } });
  await k.run(`const r = await app.getAXStateAndScreenshot({ emit: false }); const n = Number(/(\\d+) text entry area/.exec(r.state)[1]);
    await app.pressKey('escape'); await app.click(n);`, { literals: [] });
  assert.deepEqual(k.calls.filter(c => c[0] === 'click'), [['click', 6]]);
  assert.ok(k.output.some(o => /click\(5\) went to element 6.*renumbered after this call read it/.test(o)));
  moved = false;
  const l = fixture({ current: () => tree(expected, moved ? '\t5 button Back to workspace' : '\t5 text entry area (settable) Placeholder: Ask'),
    action: (name) => { if (name === 'pressKey') moved = true; } });
  await assert.rejects(l.run(`const s = await app.getAXState({ emit: false }); const n = Number(/(\\d+) text entry/.exec(s)[1]);
    await app.pressKey('escape'); await app.click(n);`, { literals: [] }), /element 5 changed since this call read the window/);
  // A literal number after a read in the call still means what Claude saw.
  let shifted = false;
  const h = fixture({ current: () => tree(expected, shifted ? '\t7 button Send\n\t8 button Stop' : '\t7 button Stop'), action: () => { shifted = true; } });
  await assert.rejects(h.run('await app.click(7); await app.getAXState({ emit: false }); await app.click(7);', { seenLines: { 7: 'button Stop' }, literals: [7] }),
    /an earlier action in this call changed what element 7 is/);
});

test('new calls expire a combined snapshot; screenshots replace it with a fresh combined capture', async () => {
  const f = fixture();
  await f.run('await app.getAXStateAndScreenshot();');
  f.calls.length = 0;
  await f.run('await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.getScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'click', 'read']);
  f.calls.length = 0;
  await f.run('await app.getAXStateAndScreenshot(); await app.getScreenshot(); await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['both', 'both', 'click', 'read']);
});

test('input through another handle invalidates a combined observation of the same window', async () => {
  let changed = false;
  const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected),
    action: () => { changed = true; } });
  f.context.cua.getApp = async () => ({ ...f.raw });
  await assert.rejects(f.run('await app.getAXStateAndScreenshot(); const other = await cua.getApp("TextEdit"); await other.pressKey("a"); await app.click(1);'), /changed window/);
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
});

test('a failed or incomplete combined observation cannot preserve an older cached tree', async () => {
  for (const state of [undefined, '', '+ 2 button Changed']) {
    const f = fixture({ screenshotState: () => state });
    await f.run('await app.getAXState(); await app.getAXStateAndScreenshot(); await app.click(1);');
    assert.deepEqual(f.calls.map(c => c[0]), ['read', 'both', 'read', 'click', 'read']);
  }
  const f = fixture();
  f.raw.getAXStateAndScreenshot = async () => { throw new Error('unavailable'); };
  await f.run('await app.getAXState(); try { await app.getAXStateAndScreenshot(); } catch {} await app.click(1);');
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'read', 'click', 'read']);
});

test('a cached combined observation cannot outlive input lease ownership or expiry', async t => {
  const bank = mkdtempSync(join(tmpdir(), 'sleight-guard-lease-'));
  t.after(() => removeTemp(bank));
  const path = join(bank, 'lease.json');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const record of [{ token: 'successor', expires: Date.now() + 30000 }, { token: 'owner', expires: 0 }]) {
    writeFileSync(path, JSON.stringify({ token: 'owner', expires: Date.now() + 30000 }));
    let actions = 0;
    const app = {
      getAXState: async () => tree(),
      getAXStateAndScreenshot: async () => {
        writeFileSync(path, JSON.stringify(record));
        return { state: tree() };
      },
      click: async () => { actions++; },
    };
    const code = guardedCode('await app.getAXStateAndScreenshot({ emit: false }); await app.click(1);',
      expected, 'changed window', { path, token: 'owner' });
    try {
      await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(app, { getApp: async () => app }, { write() {} }), /ownership lost or expired/);
      assert.equal(actions, 0);
    } finally { delete globalThis.__sleightDocumentGuard; }
  }
});

for (const method of ['getAXState', 'getAXStateAndScreenshot']) {
  test(`${method} begun before input cannot refill the cache after that input`, async () => {
    let changed = false, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected),
      action: () => { changed = true; finish(); } });
    if (method === 'getAXStateAndScreenshot') {
      f.raw[method] = async () => { const state = tree(); await pending; return { state }; };
    } else {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return state; }
        return tree(changed ? { ...expected, title: 'other.txt' } : expected);
      };
    }
    await assert.rejects(f.run(`const pending = app.${method}({ emit: false });
      await app.pressKey("a"); await pending; await app.click(1);`), /changed window/);
    assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
  });

  test(`${method} begun before a screenshot cannot refill its invalidated cache`, async () => {
    let changed = false, finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const f = fixture({ current: () => tree(changed ? { ...expected, title: 'other.txt' } : expected) });
    if (method === 'getAXStateAndScreenshot') {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return { state }; }
        changed = true; finish();
        return { state: tree({ ...expected, title: 'other.txt' }), screenshot: new Uint8Array([1]) };
      };
    } else {
      let reads = 0;
      f.raw[method] = async () => {
        if (++reads === 1) { const state = tree(); await pending; return state; }
        return tree(changed ? { ...expected, title: 'other.txt' } : expected);
      };
      f.raw.getAXStateAndScreenshot = async () => {
        changed = true; finish();
        return { state: tree({ ...expected, title: 'other.txt' }), screenshot: new Uint8Array([1]) };
      };
    }
    await assert.rejects(f.run(`const pending = app.${method}({ emit: false });
      await app.getScreenshot(); await pending; await app.click(1);`), /changed window/);
    assert.equal(f.calls.filter(c => c[0] === 'click').length, 0);
  });
}

// textedit-save, 2026-10-10: Return after setValue({ id }) read the 54,000-character Save sheet.
test('Return after setValue goes ahead on its header by default, and careful mode reads first', async () => {
  for (const [options, reads] of [[undefined, 2], [{ careful: true }, 3]]) {
    const f = fixture();
    await f.run('await app.setValue(1, "b.txt"); await app.pressKey("Return");', options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, JSON.stringify(options));
  }
});

test('a call that took no action after a split acquisition takes that read as its header', async () => {
  const f = fixture();
  f.context.cua.listApps = async () => [];
  await f.run('globalThis.app = await cua.getApp("TextEdit");');
  const prior = split => ({ text: tree(), id: 'com.apple.TextEdit', title: 'a.txt', windows: [], split });
  for (const [code, options, reads] of [['app;', { prior: prior(true) }, 0], ['app;', { prior: prior(false) }, 1], ['app;', {}, 1],
    // Any action reads after as before.
    ['await app.click(1);', { prior: prior(true) }, 2]]) {
    f.calls.length = 0; f.output.length = 0;
    await f.run(code, options);
    assert.equal(f.calls.filter(c => c[0] === 'read').length, reads, `${code} ${JSON.stringify(options.prior?.split)}`);
    assert.equal(f.output.at(-1), GUARD_MARK + tree() + GUARD_END, 'the lease still gets a full header');
  }
  // Another app acquired in the call is read for its own header, never given the split's.
  const notes = 'Window: "n", App: Notes.\n0 standard window n';
  f.output.length = 0;
  await f.run(`globalThis.__sleightDocumentGuard.getApp = async () => ({ async getAXState() { return ${JSON.stringify(notes)}; } });
    globalThis.other = await cua.getApp("Notes");`, { prior: prior(true) });
  assert.equal(f.output.at(-1), GUARD_MARK + notes + GUARD_END);
});

test('a window the call\'s own shortcut or Return opened or named is accepted, in the default mode only', async () => {
  const open = 'Window: "Open", App: TextEdit.\n0 standard window Open, ID: open-panel, Secondary Actions: Raise\n\t1 button Cancel';
  const untitled = 'Window: "Untitled 3", App: TextEdit.\n0 standard window Untitled 3\n\t1 button Save, ID: Save';
  const saved = tree({ title: 'b.txt', app: 'TextEdit', url: 'file:///tmp/x/b.txt' });
  const other = tree({ title: 'c.txt', app: 'TextEdit', url: 'file:///tmp/c.txt' });
  // [code, the action after which the window changes, the window then, options, stopped]
  for (const [code, trigger, after, options, stopped] of [
    ['await app.pressKey("super+o"); await app.pressKey("super+shift+g");', 'super+o', open, { adoptUrl: true }, false],
    ['await app.pressKey("super+n"); await app.pressKey("super+shift+t");', 'super+n', untitled, { adoptUrl: true }, false],
    ['await app.typeText("/tmp/x/b.txt"); await app.pressKey("Return"); await app.click({ id: "Save" });', 'Return', saved, { adoptUrl: true }, false],
    // Not this call's name, not after an opening action, or a strict mode: still a stop.
    ['await app.pressKey("super+o"); await app.pressKey("super+shift+g");', 'super+o', other, { adoptUrl: true }, true],
    ['await app.typeText("abc"); await app.click({ id: "Save" });', 'abc', untitled, { adoptUrl: true }, true],
    ['await app.pressKey("super+n"); await app.pressKey("super+shift+t");', 'super+n', untitled, {}, true]]) {
    let changed = false;
    const f = fixture({ current: () => changed ? after : tree(), action: (name, args) => { if (args[0] === trigger) changed = true; } });
    const done = f.run(code, options);
    if (stopped) await assert.rejects(done, /changed window/, code); else await done;
  }
});

for (const role of ['sheet', 'dialog']) {
  test(`a click continues into its own app's titled ${role}`, async () => {
    let changed = false;
    const modal = `Window: "Confirm removal", App: TextEdit.\n0 ${role}\n\t9 button Delete Group`;
    const f = fixture({ current: () => changed ? modal : tree(expected, '\t19 button Remove Group'),
      action: name => { if (name === 'click') changed = true; } });
    await f.run('await app.click(19); await app.click({ label: "Delete Group" });', { adoptUrl: true });
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19, 9]);
  });
}

test('a click cannot continue into another app or a different document window', async () => {
  for (const after of [
    'Window: "Confirm removal", App: Other.\n0 sheet\n\t9 button Delete Group',
    'Window: "Other document", App: TextEdit.\n0 standard window\n\t9 button Delete Group',
    'Window: "Confirm removal", App: TextEdit.\n0 dialog, URL: file:///tmp/other.txt\n\t9 button Delete Group',
  ]) {
    let changed = false;
    const f = fixture({ current: () => changed ? after : tree(expected, '\t19 button Remove Group'),
      action: name => { if (name === 'click') changed = true; } });
    await assert.rejects(f.run('await app.click(19); await app.click({ label: "Delete Group" });', { adoptUrl: true }), /changed window/);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
  }
});

test('waitFor follows a titled sheet opened by the preceding click', async () => {
  let changed = false;
  const modal = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
  const f = fixture({ current: () => changed ? modal : tree(expected, '\t19 button Remove Group'),
    action: name => { if (name === 'click') changed = true; } });
  await f.run('await app.click(19); await app.waitFor({ label: "Delete Group" }); await app.click({ label: "Delete Group" });', { adoptUrl: true });
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19, 9]);
});

test('a non-click action cannot adopt a sheet, including an untitled sheet', async () => {
  for (const title of ['Confirm removal', '']) {
    let changed = false;
    const modal = `Window: ${JSON.stringify(title)}, App: TextEdit.\n0 sheet\n\t9 button Delete Group`;
    const f = fixture({ current: () => changed ? modal : tree(), action: () => { changed = true; } });
    await assert.rejects(f.run('await app.typeText("x"); await app.click({ label: "Delete Group" });', { adoptUrl: true }), /changed window/);
    assert.equal(f.calls.some(c => c[0] === 'click'), false);
  }
});

test('a sheet already present before the click cannot be adopted as its result', async () => {
  for (const role of ['sheet', 'dialog']) {
    let changed = false;
    const before = tree(expected, `\t19 button Remove Group\n\t20 ${role} Existing confirmation`);
    const after = `Window: "Confirm removal", App: TextEdit.\n0 ${role}\n\t9 button Delete Group`;
    const f = fixture({ current: () => changed ? after : before, action: () => { changed = true; } });
    await assert.rejects(f.run('await app.click(19); await app.click({ label: "Delete Group" });', { adoptUrl: true }), /changed window/);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
  }
});

test('a numeric click into a sheet that was already present stops before input', async () => {
  let changed = false;
  const before = tree(expected, '\t19 button Remove Group\n\t20 sheet Existing confirmation\n\t9 button Delete Group');
  const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
  const f = fixture({ current: () => changed ? after : before, action: () => { changed = true; } });
  await assert.rejects(f.run('await app.click(19); await app.click(9);', { adoptUrl: true }), /changed window/);
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
});

test('an explicit first read after a click cannot authorize a later sheet', async () => {
  for (const read of ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot']) {
    let reads = 0;
    const before = tree(expected, '\t19 button Remove Group');
    const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
    const f = fixture({ current: () => ++reads <= 2 ? before : after });
    await assert.rejects(f.run(`await app.click(19); await app.${read}(); await app.getAXState(); await app.click({ label: "Delete Group" });`, { adoptUrl: true }), /changed window/);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
  }
});

test('repeated explicit reads preserve a sheet seen on the first read after the click', async () => {
  for (const read of ['getAXState', 'getAXStateAndScreenshot', 'getScreenshot']) {
    let changed = false;
    const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
    const f = fixture({ current: () => changed ? after : tree(expected, '\t19 button Remove Group'), action: () => { changed = true; } });
    await f.run(`await app.click(19); await app.${read}(); await app.getAXState(); await app.click({ label: "Delete Group" });`, { adoptUrl: true });
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19, 9]);
  }
});

test('waitFor cannot adopt a sheet without a preceding click', async () => {
  for (const title of ['Confirm removal', '']) {
    const after = `Window: ${JSON.stringify(title)}, App: TextEdit.\n0 sheet\n\t9 button Delete Group`;
    const f = fixture({ current: () => after });
    await assert.rejects(f.run('await app.waitFor({ label: "Delete Group" }, { timeoutMs: 0 });', { adoptUrl: true }), /waitFor stopped/);
  }
});

test('waitFor adopts only a sheet on its first read after the click', async () => {
  let reads = 0;
  const before = tree(expected, '\t19 button Remove Group');
  const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
  const f = fixture({ current: () => ++reads <= 2 ? before : after });
  f.context.setTimeout = resolve => resolve();
  await assert.rejects(f.run('await app.click(19); await app.waitFor({ label: "Delete Group" }, { timeoutMs: 1000 });', { adoptUrl: true }), /waitFor stopped/);
  assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
});

test('a typed document name cannot authorize a sheet that appeared after the first read', async () => {
  for (const wait of [false, true]) {
    let reads = 0;
    const before = tree(expected, '\t19 button Remove Group');
    const after = 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t9 button Delete Group';
    const f = fixture({ current: () => ++reads <= 3 ? before : after });
    f.context.setTimeout = resolve => resolve();
    const tail = wait ? 'await app.waitFor({ label: "Delete Group" }, { timeoutMs: 1000 });'
      : 'await app.getAXState(); await app.getAXState(); await app.click({ label: "Delete Group" });';
    await assert.rejects(f.run(`await app.typeText("Confirm removal"); await app.click(19); ${tail}`, { adoptUrl: true }), /changed window|waitFor stopped/);
    assert.deepEqual(f.calls.filter(c => c[0] === 'click').map(c => c[1]), [19]);
  }
});
