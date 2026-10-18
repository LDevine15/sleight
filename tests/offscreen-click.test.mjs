// Safari form-settings r1 and r3 (race-1017): both cmd-clicked Japanese (49), a row below the Languages list's
// visible part, and read "UI changed (value)" for Portuguese (Brazil) or nothing at all. The tree is r1's, recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';
import { unchangedListClicks, offscreenNotes, withOffscreenNotes } from '../plugins/sleight/lib/offscreen-click.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const recorded = readFileSync(new URL('fixtures/safari-settings-r1.txt', import.meta.url), 'utf8').replace(/\n+$/, '');
const portuguese = '\t\t\t\t\t\t\t45 text (selectable) Portuguese (Brazil)';
const selected = recorded.replace(portuguese, portuguese.replace('selectable', 'selected'));
const text = value => ({ type: 'text', text: value });
const R1 = 'await app.click(45); await app.click(49, { key: "cmd" }); await app.getAXState();';
const R3 = 'let app = await cua.getApp("Safari");\nawait app.click(49, { key: "command" });\nawait app.getAXState();';
const window = { app: 'Safari', title: 'sleight benchmark — Settings · Relaybox' };
const outside = { status: 'ok', inside: false, direction: 'down', pages: 1 };
const NOTE = 'sleight: 49 is outside the visible part of 36 list, so this click didn\'t reach it. Scroll it into view with `await app.scroll(36, "down", 1)`, then click it again.';

function call(before, after, code) {
  const c = createReadCompactor();
  c.process([text(before)]);
  const action = c.beginAction(code);
  const out = c.process([text(GUARD_MARK + after + GUARD_END)], { action, code }).map(item => item.text).join('\n');
  return { out, clicks: c.listClicks() };
}

test('r1: the cmd-click on Japanese left its row unchanged inside list 36, while Portuguese was selected', () => {
  const { out, clicks } = call(recorded, selected, R1);
  assert.match(out, /sleight: UI changed \(value\)\./, 'the misleading line the run read');
  assert.equal(clicks.length, 1);
  const [click] = clicks;
  assert.equal(click.handle, 'app'); assert.equal(click.number, 49);
  assert.deepEqual(click.container, { number: 36, role: 'list', body: 'list Languages' });
  assert.equal(click.lines.length, 16); assert.equal(click.lines[click.index], 'text (selectable) Japanese'); assert.equal(click.index, 12);
  assert.equal(click.window.title, window.title);
});

test('r3: a modifier click that changed nothing is checked too', () => {
  const { clicks } = call(selected, selected, R3);
  assert.deepEqual(clicks.map(click => [click.number, click.container.number]), [[49, 36]]);
});

test('a row the click changed, a coordinate click, a click outside a list and a failed call are not checked', () => {
  assert.deepEqual(call(recorded, selected, 'await app.click(45); await app.getAXState();').clicks, []);
  assert.deepEqual(call(recorded, recorded, 'await app.click([400, 620], { key: "cmd" }); await app.getAXState();').clicks, []);
  assert.deepEqual(call(recorded, recorded, 'await app.click(67); await app.getAXState();').clicks, [], 'Save sits in no list');
  const c = createReadCompactor();
  c.process([text(recorded)]);
  c.process([text(GUARD_MARK + recorded + GUARD_END)], { action: c.beginAction(R3), code: R3, failed: true });
  assert.deepEqual(c.listClicks(), []);
  assert.deepEqual(unchangedListClicks('await app.click(49)', recorded.split('\n'), selected.split('\n').filter(line => !/Japanese/.test(line))), []);
});

test('an outside answer becomes the note, in place of the UI changed field; inside, unsure and failing helpers add nothing', async () => {
  const { clicks } = call(recorded, selected, R1);
  const requests = [];
  const ask = reply => async request => { requests.push(request); if (reply instanceof Error) throw reply; return reply; };
  assert.deepEqual(await offscreenNotes(clicks, ask(outside), window), [NOTE]);
  assert.deepEqual(requests[0], { app: 'Safari', title: window.title, container: 'list Languages', lines: clicks[0].lines, index: 12 });
  assert.ok(JSON.stringify(requests[0]).length < 3500, 'fits the helper request line');
  for (const reply of [{ status: 'ok', inside: true }, { status: 'unknown', reason: 'rows' }, undefined, new Error('helper gone'),
    { status: 'ok', inside: false, direction: 'sideways' }]) assert.deepEqual(await offscreenNotes(clicks, ask(reply), window), []);
  const [lean] = await offscreenNotes(clicks, ask({ ...outside, pages: 3 }), window, 'lean');
  assert.match(lean, /`await app\.scroll\(36, "down", 3\)`/);
  assert.ok(lean.length <= NOTE.length * 0.71, `${lean.length} of ${NOTE.length}`);
  assert.deepEqual(withOffscreenNotes([text('tree'), text('sleight: UI changed (value).')], [NOTE]), [text('tree'), text(NOTE)]);
  assert.deepEqual(withOffscreenNotes([text('sleight: UI changed (value); saved: not confirmed (no document save state change seen).')], [NOTE]),
    [text('sleight: saved: not confirmed (no document save state change seen).'), text(NOTE)]);
  assert.deepEqual(withOffscreenNotes([text('tree')], [NOTE]), [text('tree'), text(NOTE)], 'r3 had no UI line');
  assert.deepEqual(withOffscreenNotes([text('sleight: UI changed (value).')], []), [text('sleight: UI changed (value).')]);
});

function relay(t, elementVisibility) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const output = [], sent = [];
  clientOut.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => output.push(JSON.parse(line))));
  serverIn.on('data', chunk => chunk.toString().trim().split('\n').forEach(line => sent.push(JSON.parse(line))));
  const r = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, elementVisibility });
  t.after(() => { r.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));
  return { output, async js(id, code, reply) {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    await tick();
    const forwarded = sent.findLast(m => m.method === 'tools/call');
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: forwarded.id, result: { content: [text(reply)],
      _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.Safari' } } } } }) + '\n');
    await tick();
    return output.findLast(m => m.id === id)?.result?.content.map(item => item.text).join('\n');
  } };
}

test('through the relay, the r1 result names the offscreen row instead of "UI changed (value)"', async t => {
  const asked = [];
  const h = relay(t, async request => { asked.push(request); return outside; });
  await h.js(1, 'let app = await cua.getApp("Safari"); await app.getAXState();', recorded);
  const out = await h.js(2, R1, selected);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].app, 'com.apple.Safari');
  assert.ok(out.includes(NOTE), out.slice(-600));
  assert.doesNotMatch(out, /UI changed/);
  assert.match(out, /\t45 text \(selected\) Portuguese \(Brazil\)/, 'the tree stays');
});

test('without the helper, or when the row is visible, the relay result is as before', async t => {
  for (const visibility of [undefined, async () => ({ status: 'ok', inside: true })]) {
    const h = relay(t, visibility);
    await h.js(1, 'let app = await cua.getApp("Safari"); await app.getAXState();', recorded);
    const out = await h.js(2, R1, selected);
    assert.match(out, /sleight: UI changed \(value\)\./);
    assert.doesNotMatch(out, /outside the visible part/);
  }
});

test('the app-health helper sends the check as its own op and gives up after 1.5 s', async t => {
  const { EventEmitter } = await import('node:events');
  const { Writable } = await import('node:stream');
  const { createAppHealthHelper } = await import('../plugins/sleight/lib/read-failure.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  const helper = createAppHealthHelper({ timeoutMs: 200, spawnHelper: () => {
    const child = new EventEmitter(); child.stdout = new PassThrough();
    child.stdin = new Writable({ write(data, _encoding, done) {
      const r = JSON.parse(data); seen.push(r);
      if (r.title !== 'stuck') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: r.id, ...outside }) + '\n'));
      done();
    } });
    child.kill = () => { queueMicrotask(() => child.emit('close')); return true; };
    return child;
  } });
  try {
    assert.deepEqual(await helper.elementVisibility({ app: 'Safari', title: window.title, container: 'list Languages', lines: [], index: 0 }), outside);
    assert.equal(seen[0].op, 'element-visibility');
    let resolved = false;
    const stuck = helper.elementVisibility({ app: 'Safari', title: 'stuck' }).then(result => { resolved = true; return result; });
    t.mock.timers.tick(1499); await Promise.resolve();
    assert.equal(resolved, false, 'longer than a probe, shorter than a target');
    t.mock.timers.tick(1);
    assert.deepEqual(await stuck, { status: 'unknown' });
  } finally { await helper.close(); }
});

// element-visibility.js through JXA's bridge, with fakes for the AX C API.
function helper({ rows = 16, extra = 0, containers = 1, trusted = true } = {}) {
  const list = items => ({ count: items.length, objectAtIndex: i => items[i] });
  const $ = value => value;
  const el = (role, x, y, width, height, more = {}) => ({ AXRoleDescription: role, AXPosition: { x, y }, AXSize: { width, height }, AXChildren: [], ...more });
  // The Languages list shows 120 points from y 400; rows are 25 points tall, so row 12 (Japanese) sits at 700 to 725.
  const items = Array.from({ length: rows + extra }, (_, i) => el('text', 340, 400 + 25 * i, 300, 25));
  const lists = Array.from({ length: containers }, () => el('list', 340, 400, 300, 120, { AXDescription: 'Languages', AXChildren: items }));
  const web = el('HTML content', 0, 100, 1000, 700, { AXChildren: [el('text', 340, 380, 100, 20, { AXTitle: 'Languages' }), ...lists] });
  const win = el('standard window', 0, 0, 1000, 800, { AXTitle: window.title, AXChildren: [web] });
  const app = { AXWindows: [win] }, running = { processIdentifier: 42, localizedName: 'Safari' };
  Object.assign($, {
    AXIsProcessTrusted: () => trusted,
    NSRunningApplication: { runningApplicationsWithBundleIdentifier: id => list(id === 'com.apple.Safari' ? [running] : []) },
    NSWorkspace: { sharedWorkspace: { runningApplications: list([running]) } },
    AXUIElementCreateApplication: pid => { assert.equal(pid, 42); return app; },
    AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, name, out) => {
      assert.ok(!['AXValue', 'AXSelectedText'].includes(name), `reads no content (${name})`);
      if (!(name in element)) return -25205;
      out[0] = Array.isArray(element[name]) ? list(element[name]) : element[name]; return 0;
    },
    AXValueGetValue: (value, _type, bytes) => { bytes.value = value; return !!value; },
    NSMutableData: { dataWithLength: () => { const bytes = {}; return { bytes, mutableBytes: bytes }; } },
    NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
  });
  const context = vm.createContext({ $, Ref: () => [], JSON, Math, Number, Array, Set, String, Date,
    ObjC: { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/element-visibility.js', import.meta.url), 'utf8'), context);
  return request => JSON.parse(context.run([JSON.stringify(request)]));
}

test('the helper finds the row by its role order in the list and compares it with the list frame', () => {
  const { clicks } = call(recorded, selected, R1);
  const request = { app: 'com.apple.Safari', title: window.title, container: clicks[0].container.body, lines: clicks[0].lines, index: clicks[0].index };
  assert.deepEqual(helper()(request), { status: 'ok', inside: false, direction: 'down', pages: 2 });
  assert.deepEqual(helper()({ ...request, app: 'Safari' }), { status: 'ok', inside: false, direction: 'down', pages: 2 });
  assert.deepEqual(helper()({ ...request, index: 1 }), { status: 'ok', inside: true });
  assert.deepEqual(helper({ extra: 1 })(request), { status: 'unknown', reason: 'rows' });
  assert.deepEqual(helper({ containers: 2 })(request), { status: 'unknown', reason: 'container' });
  assert.deepEqual(helper()({ ...request, title: 'Other' }), { status: 'unknown', reason: 'window' });
  assert.deepEqual(helper({ trusted: false })(request), { status: 'denied' });
});
