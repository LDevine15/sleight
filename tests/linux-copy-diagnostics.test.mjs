import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { runInNewContext } from 'node:vm';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { containerProgram, runContainerChecks } from '../scripts/linux-preflight.mjs';

const commit = 'a'.repeat(40), runId = 'sleight-linux-00000000-0000-0000-0000-000000000000';
const hash = path => createHash('sha256').update(path).digest('hex');
function fixture(t) {
  const bank = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-copy-diagnostic-'))));
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const source = join(bank, 'source'), root = join(bank, 'destination');
  mkdirSync(source); mkdirSync(root);
  return { bank, source, root };
}
const base = { platform: 'linux', commit, runId, execute() { assert.fail('Copy failure must not run a child'); } };
const failAt = path => () => { throw Object.assign(Error('private unrecognized message'), { code: 'ERR_FS_CP_EEXIST', path }); };

test('real no-overwrite copy collision reports pre-copy state and only a relative hash', async t => {
  const { bank, source, root } = fixture(t);
  writeFileSync(join(source, 'package.json'), 'source');
  writeFileSync(join(root, 'package.json'), 'existing');
  const receipt = await runContainerChecks({ ...base, source, root });
  assert.equal(receipt.failure.copy.nodeVersion, process.version);
  assert.deepEqual(receipt.failure.copy.destination, { state: 'nonempty', count: 1 });
  // Node 24.22 refuses the existing directory itself; older Node reaches the existing file.
  if (receipt.failure.copy.collision.location === 'destination-root') {
    assert.deepEqual(receipt.failure.copy.collision, { location: 'destination-root' });
  } else {
    assert.deepEqual(receipt.failure.copy.collision, { location: 'descendant', area: 'other', pathSha256: hash('package.json') });
  }
  assert.equal(receipt.failure.errorCode, 'ERR_FS_CP_EEXIST');
  assert.equal(receipt.executed, false);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), 'existing');
  assert.equal(JSON.stringify(receipt).includes(bank), false);
  assert.equal(JSON.stringify(receipt).includes('package.json'), false);
});

test('copy diagnostics reject unknown, outside and nonnormalized collision paths', async t => {
  const { bank, root } = fixture(t);
  for (const path of [join(bank, 'outside'), `${root}-sibling/file`, `${root}/../outside`, `${root}//file`, `${root}/./file`, `${root}/file\n`, 'relative', undefined]) {
    const receipt = await runContainerChecks({ ...base, root, prepare: failAt(path), nodeVersion: 'v24.19.0' });
    assert.deepEqual(receipt.failure.copy, { nodeVersion: 'v24.19.0', destination: { state: 'empty', count: 0 }, collision: { location: 'unavailable' } });
    assert.equal(JSON.stringify(receipt).includes(bank), false);
  }
});

test('Node version diagnostic rejects coercible values rather than storing them', async t => {
  const { root } = fixture(t);
  for (const nodeVersion of [['v24.19.0'], 'v24.19.0\n']) {
    const receipt = await runContainerChecks({ ...base, root, prepare: failAt(root), nodeVersion });
    assert.equal(receipt.failure.copy.nodeVersion, 'unavailable');
  }
});

test('copy diagnostics recognize root, info.path and the exact native template without exposing paths', async t => {
  const { root } = fixture(t);
  const cases = [
    [{ path: root }, { location: 'destination-root' }],
    [{ info: { path: `${root}/.git/index` } }, { location: 'descendant', area: '.git', pathSha256: hash('.git/index') }],
    [{ message: `[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${root}/README already exists)` },
      { location: 'descendant', area: 'other', pathSha256: hash('README') }],
    [{ message: `prefix [ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${root}/README already exists)` }, { location: 'unavailable' }],
  ];
  for (const [properties, collision] of cases) {
    const receipt = await runContainerChecks({ ...base, root, nodeVersion: 'v24.19.0',
      prepare() { throw Object.assign(Error('private message'), { code: 'ERR_FS_CP_EEXIST', ...properties }); } });
    assert.deepEqual(receipt.failure.copy.collision, collision);
    assert.equal(JSON.stringify(receipt).includes(root), false);
    assert.equal(JSON.stringify(receipt).includes('private message'), false);
  }
});

test('pre-copy destination state is bounded and refuses symlinks and files', async t => {
  const { bank, root } = fixture(t);
  for (let index = 0; index < 260; index++) writeFileSync(join(root, `file-${index}`), '');
  const cases = [[root, { state: 'nonempty', count: 256 }], [join(bank, 'missing'), { state: 'absent' }]];
  const file = join(bank, 'file'), link = join(bank, 'link');
  writeFileSync(file, ''); symlinkSync(root, link);
  cases.push([file, { state: 'unsafe' }], [link, { state: 'unsafe' }]);
  for (const [target, destination] of cases) {
    const receipt = await runContainerChecks({ ...base, root: target, prepare: failAt(target), nodeVersion: 'v24.19.0-private' });
    assert.deepEqual(receipt.failure.copy.destination, destination);
    assert.equal(receipt.failure.copy.nodeVersion, 'unavailable');
  }
});

test('serialized copy failure preserves the same closed diagnostic and runs no child', async t => {
  const { source, root } = fixture(t), output = [];
  const rewritten = containerProgram.replace(/^import .*;\n/gm, '').replace("source = '/source', root = '/w'", `source = ${JSON.stringify(source)}, root = ${JSON.stringify(root)}`);
  const process = { platform: 'linux', version: 'v24.19.0', env: {}, argv: ['node', commit, runId],
    stdout: { write: text => output.push(text) }, stderr: { write() { assert.fail('No raw copy error output'); } } };
  await runInNewContext(`(async () => {${rewritten}})()`, { process, createHash, posix, join, lstatSync, opendirSync,
    cpSync() { throw Object.assign(Error(`[ERR_FS_CP_EEXIST]: Target already exists: cp returned EEXIST (${root}/.git/index already exists)`), { code: 'ERR_FS_CP_EEXIST' }); },
    spawn() { assert.fail('No child before copy'); }, mkdtempSync, rmSync, tmpdir, setTimeout, clearTimeout });
  assert.equal(output.length, 1);
  assert.deepEqual(JSON.parse(output[0]).failure.copy, { nodeVersion: 'v24.19.0', destination: { state: 'empty', count: 0 },
    collision: { location: 'descendant', area: '.git', pathSha256: hash('.git/index') } });
  assert.equal(process.exitCode, 1);
});

test('snapshot denial remains unavailable without hiding the original copy failure', async t => {
  const { root } = fixture(t), output = [];
  const process = { platform: 'linux', version: 'v24.19.0', env: {}, argv: ['node', commit, runId],
    stdout: { write: text => output.push(text) }, stderr: { write() { assert.fail('No raw copy error output'); } } };
  await runInNewContext(`(async () => {${containerProgram.replace(/^import .*;\n/gm, '')}})()`, { process, createHash, posix, join,
    lstatSync() { throw Object.assign(Error('private denied path'), { code: 'EACCES' }); }, opendirSync,
    cpSync() { throw Object.assign(Error('private unknown template'), { code: 'ERR_FS_CP_EEXIST' }); },
    spawn() { assert.fail('No child before copy'); }, mkdtempSync, rmSync, tmpdir, setTimeout, clearTimeout });
  const receipt = JSON.parse(output[0]);
  assert.deepEqual(receipt.failure, { stage: 'prepare', code: 'exception', errorCode: 'ERR_FS_CP_EEXIST',
    copy: { nodeVersion: 'v24.19.0', destination: { state: 'unavailable' }, collision: { location: 'unavailable' } } });
  assert.equal(output.join('').includes(root), false);
  assert.equal(output.join('').includes('private'), false);
});
