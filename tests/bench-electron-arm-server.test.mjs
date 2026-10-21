import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { forkWorker } from '../bench/electron-arm-server.mjs';

test('the arm worker gets the qualification flag without changing its parent environment', () => {
  const env = { PATH: '/fixture/bin' }, child = new EventEmitter();
  child.kill = () => {};
  let options;
  const worker = forkWorker({ env, forkProcess: (_file, _args, opts) => { options = opts; return child; } });
  assert.deepEqual(options.env, { PATH: '/fixture/bin', SLEIGHT_TURBO_UNQUALIFIED: '1' });
  assert.deepEqual(env, { PATH: '/fixture/bin' });
  worker.kill();
});
for (const loss of ['error', 'disconnect', 'send-error']) test(`the arm worker refuses a clean end after IPC ${loss}`, async () => {
  const child = new EventEmitter(); child.kill = () => {};
  child.send = (_message, callback) => { if (loss === 'send-error') queueMicrotask(() => callback(Error('closed IPC'))); };
  const worker = forkWorker({ forkProcess: () => child });
  const pending = worker.send('call');
  if (loss !== 'send-error') child.emit(loss, Error('closed IPC'));
  assert.equal((await pending).ok, false); assert.equal((await worker.send('end')).ok, false);
});
