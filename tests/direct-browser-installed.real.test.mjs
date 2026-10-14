import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createInstalledRuntime } from '../plugins/sleight/lib/direct-browser/startup.mjs';
import { createUiChannel } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { createPackageInventory } from '../plugins/sleight/lib/direct-browser/session-host.mjs';
import { prepareInstalledBrowser } from '../plugins/sleight/lib/launch.mjs';
import * as transport from './fixtures/direct-browser-root-cdp.mjs';

class SocketFixture extends EventTarget {
  readyState = 0; sent = []; closed = false;
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
  send(text) { this.sent.push(JSON.parse(text)); }
  reply(frame) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) })); }
  close() { this.closed = true; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

async function offline(t) {
  assert.equal(typeof transport.connectRootCdp, 'function', 'closed root CDP fixture missing');
  let socket;
  class Socket extends SocketFixture { constructor() { super(); socket = this; } }
  const raw = await transport.connectRootCdp('ws://127.0.0.1:9222/devtools/browser/owned', { WebSocketClass: Socket });
  t.after(() => raw.close());
  const roundtrip = async (method, params, route, result) => {
    const pending = raw.send(method, params, route);
    const frame = socket.sent.at(-1);
    socket.reply({ id: frame.id, ...(route ? { sessionId: route } : {}), result });
    return pending;
  };
  await roundtrip('Target.createTarget', { url: 'http://127.0.0.1:1234/settings', background: true }, undefined, { targetId: 'target' });
  await roundtrip('Target.attachToTarget', { targetId: 'target', flatten: true }, undefined, { sessionId: 'child' });
  return { raw, socket, roundtrip };
}

test('owned root CDP routes commands and events through the attached flattened session', async t => {
  const f = await offline(t), events = [];
  f.raw.on('event', event => events.push(event));
  const result = await f.roundtrip('Page.getFrameTree', {}, 'child', { frameTree: { frame: { id: 'frame' } } });
  assert.equal(f.socket.sent.at(-1).sessionId, 'child');
  assert.equal(result.frameTree.frame.id, 'frame');
  f.socket.reply({ sessionId: 'child', method: 'DOM.documentUpdated', params: {} });
  assert.equal(events[0].sessionId, 'child');
});

test('owned root CDP refuses unowned routes, arbitrary evaluation and foreground commands', async t => {
  const f = await offline(t), before = f.socket.sent.length;
  for (const [method, route] of [['Page.getFrameTree', 'foreign'], ['Runtime.evaluate', 'child'],
    ['Page.bringToFront', 'child'], ['Target.activateTarget', undefined]]) {
    await assert.rejects(f.raw.send(method, {}, route), /FIXTURE_COMMAND_DENIED/);
  }
  assert.equal(f.socket.sent.length, before);
});

test('owned root CDP close settles outstanding commands and closes its socket', async t => {
  const f = await offline(t), pending = f.raw.send('Page.getFrameTree', {}, 'child');
  const rejected = assert.rejects(pending, /FIXTURE_CDP_CLOSED/);
  await f.raw.close(); await rejected;
  assert.equal(f.socket.closed, true);
});

// Explicit synthetic installed-host inputs. They exercise the actual loader's
// private framing, inventory, opt-in and launcher binding without launching UI
// helpers or claiming that a native install/approval was qualified.
function privateInstalledFixture(raw) {
  const input = new PassThrough(), output = new PassThrough(), frames = [];
  output.on('data', chunk => frames.push(JSON.parse(chunk)));
  const ui = createUiChannel({ read: input, write: output });
  const root = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-p4-real-package-')));
  mkdirSync(join(root, 'native'));
  const files = ['host.mjs', 'native/peer-host.c', 'native/consent-host.swift', 'playwright-files.json'].map(path => {
    const bytes = Buffer.from('synthetic installed acceptance fixture: ' + path);
    writeFileSync(join(root, path), bytes, { mode: 0o600 });
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const packageInventory = createPackageInventory({ root, receipt: { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files } });
  const hostRead = new PassThrough(), hostWrite = new PassThrough(), hostFrames = [];
  hostWrite.on('data', chunk => hostFrames.push(JSON.parse(chunk)));
  const runtime = createInstalledRuntime({ packageInventory, ui, session: raw, selectedBrowser: 'bheadless',
    browserIncarnation: 'owned-headless', logicalSession: 'installed-fixture', control: { read: hostRead, write: hostWrite },
    connect: async () => raw, verifyConnection: session => session === raw, disconnect: () => true });
  return { runtime,
    async begin() {
      hostRead.write(JSON.stringify({ ...hostFrames[0], event: 'begin', turn: 'form-turn',
        text: 'Fill Reference code with P4-INSTALLED and Languages with Japanese and Korean, then Save and Save settings.' }) + '\n');
      const pending = runtime.ready(), deadline = Date.now() + 10000;
      while (!frames.length && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
      assert.equal(frames.length, 1, 'private synthetic opt-in request missing');
      const request = frames[0];
      input.write(JSON.stringify({ id: request.id, nonce: request.nonce, choice: 'enable' }) + '\n');
      return pending;
    },
    async close() {
      try { await runtime.close(); }
      finally { ui.close(); input.destroy(); output.destroy(); hostRead.destroy(); hostWrite.destroy(); rmSync(root, { recursive: true, force: true }); }
    },
  };
}

async function deliveredRows(direct, tab) {
  const rows = [], cursors = new Set(); let scope;
  for (let page = 0; page < 32; page++) {
    // The semantic reader caps each page itself; leave room for the frontend's
    // receipt/prefix envelope as well as the observation, and follow its cursor.
    const result = await direct.call({ name: 'browser_read', arguments: { tab, max_bytes: 64000, ...(scope ? { scope } : {}) } });
    assert.equal(result.effect, 'verified', JSON.stringify(result));
    assert.equal(direct.delivered(result), true, 'read observation must be delivered before refs or cursors are used');
    assert.ok(Array.isArray(result.observation.data), JSON.stringify(result));
    rows.push(...result.observation.data);
    scope = result.observation.cursor;
    if (!scope) return rows;
    assert.equal(cursors.has(scope), false, 'read cursor loop'); cursors.add(scope);
  }
  assert.fail('form exceeded bounded read pagination');
}
const observedRef = (rows, name, roles) => {
  const matches = rows.filter(row => row.name === name && roles.includes(row.role));
  assert.equal(matches.length, 1, 'expected one delivered form control: ' + name);
  assert.match(matches[0].ref, /^r[A-Za-z0-9_-]+$/); return matches[0].ref;
};

test('installed launcher opens the exact real settings page in background, fills delivered refs and submits',
  { skip: transport.realSkip, timeout: 90000 }, async t => {
    let browser, installed;
    t.after(async () => {
      try { await installed?.close(); }
      finally {
        const cleanup = await browser?.close();
        if (browser) assert.deepEqual(cleanup, { browserClosed: true, profileDeleted: true, socketsClosed: true });
        if (browser) assert.equal(existsSync(browser.profile), false, 'owned private profile must be removed after child closure');
      }
    });
    browser = await transport.realSettingsFixture();
    installed = privateInstalledFixture(browser.raw);
    const direct = await installed.begin(), prepared = await prepareInstalledBrowser(installed.runtime);
    assert.equal(prepared.directBrowser, direct);
    const opened = await direct.call({ name: 'browser_open', arguments: { browser: 'bheadless', url: browser.origin + '/settings' } });
    assert.equal(opened.effect, 'verified', JSON.stringify(opened));
    assert.equal(opened.observation.background, true);
    const tab = opened.tab; assert.match(tab, /^t[A-Za-z0-9_-]+$/);
    const rows = await deliveredRows(direct, tab);
    const filled = await direct.call({ name: 'browser_fill', arguments: { tab, fields: [
      { ref: observedRef(rows, 'Reference code', ['textbox']), value: 'P4-INSTALLED' },
      { ref: observedRef(rows, 'Languages', ['listbox', 'combobox']), value: ['Japanese', 'Korean'] },
    ] } });
    assert.equal(filled.effect, 'verified', JSON.stringify(filled)); assert.equal(filled.completed, 2);
    const save = await direct.call({ name: 'browser_act', arguments: { tab, op: 'click', ref: observedRef(rows, 'Save', ['button']) } });
    assert.equal(save.receipt.effect, 'unknown', JSON.stringify(save));
    assert.equal(browser.posts.length, 0, 'Save must only open the fixture confirmation');
    // Reconcile the unknown submit effect through an actually delivered read;
    // only the newly observed confirmation ref authorizes the next action.
    const confirmation = await deliveredRows(direct, tab);
    const submitted = await direct.call({ name: 'browser_act', arguments: { tab, op: 'click',
      ref: observedRef(confirmation, 'Save settings', ['button']) } });
    assert.equal(submitted.receipt.effect, 'unknown', JSON.stringify(submitted));
    assert.equal(submitted.error.effect, 'unknown', JSON.stringify(submitted));
    const deadline = Date.now() + 5000;
    while (!browser.posts.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(browser.posts.length, 1, 'external fixture server must observe exactly one POST');
    assert.equal(browser.posts[0].path, '/submit/settings');
    assert.equal(browser.posts[0].data.reference, 'P4-INSTALLED');
    assert.deepEqual(browser.posts[0].data.languages, ['ja', 'ko']);
    const calls = browser.raw.calls;
    assert.equal(calls.filter(call => call.method === 'Target.createTarget').length, 1);
    assert.equal(calls.find(call => call.method === 'Target.createTarget').params.background, true);
    assert.equal(calls.find(call => call.method === 'Target.attachToTarget').params.flatten, true);
    assert.ok(calls.some(call => call.method === 'Page.getFrameTree' && typeof call.route === 'string'));
    assert.equal(calls.some(call => ['Page.bringToFront', 'Target.activateTarget'].includes(call.method)), false);
    t.diagnostic('Submit source receipt: unknown. Independent local fixture proof: one settings POST with exact filled values. Native UI/package acceptance: synthetic private streams.');
  });
