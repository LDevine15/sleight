import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalLogging, runScript } from '../plugins/sleight/lib/launch.mjs';

const prefix = 'sleight-drag-phase ';
const phase = { phase: 'ax-move', edge: 'start', monoMs: 1234.5 };
function runner(stderr, stdout = '{"ok":true}', error = null, inspect = () => {}) {
  return (_command, args, _options, callback) => {
    inspect(JSON.parse(args.at(-1)));
    const child = Object.assign(new EventEmitter(), { pid: 12345 });
    queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); callback(error, stdout, stderr); });
    return child;
  };
}

test('drag phases reach the existing trace file without content or changes to the tool result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-drag-trace-'));
  const saved = process.env.SLEIGHT_TRACE;
  try {
    process.env.SLEIGHT_TRACE = dir;
    const { trace } = approvalLogging(new Map());
    let request;
    const result = await runScript('drag.js', { trace: false }, {
      trace, run: runner(prefix + JSON.stringify({ ...phase, document: 'PRIVATE TEXT' }), undefined, null, value => { request = value; }),
    });
    assert.equal(request.trace, true);
    assert.deepEqual(result, { ok: true });
    const records = readFileSync(join(dir, readdirSync(dir)[0]), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map(({ direction, msg }) => ({ direction, msg })), [
      { direction: 'drag-phase', msg: { ...phase, helperPid: 12345 } },
    ]);
    assert.equal(JSON.stringify(records).includes('PRIVATE TEXT'), false);
  } finally {
    if (saved === undefined) delete process.env.SLEIGHT_TRACE; else process.env.SLEIGHT_TRACE = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trace disabled overrides caller input and emits no drag records', async () => {
  const saved = process.env.SLEIGHT_TRACE;
  try {
    delete process.env.SLEIGHT_TRACE;
    const records = [];
    await runScript('drag.js', { trace: true }, { trace: (...args) => records.push(args),
      run: runner(prefix + JSON.stringify(phase), undefined, null, request => assert.equal(request.trace, false)) });
    assert.deepEqual(records, []);
  } finally { if (saved !== undefined) process.env.SLEIGHT_TRACE = saved; }
});

test('partial trace survives a timeout and never replaces the timeout diagnostic', async () => {
  const saved = process.env.SLEIGHT_TRACE;
  try {
    process.env.SLEIGHT_TRACE = '1';
    const records = [];
    const result = await runScript('drag.js', {}, { trace: (...args) => records.push(args),
      run: runner(prefix + JSON.stringify(phase) + '\n', '', { killed: true }) });
    assert.equal(result.timedOut, true);
    assert.match(result.error, /timed out after 30 s/);
    assert.deepEqual(records, [['drag-phase', { ...phase, helperPid: 12345 }]]);
  } finally { if (saved === undefined) delete process.env.SLEIGHT_TRACE; else process.env.SLEIGHT_TRACE = saved; }
});

test('invalid phase records and trace writer failures cannot affect drag results', async () => {
  const saved = process.env.SLEIGHT_TRACE;
  try {
    process.env.SLEIGHT_TRACE = '1';
    const records = [];
    const stderr = [prefix + '{', ...[
      { ...phase, phase: 'document text' }, { ...phase, edge: 'bad' }, { ...phase, monoMs: -1 },
      { ...phase, monoMs: '123' }, { ...phase, monoMs: null }, phase,
    ].map(e => prefix + JSON.stringify(e))].join('\n');
    assert.deepEqual(await runScript('drag.js', {}, { run: runner(stderr), trace: (...args) => records.push(args) }), { ok: true });
    assert.deepEqual(records, [['drag-phase', { ...phase, helperPid: 12345 }]]);
    assert.deepEqual(await runScript('drag.js', {}, { run: runner(prefix + JSON.stringify(phase)), trace: () => { throw new Error('disk full'); } }), { ok: true });
  } finally { if (saved === undefined) delete process.env.SLEIGHT_TRACE; else process.env.SLEIGHT_TRACE = saved; }
});
