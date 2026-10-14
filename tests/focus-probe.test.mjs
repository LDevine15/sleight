import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseArgs, focusReady, waitForFocus, runTrial, cleanupOwned, summarize, folderPath, startHelper } from '../bench/focus-probe.mjs';

const base = { status: 'ok', epoch: 'probe', pid: 12, processStart: 123, surface: 1, element: 2,
  role: 'AXTextArea', subrole: null, windowRole: 'AXWindow', windowSubrole: 'AXStandardWindow', owned: true };
const ready = { ...base, surface: 3, element: 4, role: 'AXTextField', windowRole: 'AXSheet' };
const clock = () => { let time = 0; return { now: () => time, sleep: async ms => { time += ms; } }; };

test('arguments default to 20 alternating trials per arm and accept only bounded load', () => {
  assert.deepEqual(parseArgs([]), { workers: 0, trials: 20, help: false });
  assert.equal(parseArgs(['--workers', '20']).workers, 20);
  assert.equal(parseArgs(['--help']).help, true);
  for (const args of [['--workers'], ['--workers', '-1'], ['--workers', '21'], ['--workers', '1x'], ['--trials', '0'], ['--unknown']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('focus requires editable focus in a new owned sheet or dialog in the same process incarnation', () => {
  assert.equal(focusReady(ready, base), true);
  for (const change of [{ surface: 1 }, { owned: false }, { role: 'AXButton' }, { pid: 13 },
    { processStart: 124 }, { epoch: 'other' }, { windowRole: 'AXWindow', windowSubrole: 'AXStandardWindow' }, { element: null }]) {
    assert.equal(focusReady({ ...ready, ...change }, base), false);
  }
  assert.equal(focusReady({ ...ready, windowRole: 'AXWindow', windowSubrole: 'AXDialog' }, base), true);
});

test('poller waits two polls on the same editable element, resetting on an old window', async () => {
  const samples = [ready, base, ready, { ...ready, element: 5 }, { ...ready, element: 5 }], c = clock();
  const result = await waitForFocus({ baseline: base, observe: async () => samples.shift(), ...c });
  assert.equal(result.reason, null);
  assert.equal(result.polls, 5);
  assert.equal(result.waitMs, 80);
});

test('AX error falls back immediately and old focus caps at 1.5 seconds', async () => {
  for (const observe of [async () => ({ status: 'unknown', error: 'AX error -25204' }), async () => { throw new Error('unavailable'); }]) {
    const result = await waitForFocus({ baseline: base, observe, ...clock() });
    assert.equal(result.reason, 'ax-error');
    assert.equal(result.polls, 1);
  }
  const result = await waitForFocus({ baseline: base, observe: async () => base, ...clock() });
  assert.equal(result.reason, 'cap');
  assert.equal(result.waitMs, 1500);
});

test('unavailable baseline never releases input and late ready replies do not beat the cap', async () => {
  assert.equal((await waitForFocus({ baseline: { status: 'unknown' }, observe: async () => ready, ...clock() })).reason, 'baseline-error');
  let time = 0;
  const result = await waitForFocus({ baseline: base, observe: async () => { time += 800; return ready; },
    now: () => time, sleep: async ms => { time += ms; } });
  assert.equal(result.reason, 'cap');
});

function ports({ badPath = false, changed = false, arm = 'focus', axError = false } = {}) {
  const events = [], states = [base, ready, ready, ready, { ...ready, surface: 6, element: 7 }, { ...ready, surface: 6, element: 7 }];
  let typed = false;
  return { events, options: { arm, path: '/owned/path', index: 1, ...clock(),
    call: async code => { events.push(code); if (code.includes('typeText')) typed = true; return { content: [] }; },
    observe: async () => axError ? { status: 'unknown' } : states.shift(),
    fixture: async op => {
      if (op === 'open') return { openBound: true };
      if (op === 'field') return { value: badPath ? 'path' : '/owned/path', documentUnchanged: !changed };
      if (op === 'document') return { documentUnchanged: !typed || !changed, clean: !typed };
      throw new Error('Unsupported fixture operation ' + op);
    },
  } };
}

test('trial orders openers, barriers, full path, Return and exactly one final read', async () => {
  const p = ports(), trial = await runTrial(p.options);
  assert.equal(trial.correct, true);
  assert.deepEqual(p.events, ['await app.pressKey("super+o")', 'await app.pressKey("super+shift+g")',
    'await app.typeText("/owned/path")', 'await app.pressKey("Return")', 'await app.getAXState({ disableDiffing: true })']);
  assert.equal(trial.waits.length, 2);
});

test('persistent helper ignores mismatched replies and collects only its owned child', async () => {
  const child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
  child.kill = () => { throw new Error('Unexpected signal'); };
  child.stdin.on('finish', () => child.emit('close', 0, null));
  const helper = startHelper('./unused.js', [], { spawnHelper: () => child });
  child.stdout.write('{"status":"unsolicited"}\n');
  const request = helper.request({ op: 'focus' });
  const sent = JSON.parse(child.stdin.read().toString());
  child.stdout.write(JSON.stringify({ id: sent.id + 1, status: 'wrong' }) + '\n');
  child.stdout.write(JSON.stringify({ id: sent.id, status: 'ok' }) + '\n');
  assert.equal((await request).status, 'ok');
  assert.deepEqual(await helper.close(), { code: 0, signal: null });
});

test('a timed-out helper is retired and cannot queue a second AX observation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) child[name] = new PassThrough();
  child.stdin.on('finish', () => child.emit('close', 0, null));
  const helper = startHelper('./unused.js', [], { spawnHelper: () => child });
  const request = helper.request({ op: 'focus' }, 100);
  const rejected = assert.rejects(request, /deadline/);
  t.mock.timers.tick(100); await rejected;
  await assert.rejects(helper.request({ op: 'focus' }), /deadline/);
  await helper.close();
});

test('persistent AX metadata helper observes an owned attached sheet without reading values', () => {
  const path = '/private/tmp/sleight-exact-AbCd12/exact.txt';
  const array = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const root = { AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow', AXDocument: 'file://' + path };
  const sheet = { AXRole: 'AXSheet', AXParent: root };
  const field = { AXRole: 'AXTextField', AXParent: sheet, AXWindow: root };
  const app = { AXWindows: array([root]), AXFocusedUIElement: field };
  const frames = ['{"id":0,"op":"bind"}\n', '{"id":1,"op":"focus"}\n', '{"id":2,"op":"attribute"}\n', ''], replies = [], reads = [], timeouts = [];
  const dollar = value => ({ value, dataUsingEncoding: () => value });
  Object.assign(dollar, {
    NSUUID: { UUID: { UUIDString: 'epoch' } },
    NSURL: { fileURLWithPath: value => ({ absoluteString: 'file://' + value }) },
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => array([{ processIdentifier: 12, launchDate: { timeIntervalSince1970: 123 } }]) },
    AXIsProcessTrusted: () => true, AXUIElementCreateApplication: () => app,
    AXUIElementSetMessagingTimeout: (_element, timeout) => { timeouts.push(timeout); return 0; },
    AXUIElementCopyAttributeValue: (element, name, ref) => {
      reads.push(name.value); assert.notEqual(name.value, 'AXValue');
      if (!(name.value in element)) return -25212;
      ref[0] = element[name.value]; return 0;
    },
    CFEqual: (a, b) => a === b,
    NSFileHandle: { fileHandleWithStandardInput: { get availableData() { return frames.shift(); } },
      fileHandleWithStandardOutput: { writeData: value => replies.push(JSON.parse(value)) } },
    NSString: { alloc: { initWithDataEncoding: value => value } }, NSUTF8StringEncoding: 4,
  });
  vm.runInNewContext(readFileSync(new URL('../bench/focus-probe-ax.js', import.meta.url), 'utf8') + `\nrun(${JSON.stringify([path])});`, {
    $: dollar, ObjC: { import: () => {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value }, Ref: () => [],
  });
  assert.equal(replies[0].status, 'ok');
  assert.equal(replies[1].status, 'ok');
  assert.equal(replies[1].windowRole, 'AXSheet');
  assert.equal(replies[1].owned, true);
  assert.equal(replies[2].status, 'ok');
  assert.ok(timeouts.includes(1));
  assert.ok(timeouts.includes(0.1));
  assert.equal(reads.at(-1), 'AXRole');
});

test('read arm reads after each opener, and focus AX errors invoke the same fallback', async () => {
  for (const setup of [{ arm: 'read' }, { axError: true }]) {
    const p = ports(setup), trial = await runTrial(p.options);
    assert.equal(trial.correct, true);
    assert.equal(p.events.filter(code => code.includes('getAXState')).length, 3);
    if (setup.axError) assert.ok(trial.waits.every(wait => wait.reason === 'baseline-error'));
  }
});

function fixtureReplies({ nested = true, extraField = false, search = false, foreign = false, close = false } = {}) {
  const path = '/private/tmp/sleight-exact-AbCd12/exact.txt', array = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const area = { AXRole: 'AXTextArea', AXValue: 'SR1 owned fixture\n' };
  const root = { AXRole: 'AXWindow', AXDocument: 'file://' + path, AXChildren: array([area]) };
  const open = { AXRole: 'AXWindow', AXSubrole: 'AXDialog' };
  const sheet = { AXRole: 'AXSheet', AXParent: foreign ? root : open };
  const field = { AXRole: 'AXTextField', AXSubrole: search ? 'AXSearchField' : null,
    AXWindow: open, AXParent: nested ? sheet : open, AXValue: '/owned/path' };
  sheet.AXChildren = array(extraField ? [field, { AXRole: 'AXTextField' }] : [field]);
  open.AXChildren = array([sheet]);
  let phase = -1, closed = false;
  const ax = { get AXWindows() { return array(phase < 2 ? [root] : [root, open]); },
    get AXFocusedUIElement() { return phase < 3 ? { AXRole: 'AXTextField', AXWindow: open, AXParent: open } : field; } };
  const frames = ['{"id":0,"op":"preflight"}\n', '{"id":1,"op":"attach"}\n', '{"id":2,"op":"open"}\n',
    '{"id":3,"op":"field"}\n', ...(close ? ['{"id":4,"op":"close"}\n'] : []), ''], replies = [];
  const dollar = value => ({ value, dataUsingEncoding: () => value });
  Object.assign(dollar, {
    NSURL: { fileURLWithPath: value => ({ absoluteString: 'file://' + value }) },
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => array([{ processIdentifier: 12, launchDate: { timeIntervalSince1970: 123 } }]) },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 17, bundleIdentifier: 'org.fixture.foreground' } } },
    AXIsProcessTrusted: () => true, AXUIElementCreateApplication: () => ax, AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, ref) => { if (!(name.value in element)) return -25212; ref[0] = element[name.value]; return 0; },
    CFEqual: (a, b) => a === b,
    NSFileHandle: { fileHandleWithStandardInput: { get availableData() { phase++; return frames.shift(); } },
      fileHandleWithStandardOutput: { writeData: value => replies.push(JSON.parse(value)) } },
    NSString: { alloc: { initWithDataEncoding: value => value } }, NSUTF8StringEncoding: 4,
  });
  const doc = { path: () => path, close() { closed = true; } };
  vm.runInNewContext(readFileSync(new URL('../bench/focus-probe-fixture.js', import.meta.url), 'utf8') + `\nrun(${JSON.stringify([path])});`, {
    $: dollar, ObjC: { import() {}, unwrap: value => value, deepUnwrap: value => value, castRefToObject: value => value },
    Ref: () => [], Application: () => ({ running: () => false, documents: () => [doc] }),
  });
  return { replies, closed };
}

test('fixture binds the Open modal and accepts only its new nested path sheet', () => {
  const { replies } = fixtureReplies();
  assert.equal(replies[1].attached, true); assert.equal(replies[2].openBound, true);
  assert.equal(replies[3].ok, true); assert.equal(replies[3].value, '/owned/path');
});

for (const options of [{ nested: false }, { extraField: true }, { search: true }, { foreign: true }])
  test('fixture refuses an unrelated or ambiguous path field: ' + JSON.stringify(options), () => {
    const { replies } = fixtureReplies(options);
    assert.equal(replies[3].ok, false);
  });

test('fixture refuses document close while the ambiguous panel remains', () => {
  const { replies, closed } = fixtureReplies({ extraField: true, close: true });
  assert.equal(replies.at(-1).ok, false); assert.equal(closed, false);
});

test('trial stops before the Go shortcut if the Open modal cannot be bound', async () => {
  const p = ports(), fixture = p.options.fixture;
  p.options.fixture = async op => { if (op === 'open') throw new Error('Open modal unproved'); return fixture(op); };
  const trial = await runTrial(p.options);
  assert.equal(trial.correct, false); assert.equal(p.events.includes('await app.pressKey("super+shift+g")'), false);
});

test('cut path or document input is recorded as incorrect and aborts before Return', async () => {
  for (const setup of [{ badPath: true }, { changed: true }]) {
    const p = ports(setup), trial = await runTrial(p.options);
    assert.equal(trial.correct, false);
    assert.ok(trial.error);
    assert.equal(p.events.includes('await app.pressKey("Return")'), false);
  }
});

test('engine errors stop the suffix without retrying an action', async () => {
  const p = ports(); p.options.call = async code => { p.events.push(code); return { isError: true }; };
  const trial = await runTrial(p.options);
  assert.equal(trial.correct, false);
  assert.equal(p.events.length, 1);
});

test('cleanup inventories every owned resource, continues after failure, retains bank and lock if closure is unconfirmed', async () => {
  const events = [], item = name => async () => { events.push(name); };
  const result = await cleanupOwned({ fixture: async () => { events.push('fixture'); throw new Error('unconfirmed'); },
    engine: item('engine'), observer: item('observer'), workers: item('workers'), bank: item('bank'), lock: item('lock') });
  assert.deepEqual(events, ['fixture', 'engine', 'observer', 'workers']);
  assert.equal(result.confirmed, false);
  assert.equal(result.lockRetained, true);
  const clean = await cleanupOwned(Object.fromEntries(['fixture', 'engine', 'observer', 'workers', 'bank', 'lock'].map(name => [name, item(name)])));
  assert.equal(clean.confirmed, true);
  assert.deepEqual(events.slice(4), ['fixture', 'engine', 'observer', 'workers', 'bank', 'lock']);
});

test('127-character owned folder path and kill rule use trial medians including fallback costs', () => {
  const path = folderPath('/private/tmp/sleight-exact-AbCd12');
  assert.equal(path.length, 127);
  assert.ok(path.startsWith('/private/tmp/sleight-exact-AbCd12/'));
  const trials = [100, 200].map(totalCallMs => ({ arm: 'focus', totalCallMs, correct: true }));
  trials.push(...[700, 800].map(totalCallMs => ({ arm: 'read', totalCallMs, correct: true })));
  assert.equal(summarize(trials, 2).kill, false);
  trials[0].correct = false;
  assert.equal(summarize(trials, 2).kill, true);
  assert.equal(summarize(trials.slice(1), 2).qualified, false);
});
