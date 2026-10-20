import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { simulatorScreenshotNote } from '../plugins/sleight/lib/simulator-focus.mjs';
import { createRelay, imageSize, promptNotice, screenshotOf } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';

const png = (width, height) => {
  const bytes = Buffer.alloc(25);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') };
};
const target = { app: 'Device Hub', title: 'iPhone fixture' };

test('a large non-simulator window gets scale advice without app-specific input rules', () => {
  const note = simulatorScreenshotNote([png(1600, 2400)], { app: 'Preview', title: 'Fixture' }, imageSize);
  assert.match(note, /Fixture.*Preview.*1600 × 2400/);
  assert.match(note, /1333 × 2000.*multiply each x and y by 1\.2/);
  assert.doesNotMatch(note, /Safari|Capture Keyboard|tapping/);
});

test('a first headerless simulator screenshot gets its dimensions from the leased target', () => {
  const content = [png(2196, 1598)];
  assert.equal(screenshotOf(content), undefined, 'the old header-based association misses a standalone screenshot');
  const note = simulatorScreenshotNote(content, target, imageSize);
  assert.match(note, /2196 × 1598/);
  assert.match(note, /iPhone fixture/);
});

test('an oversized screenshot names the engine frame, the shown size and the exact factor', () => {
  const note = simulatorScreenshotNote([png(2200, 1600)], target, imageSize);
  assert.match(note, /engine screenshot 2200 × 1600 pixels/);
  assert.match(note, /2000 × 1455/);
  assert.match(note, /multiply each x and y by 1\.1/);
});

test('a screenshot no larger than Claude Code shows unresized gets no note', () => {
  assert.equal(simulatorScreenshotNote([png(1568, 1140)], target, imageSize), undefined);
  assert.equal(simulatorScreenshotNote([png(2000, 1200)], target, imageSize), undefined);
  assert.equal(simulatorScreenshotNote([png(1200, 2000)], target, imageSize), undefined);
});

test('unowned, contradictory and ambiguous screenshots get no simulator advice', () => {
  for (const [content, context] of [
    [[png(2196, 1598)], undefined],
    [[png(2196, 1598)], { app: 'Device Hub' }],
    [[png(2196, 1598), png(2196, 1598)], target],
    [[{ type: 'text', text: 'Window: "Other", App: Device Hub.' }, png(2196, 1598)], target],
    [[{ type: 'text', text: 'Window: "iPhone fixture", App: Safari.' }, png(2196, 1598)], target],
    [[{ type: 'text', text: 'Window: "bad\\q", App: Device Hub.' }, png(2196, 1598)], target],
    [[png(0, 1598)], target],
    [[{ type: 'image', data: 'invalid' }], target],
  ]) assert.equal(simulatorScreenshotNote(content, context, imageSize), undefined);
});

test('matching Simulator app identity permits advice without mutating pixels or targets', () => {
  const content = [{ type: 'text', text: 'Window: "iPhone fixture", App: Simulator.' }, png(2196, 1598)];
  const before = structuredClone(content);
  const context = { app: 'Simulator', title: 'iPhone fixture' };
  assert.match(simulatorScreenshotNote(content, context, imageSize), /2196 × 1598/);
  assert.deepEqual(content, before);
});

for (const enabled of [undefined, false, true]) test(`Simulator note is ${enabled === false ? 'absent' : 'present'} with simFocusNote=${enabled === undefined ? 'default' : enabled}`, async t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const bank = mkdtempSync(join(tmpdir(), 'sleight-simulator-note-'));
  const replies = [], forwarded = [];
  clientOut.on('data', data => data.toString().trim().split('\n').forEach(line => replies.push(JSON.parse(line))));
  serverIn.on('data', data => data.toString().trim().split('\n').forEach(line => forwarded.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, simFocusNote: enabled, inputLease: new InputLease({ directory: bank, holder: 'simulator note test' }) });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); removeTemp(bank); });
  const call = (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, content, appId) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content,
    ...(appId && { _meta: { 'codex/toolSurface': { app: { appId } } } }) } }) + '\n');
  call(1, 'var sim = await cua.getApp("com.apple.dt.Devices")');
  reply(1, [{ type: 'text', text: 'Window: "iPhone fixture", App: Device Hub.\n0 standard window iPhone fixture' }], 'com.apple.dt.Devices');
  call(2, 'var calc = await cua.getApp("com.apple.calculator")');
  reply(2, [{ type: 'text', text: 'Window: "Calculator", App: Calculator.\n0 standard window Calculator' }], 'com.apple.calculator');
  call(3, 'await sim.getScreenshot()');
  const picture = png(2196, 1598);
  reply(3, [picture]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.find(message => message.id === 3).result.content[0], picture);
  if (enabled === false) assert.deepEqual(replies.find(message => message.id === 3).result.content, [picture]);
  else assert.match(replies.find(message => message.id === 3).result.content.at(-1).text, /2196 × 1598.*1\.098/);
  call(4, 'await unknown.getScreenshot()'); reply(4, [picture]);
  call(5, 'await calc.getScreenshot()'); reply(5, [picture]);
  call(6, 'await sim.getScreenshot(); await calc.getScreenshot()'); reply(6, [picture]);
  await new Promise(resolve => setImmediate(resolve));
  for (const id of [4, 6]) assert.deepEqual(replies.find(message => message.id === id).result.content, [picture]);
  if (enabled === false) assert.deepEqual(replies.find(message => message.id === 5).result.content, [picture]);
  else assert.match(replies.find(message => message.id === 5).result.content.at(-1).text, /Calculator.*2196 × 1598/);
  // Notes are output only. The engine still receives its original coordinate expression.
  call(7, 'var sim = await cua.getApp("com.apple.dt.Devices")');
  reply(7, [{ type: 'text', text: 'Window: "iPhone fixture", App: Device Hub.\n0 standard window iPhone fixture' }], 'com.apple.dt.Devices');
  call(8, 'await sim.click([1254,282])');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(forwarded.find(message => message.id === 8).params.arguments.code, /await sim\.click\(\[1254,282\]\)/);
});

test('a batched screenshot names the frame once per window and size, and a reassigned handle gets none', async t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const bank = mkdtempSync(join(tmpdir(), 'sleight-frame-note-'));
  const replies = [];
  clientOut.on('data', data => data.toString().trim().split('\n').forEach(line => replies.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: new InputLease({ directory: bank, holder: 'frame note test' }) });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); removeTemp(bank); });
  const header = { type: 'text', text: 'Window: "Settings", App: Firefox.\n0 standard window Settings' };
  const exchange = async (id, code, content) => {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content, _meta: { 'codex/toolSurface': { app: { appId: 'org.mozilla.firefox' } } } } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    return replies.find(message => message.id === id).result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  };
  await exchange(1, 'var ff = await cua.getApp("org.mozilla.firefox")', [header]);
  // The first screenshot of both Firefox settings runs (2026-10-17) was a batch like this, with no note.
  const shown = await exchange(2, 'const shot = await ff.getScreenshot();\nawait nodeRepl.emitImage(shot);', [header, png(2560, 1708), png(2560, 1708)]);
  assert.match(shown, /engine screenshot 2560 × 1708 pixels\. The engine and the drag tool read coordinates in these screenshot pixels\./);
  assert.match(shown, /2000 × 1334, so multiply each x and y by 1\.28/);
  assert.equal(shown.match(/multiply each x and y/g).length, 1);
  assert.doesNotMatch(await exchange(3, 'await ff.getScreenshot()', [png(2560, 1708)]), /multiply each x and y/, 'stated once per window and size');
  assert.match(await exchange(4, 'const s2 = await ff.getScreenshot();\nnodeRepl.write("ok");', [header, png(2600, 1708)]), /2600 × 1708.*by 1\.3\b/);
  assert.doesNotMatch(await exchange(5, 'ff = await cua.getApp("org.mozilla.firefox"); await ff.getScreenshot()', [header, png(2700, 1708)]), /multiply each x and y/);
});

test('the lean note keeps the shown size and the factor', () => {
  const note = promptNotice(simulatorScreenshotNote([png(2560, 1708)], { app: 'Firefox', title: 'Settings' }, imageSize), 'lean');
  assert.match(note, /2560 × 1708 pixels\. Shown at 2000 × 1334, so multiply each x and y by 1\.28/);
  assert.doesNotMatch(note, /drag tool read/);
});
