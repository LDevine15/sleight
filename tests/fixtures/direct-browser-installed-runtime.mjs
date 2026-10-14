import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../../scripts/temp-leftovers.mjs';
import { fixture } from './direct-browser-open.mjs';
import { createUiChannel } from '../../plugins/sleight/lib/direct-browser/host.mjs';
import { createPackageInventory } from '../../plugins/sleight/lib/direct-browser/session-host.mjs';
import { createInstalledRuntime } from '../../plugins/sleight/lib/direct-browser/startup.mjs';

export async function installedFixture(t, options = {}) {
  assert.equal(typeof createInstalledRuntime, 'function', 'fixed installed startup missing');
  const f = await fixture(t, { rawOnly: true }), input = new PassThrough(), output = new PassThrough(), frames = [];
  output.on('data', chunk => frames.push(JSON.parse(chunk)));
  const ui = createUiChannel({ read: input, write: output }); t.after(() => ui.close());
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-p4-package-')); trackTemp(root);
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(join(root, 'native'));
  const files = ['host.mjs', 'native/peer-host.c', 'native/consent-host.swift', 'playwright-files.json'].map(path => {
    const b = Buffer.from('offline ' + path); writeFileSync(join(root, path), b, { mode: 0o600 });
    return { path, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') };
  });
  const packageInventory = createPackageInventory({ root, receipt: { accepted: true, protocol: 1, node: process.version, helperMode: 'source', files } });
  const hostRead = new PassThrough(), hostWrite = new PassThrough(), hostFrames = [];
  hostWrite.on('data', chunk => hostFrames.push(JSON.parse(chunk)));
  const runtime = createInstalledRuntime({ packageInventory, ui, session: f.raw, selectedBrowser: 'bfixture',
    browserIncarnation: 'browser', logicalSession: 'client', control: { read: hostRead, write: hostWrite },
    connect: async () => f.raw, verifyConnection: () => true, disconnect: () => true, ...options.runtime });
  t.after(() => runtime.close());
  async function enable() {
    if (runtime.enabled()) return;
    while (!frames.length) await new Promise(r => setImmediate(r));
    const request = frames.at(-1); input.write(JSON.stringify({ id: request.id, nonce: request.nonce, choice: 'enable' }) + '\n');
  }
  const begin = async (turn = 'turn', text = 'Fill Name with Example, then submit.') => {
    const frame = hostFrames[0]; hostRead.write(JSON.stringify({ ...frame, event: 'begin', turn, text }) + '\n');
    const pending = runtime.ready(); await enable(); return pending;
  };
  return { ...f, runtime, begin, enable, hostRead, hostFrames, root, packageInventory, ui, input, frames };
}
