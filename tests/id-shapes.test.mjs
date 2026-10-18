// FT1c: { id } written as an element number or a label. form-travel (race-1017): Haiku sent { id: "18" } for element 18 in
// 2 of 3 Safari runs (r3, and failed-safari-pid-1816 r1 with "18", "20" and "22") and { id: "Reference code" } in r2, which
// reached the field's text label and the engine refused it (-10005, not settable). Each cost a call. The trees are the trace's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { guardedCode, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/document-scope.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

// Safari's URL sits on the HTML content row, not the root, so the header carries none.
const window = { title: 'sleight benchmark — Book a trip · Skyway', app: 'Safari', url: null };
const form = (extra = []) => [`Window: ${JSON.stringify(window.title)}, App: Safari.`,
  `0 standard window ${window.title}, ID: SafariWindow`, '\t1 split group', '\t\t3 tab group', '\t\t\t4 scroll area',
  '\t\t\t\t5 HTML content Description: Book a trip · Skyway, URL: 127.0.0.1:5413/travel', '\t\t\t\t\t8 container',
  '\t\t\t\t\t\t17 text Reference code', '\t\t\t\t\t\t18 text field (settable) Reference code', '\t\t\t\t\t\t19 text Full name',
  '\t\t\t\t\t\t20 text field (settable) Full name', '\t\t\t\t\t\t21 text Email', '\t\t\t\t\t\t22 email field (settable) Email',
  '\t\t\t\t\t\t23 text Dates', '\t\t\t\t\t\t24 text field Dates, Placeholder: Check-in – check-out', ...extra,
  '\t\t\t\t\t\t38 button Next', '\t40 toolbar', '\t\t52 button Description: New Tab, ID: NewTabButton'].join('\n');
// A date picker's day buttons carry plain numbers: { id: "18" } could then mean element 18 or the day labeled 18.
const withDay = form(['\t\t\t\t\t\t\t47 button 18']);

function relayFixture(t, text) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-id-shapes-'));
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    inputLease: new InputLease({ directory, holder: 'id-shapes' }) });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); removeTemp(directory); });
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  call(1, 'let app = await cua.getApp("Safari")');
  serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text }], _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.Safari' } } } } }) + '\n');
  let id = 1;
  return code => {
    call(++id, code);
    const forwarded = sent.find(m => m.id === id)?.params.arguments.code ?? '';
    const update = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(forwarded)?.[1] ?? '{}');
    // The relay sends one call at a time: answer this one before the next.
    serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text: GUARD_MARK + text + GUARD_END }] } }) + '\n');
    const result = (received.find(m => m.id === id)?.result?.content ?? []).map(item => item.text ?? '').join('\n');
    return { forwarded, update, result };
  };
}

test('FT1c: a numeric { id } that names no ID or label in the tree Claude saw is sent as that element number', t => {
  const act = relayFixture(t, form());
  // Only the first: after an action in the call, Claude's tree no longer settles what an { id } means (review F2).
  const { forwarded, update } = act('await app.setValue({ id: "18" }, "p01"); await app.setValue({ id: "20" }, "Mira"); await app.click({ id: "NewTabButton" });');
  assert.match(forwarded, /await app\.setValue\(18, "p01"\); await app\.setValue\(\{ id: "20" \}, "Mira"\); await app\.click\(\{ id: "NewTabButton" \}\);/);
  assert.doesNotMatch(forwarded, /setValue\(\{ id: "18" \}/);
  // The number then gets the ordinary checks: what Claude saw for it, and whether its line was unique.
  assert.deepEqual(update.literals, [18]);
  assert.deepEqual(update.seenLines, { 18: 'text field (settable) Reference code' });
});

test('FT1c: a numeric { id } with two readings, an unseen number or other keys is left for the guard', t => {
  const act = relayFixture(t, withDay);
  for (const code of ['await app.click({ id: "18" });', 'await app.click({ id: "99" });', 'await app.click({ id: "22", label: "Email" });']) {
    const { forwarded } = act(code);
    assert.ok(forwarded.includes(code), code);
  }
});

function guardFixture(current = form()) {
  const calls = [], output = [];
  const raw = { getAXState: async () => current };
  for (const name of ['click', 'setValue', 'pressKey', 'typeText']) raw[name] = async (...args) => { calls.push([name, ...args]); };
  const context = { app: raw, setTimeout, nodeRepl: { write: value => output.push(value) },
    cua: { getApp: async () => raw, listApps: async () => [] } };
  const run = code => runInNewContext(`(async () => { ${guardedCode(code, window, 'changed window', undefined, { focused: true })} })()`, context);
  return { run, calls, output };
}

test('FT1c: the guard never takes a numeric { id } for a label, and says how to name the element', async () => {
  const g = guardFixture(withDay);
  await assert.rejects(g.run('await app.click({ id: "18" });'), /no element with ID "18" in this window\.[^\n]*An element number goes bare: click\(18\)\./);
  assert.deepEqual(g.calls, []);
});

test('FT1c: setValue on a label-shaped { id } or { label } goes to the one settable element with that label', async () => {
  const g = guardFixture();
  await g.run('await app.setValue({ id: "Reference code" }, "p01"); await app.setValue({ label: "Full name" }, "Mira"); await app.setValue({ label: "Email" }, "m@x");');
  assert.deepEqual(g.calls.map(c => c.slice(0, 2)), [['setValue', 18], ['setValue', 20], ['setValue', 22]]);
});

test('FT1c: a label-shaped { id } that two elements carry stops for a click, and IDs still win', async () => {
  const g = guardFixture();
  await assert.rejects(g.run('await app.click({ id: "Reference code" });'), /2 elements with label "Reference code" in this window/);
  assert.deepEqual(g.calls, []);
  await g.run('await app.click({ id: "NewTabButton" }); await app.click({ id: "Next" });');
  assert.deepEqual(g.calls.map(c => c.slice(0, 2)), [['click', 52], ['click', 38]]);
  // Two settable fields with one label: no guess.
  const two = guardFixture(form(['\t\t\t\t\t\t30 text field (settable) Email']));
  await assert.rejects(two.run('await app.setValue({ label: "Email" }, "m@x");'), /3 elements with label "Email"/);
  assert.deepEqual(two.calls, []);
});

// Review F2: an earlier action in the call can open a window whose element has ID "18" (a date picker), so the tree
// Claude saw no longer settles what { id: "18" } means. A rewrite is reported with the element it went to.
test('FT1c review: no rewrite after an earlier action or in a loop, and every rewrite is named in the result', t => {
  const act = relayFixture(t, form());
  for (const code of ['await app.click(24); await app.click({ id: "18" });', 'await app.pressKey("Tab"); await app.setValue({ id: "18" }, "x");',
    'for (const n of [1, 2]) await app.click({ id: "18" });']) {
    const { forwarded } = act(code);
    assert.ok(forwarded.includes(code), code);
  }
  const { forwarded, result } = act('await app.setValue({ id: "18" }, "p01"); await app.click(38);');
  assert.match(forwarded, /await app\.setValue\(18, "p01"\); await app\.click\(38\);/);
  assert.match(result, /sleight: \{ id: "18" \} was sent as element 18, text field \(settable\) Reference code\./);
});

// Review F3: a leading zero would reach the engine as an octal literal (010 is 8 in sloppy mode).
test('FT1c review: a numeric { id } with leading zeros is sent in decimal, or left alone when a label matches either form', t => {
  const { forwarded } = relayFixture(t, form())('await app.setValue({ id: "018" }, "p01");');
  assert.match(forwarded, /await app\.setValue\(18, "p01"\);/);
  assert.doesNotMatch(forwarded, /setValue\(018/);
  const labeled = relayFixture(t, form(['\t\t\t\t\t\t\t47 button 18']))('await app.click({ id: "018" });');
  assert.ok(labeled.forwarded.includes('await app.click({ id: "018" });'));
});
