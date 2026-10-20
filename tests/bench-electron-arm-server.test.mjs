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
