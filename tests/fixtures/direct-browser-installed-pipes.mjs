import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createInstalledBridge } from '../../plugins/sleight/lib/direct-browser/installed-bridge.mjs';
import { serveInstalledWorker } from '../../plugins/sleight/lib/direct-browser/installed-worker.mjs';

export const installedHello = { version: 1, session: 'logical', nonce: 'a'.repeat(64) };

// Real parent and worker pipe protocols, with no native helper, CDP socket,
// browser, UI, model or app. The fake runtime holds its own exact result objects.
export async function installedPipeFixture(t, { closeReceipt = { revoked: true, cleanup: [] }, held = false } = {}) {
  const read = new PassThrough(), write = new PassThrough(), child = new EventEmitter();
  child.stdio = [null, null, null, read, write];
  const calls = [], frames = [], originals = new Set(); let delivery = false, current, release, alive = true, packageCurrent = true;
  read.on('data', chunk => frames.push(JSON.parse(chunk)));
  const controlRead = new PassThrough(); let message;
  controlRead.on('data', chunk => {
    message = JSON.parse(chunk); delivery = false;
    current = { browser: 'bfixture', ownership: { session: 'client', turn: message.turn, brokerEpoch: 1 },
      async call(input) {
        calls.push(input);
        if (held) await new Promise(resolve => { release = resolve; });
        const result = { route: 'direct', completed: 1, effect: 'verified', observation: { delivered: delivery, text: 'untrusted page' } };
        originals.add(result); return result;
      },
      delivered(result) { if (!originals.delete(result)) return false; delivery = true; return true; },
    };
  });
  const runtime = {
    ready: async () => current, current: () => current,
    endTurn() { current = undefined; return Promise.resolve(closeReceipt); },
    close() { current = undefined; return Promise.resolve(closeReceipt); },
  };
  const accepted = { inventory: { current: () => packageCurrent }, current: () => packageCurrent };
  let spawnVector;
  const bridge = await createInstalledBridge({}, {
    readConfig: () => ({ enabled: true, receipt: {} }), acceptPackage: () => accepted,
    spawnWorker(executable, args, options) {
      spawnVector = { executable, args, options };
      queueMicrotask(() => serveInstalledWorker({ read, write, runtime,
        control: { read: controlRead }, hello: installedHello, browser: 'bfixture',
        onClose() { alive = false; write.end(); read.end(); child.emit('close', 0); } }));
      return child;
    },
  });
  t.after(() => { read.destroy(); write.destroy(); controlRead.destroy(); release?.(); });
  const begin = (turn = 'turn') => bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn, text: 'Read this form.' });
  assert.equal(bridge.browser, 'bfixture');
  return { bridge, begin, calls, frames, spawnVector, read, write, runtime, alive: () => alive,
    release: () => release?.(), invalidate: () => { packageCurrent = false; }, originals };
}
