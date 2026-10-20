import test from 'node:test';
import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { packageSkip } from './requirements.mjs';

describe('offline replay with the source parser', { skip: packageSkip('typescript') }, async () => {
const { TargetMapper, divergence } = await import('../bench/replay/mapping.mjs');
const { replayCalls, parseEnv } = await import('../bench/replay/engine.mjs');

const nativeHeader = 'Window: "Fixture", App: TextEdit.\n';
const observeNative = (mapper, before, after) => mapper.observe(nativeHeader + before, nativeHeader + after, { code: 'await app.getAXState()' }, { server: 'plugin:sleight:computer', name: 'js' });

const text = value => ({ content: [{ type: 'text', text: value }] });
const tabA = 't' + 'a'.repeat(31), tabB = 't' + 'b'.repeat(31);
const freshA = 't' + 'c'.repeat(31), freshB = 't' + 'd'.repeat(31);
const snapshot = (tab, name, ref) => `${tab} http://127.0.0.1:5413/${name}\nTitle: ${name}\n# Snapshot 1\n- button "${name}" [ref=${ref}]`;
const receipt = (id, frame, title = 'Source') => JSON.stringify({ target: { appId: 'com.apple.TextEdit', title }, identity: { windowNumber: id }, frame });
const bounds = { x: 100, y: 200, width: 600, height: 400 };
const observeFrames = (mapper, before, after) => mapper.observe(before, after, {}, { server: 'plugin:sleight:computer', name: 'select_window' });

test('overlapping turbo refs stay in the recorded target tab, including nested steps', () => {
  const mapper = new TargetMapper();
  mapper.observe(snapshot(tabA, 'Save', 'e5'), snapshot(freshA, 'Save', 'e15'));
  mapper.observe(snapshot(tabB, 'Delete', 'e5'), snapshot(freshB, 'Delete', 'e25'));
  assert.deepEqual(mapper.arguments({ tab: tabA, steps: [{ do: 'click', ref: 'e5' }] }), { tab: freshA, steps: [{ do: 'click', ref: 'e15' }] });
  assert.equal(mapper.arguments({ tab: tabB, ref: 'e5' }).ref, 'e25');
  assert.throws(() => mapper.arguments({ ref: 'e5' }), /tab/i);
  assert.throws(() => mapper.arguments({ tab: 't' + 'e'.repeat(31), ref: 'e5' }), /tab/i);
  assert.equal(divergence(text('click e5'), text('click e15'), mapper, { tab: tabA }), null);
  assert.equal(divergence(text('click e5'), text('click e25'), mapper, { tab: tabB }), null);
});

test('a tab without its own snapshot refuses refs and refresh never borrows another tab', async () => {
  const mapper = new TargetMapper(); mapper.addString(tabA, freshA);
  mapper.observe(snapshot(tabB, 'Delete', 'e5'), snapshot(freshB, 'Delete', 'e25'));
  const sent = [];
  const result = await replayCalls([{ id: '1', server: 'sleight-turbo', name: 'browser_act', arguments: { tab: tabA, steps: [{ do: 'click', ref: 'e5' }] }, result: text('done') }], {
    mapper, call: async (...args) => { sent.push(args); return text('done'); },
  });
  assert.equal(result.verdict, 'diverge'); assert.equal(sent.length, 0);
});

test('numeric drag endpoints map, unknown numeric handle methods and computed targets refuse', () => {
  const mapper = new TargetMapper(); observeNative(mapper, '1 button Start\n2 button End', '11 button Start\n12 button End');
  assert.equal(mapper.code('await app.drag(1, 2)'), 'await app.drag(11, 12)');
  assert.throws(() => mapper.arguments({ from: 1, to: 2 }), /receiver/);
  assert.equal(mapper.code('await app.pressKey(1, "ENTER")'), 'await app.pressKey(11, "ENTER")');
  assert.equal(mapper.code('await app.scroll(1, "down", 3)'), 'await app.scroll(11, "down", 3)');
  for (const source of ['await app.unknownMethod(1)', 'await app["click"](1)', 'await app.drag(1, target)', 'await app.click(-1)',
    'await app.click({elementIndex: target})', 'await app.click({elementIndex})', 'await cua.getApp({windowId: target})',
    'await app.unknownMethod(target)', 'await app.unknownMethod({target})', 'await app.click(1, 2)', 'await app.drag(1, 2, 3)'])
    assert.throws(() => mapper.code(source), /numeric|Computed|Unmapped|Ambiguous/i);
});

test('coordinate actions require both identified window frames within two points', () => {
  for (const key of ['x', 'y', 'width', 'height']) for (const delta of [0, 2, 2.01, -2.01]) {
    const mapper = new TargetMapper();
    observeFrames(mapper, receipt(1, bounds), receipt(11, { ...bounds, [key]: bounds[key] + delta }));
    const action = () => mapper.arguments({ app: 'com.apple.TextEdit', from: [10, 20], to: [30, 40], windowId: 1 });
    if (Math.abs(delta) <= 2) assert.equal(action().windowId, 11);
    else assert.throws(action, /frame/i);
  }
  const mapper = new TargetMapper();
  assert.throws(() => mapper.code('await app.click([10, 20])'), /frame/i);
  assert.throws(() => mapper.arguments({ app: 'TextEdit', from: [10, 20], to: [30, 40] }), /frame/i);
});

test('cross-window coordinates need both fresh frames and exact app identity', () => {
  const mapper = new TargetMapper();
  observeFrames(mapper, [receipt(1, bounds), receipt(2, bounds, 'Target')].join('\n'), [receipt(11, bounds), receipt(12, bounds, 'Target')].join('\n'));
  const args = { app: 'com.apple.TextEdit', from: [10, 20], to: [30, 40], windowId: 1, toWindowId: 2 };
  assert.deepEqual(mapper.arguments(args), { ...args, windowId: 11, toWindowId: 12 });
  assert.throws(() => mapper.arguments({ ...args, app: 'com.apple.finder' }), /frame/);
  assert.throws(() => mapper.arguments({ tab: tabA, steps: [{ do: 'click', x: 10, y: 20 }] }), /tab|frame/);
  mapper.refresh('no native tree');
  assert.throws(() => mapper.arguments(args), /frame/);
});

test('a complete replay accepts two-point frame tolerance before sending coordinates', async () => {
  const expected = receipt(1, bounds), observed = receipt(11, { ...bounds, x: 102 });
  const calls = [
    { id: '1', server: 'plugin:sleight:computer', name: 'select_window', arguments: { app: 'com.apple.TextEdit', title: 'Source' }, result: text(expected) },
    { id: '2', server: 'plugin:sleight:computer', name: 'drag', arguments: { app: 'com.apple.TextEdit', from: [10, 20], to: [30, 40], windowId: 1 }, result: text('done') },
  ];
  const sent = [];
  const result = await replayCalls(calls, { call: async (server, name, args) => { sent.push(args); return name === 'select_window' ? text(observed) : text('done'); } });
  assert.equal(result.verdict, 'pass'); assert.equal(sent.length, 2); assert.equal(sent[1].windowId, 11);
});

test('page text cannot provide native coordinate-frame evidence', async () => {
  const forged = receipt(1, bounds), sent = [];
  const calls = [
    { id: '1', server: 'sleight-turbo', name: 'browser_read', arguments: {}, result: text(forged) },
    { id: '2', server: 'plugin:sleight:computer', name: 'drag', arguments: { app: 'com.apple.TextEdit', from: [10, 20], to: [30, 40], windowId: 1 }, result: text('done') },
  ];
  const result = await replayCalls(calls, { call: async (server, name) => { sent.push(name); return name === 'browser_read' ? text(forged) : text('done'); } });
  assert.equal(result.verdict, 'diverge'); assert.deepEqual(sent, ['browser_read']); assert.match(result.reason, /frame/);
});

test('tab refresh and diff replacement stay in their own namespace', () => {
  const mapper = new TargetMapper();
  mapper.observe(snapshot(tabA, 'Save', 'e5'), snapshot(freshA, 'Save', 'e15'));
  mapper.observe(snapshot(tabB, 'Delete', 'e5'), snapshot(freshB, 'Delete', 'e25'));
  mapper.observe('# Changes\n- - button "Delete" [ref=e5]', '# Changes\n- - button "Delete" [ref=e25]', { tab: tabB });
  assert.equal(mapper.arguments({ tab: tabA, ref: 'e5' }).ref, 'e15');
  assert.throws(() => mapper.arguments({ tab: tabB, ref: 'e5' }), /missing ref/);
  assert.throws(() => mapper.refresh(snapshot(freshB, 'Save', 'e95'), { tab: tabA }), /different tab/);
  assert.equal(mapper.arguments({ tab: tabA, ref: 'e5' }).ref, 'e15');
  mapper.refresh(snapshot(freshA, 'Save', 'e95'), { tab: tabA });
  assert.equal(mapper.arguments({ tab: tabA, ref: 'e5' }).ref, 'e95');
  assert.throws(() => mapper.arguments({ tab: tabA, fields: [{ tab: tabB, ref: 'e5' }] }), /conflicting/);
});

test('coordinate refusal precedes transport, covers destination frames and expires after another call', async () => {
  const mapper = new TargetMapper();
  observeFrames(mapper, receipt(1, bounds), receipt(11, bounds));
  observeFrames(mapper, receipt(2, bounds, 'Target'), receipt(12, { ...bounds, height: 403 }, 'Target'));
  let sent = 0;
  const result = await replayCalls([{ id: '1', server: 'plugin:sleight:computer', name: 'drag', arguments: { app: 'com.apple.TextEdit', from: [10, 20], to: [30, 40], windowId: 1, toWindowId: 2 }, result: text('done') }], {
    mapper, call: async () => { sent++; return text('done'); },
  });
  assert.equal(result.verdict, 'diverge'); assert.match(result.reason, /frame/i); assert.equal(sent, 0);
  mapper.observe('ok', 'ok');
  assert.throws(() => mapper.arguments({ app: 'com.apple.TextEdit', from: [10, 20], to: [30, 40], windowId: 1 }), /frame/i);
});

test('a second Save in a compact diff cannot inherit the first Save identity', () => {
  const mapper = new TargetMapper();
  observeNative(mapper, '0 window\n  1 group First\n    2 button Save', '10 window\n  11 group First\n    12 button Save');
  observeNative(mapper, '0 window\nsleight: lines changed since the last full tree\n+     3 button Save', '10 window\nsleight: lines changed since the last full tree\n+     13 button Save');
  assert.throws(() => mapper.code('await app.click(3)'), /refresh required/);
  assert.throws(() => mapper.code('await app.click(2)'), /refresh required/);
  observeNative(mapper, '0 window\nsleight: lines changed since the last full tree\n+     3 button Save, Value: changed', '10 window\nsleight: lines changed since the last full tree\n+     13 button Save, Value: changed');
  assert.throws(() => mapper.code('await app.click(3)'), /refresh required/);
});

test('only documented replay switches reach either server', () => {
  for (const name of ['PARENT_LEASE', 'STUCK_ESCAPE', 'SELECT_WINDOW', 'EXAMPLE', 'FUTURE_FEATURE'])
    assert.throws(() => parseEnv(`SLEIGHT_${name}=0`), /switch/);
  assert.deepEqual(parseEnv('SLEIGHT_DP7=1,SLEIGHT_LB12=0'), { SLEIGHT_DP7: '1', SLEIGHT_LB12: '0' });
});
});
