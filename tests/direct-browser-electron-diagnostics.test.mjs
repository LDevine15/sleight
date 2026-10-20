import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureHost } from '../plugins/sleight/lib/direct-browser/electron-admin.mjs';
import { connectWorker, makeHost, pageSession } from './direct-browser-electron-host-fixture.mjs';

const temp = t => {
  const dir = realpathSync(mkdtempSync('/tmp/eqdiag-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('opening a safe qualification sink writes one header before any failure', async t => {
  const { qualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-diagnostics.mjs');
  const path = join(temp(t), 'sink');
  writeFileSync(path, '', { mode: 0o600 });
  const record = qualificationDiagnostic(path);
  assert.equal(typeof record, 'function');
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].method, 'sink-open');
  assert.equal(rows[0].hostPid, process.pid);
  assert.ok(Number.isSafeInteger(rows[0].at));
});

test('qualification diagnostics retain raw CDP failures only in the private file', async t => {
  const { qualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-diagnostics.mjs');
  const path = join(temp(t), 'cdp.jsonl');
  writeFileSync(path, '', { mode: 0o600 });
  const h = await makeHost({ hostOptions: { brokerOptions: { diagnostic: qualificationDiagnostic(path) } } });
  t.after(() => { h.host._crashForTest(); h.state.remove(); });
  await h.host.start({ build: 'fake-build' });
  const { connection } = await connectWorker(h.host);
  t.after(() => connection.disconnect());
  const page = await pageSession(connection);
  const raw = 'unrecognized upstream detail /Users/fixture/private ' + 'x'.repeat(400);
  h.app.hang.add('DOM.describeNode');
  h.app.input.on('data', bytes => {
    for (const line of bytes.toString().split('\0').filter(Boolean)) {
      const cmd = JSON.parse(line);
      if (cmd.method === 'DOM.describeNode') h.app.emit({ id: cmd.id, sessionId: cmd.sessionId, error: { code: -32602, message: raw } });
    }
  });
  for (const [route, type] of [[page, 'page'], ['iframe-session', 'iframe'], ['worker-session', 'worker'], ['webview-session', 'webview']]) {
    if (route !== page) h.app.emit({ method: 'Target.attachedToTarget', sessionId: page,
      params: { sessionId: route, targetInfo: { targetId: route + '-target', type } } });
    await assert.rejects(connection.session.send('DOM.describeNode', { objectId: 'private-object' }, route),
      error => error.message === 'CDP_COMMAND_FAILED' && !error.message.includes(raw));
  }
  const [header, ...rows] = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(header.method, 'sink-open');
  assert.equal(header.sessionKind, 'host');
  assert.deepEqual(rows.map(r => r.sessionKind), ['page', 'iframe', 'worker', 'webview']);
  assert.deepEqual(rows.map(r => r.targetType), ['page', 'iframe', 'worker', 'webview']);
  assert.equal(rows[1].frameType, 'iframe');
  for (const row of rows) {
    assert.equal(row.method, 'DOM.describeNode');
    assert.equal(row.code, -32602);
    assert.equal(row.message, raw.slice(0, 300));
    assert.deepEqual(Object.keys(row).sort(), ['at', 'code', 'frameType', 'hostPid', 'message', 'method', 'sessionKind', 'targetType']);
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(h.host.status()).includes('unrecognized upstream'));
  assert.ok(!JSON.stringify(h.host.broker.receipts).includes('unrecognized upstream'));
});

test('diagnostics are off by default and refuse unsafe or replaced sinks without leaking failures', async t => {
  const { qualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-diagnostics.mjs');
  const dir = temp(t), path = join(dir, 'sink'), link = join(dir, 'link');
  assert.equal(qualificationDiagnostic(), undefined);
  assert.equal(qualificationDiagnostic(path), undefined);
  assert.equal(existsSync(path), false, 'the product cannot create the sink');
  writeFileSync(path, '', { mode: 0o644 });
  assert.equal(qualificationDiagnostic(path), undefined);
  chmodSync(path, 0o600);
  symlinkSync(path, link);
  assert.equal(qualificationDiagnostic(link), undefined);
  assert.equal(qualificationDiagnostic(dir + '/../' + dir.split('/').at(-1) + '/sink'), undefined);
  const record = qualificationDiagnostic(path);
  const header = readFileSync(path, 'utf8');
  assert.equal(JSON.parse(header).method, 'sink-open');
  chmodSync(path, 0o644);
  assert.doesNotThrow(() => record({ method: 'Page.fail', code: -32000, message: 'private', sessionKind: 'page', targetType: 'page', frameType: 'top' }));
  assert.equal(readFileSync(path, 'utf8'), header);
});

test('environment alone cannot enable host diagnostics, even with the unqualified override', async t => {
  const dir = temp(t), sink = join(dir, 'private.jsonl');
  writeFileSync(sink, '', { mode: 0o600 });
  for (const enabled of [false, true]) {
    let inherited;
    await assert.rejects(ensureHost({ stateDir: join(dir, 's'), tempRoot: join(dir, 'profiles'), registryPath: join(dir, 'r.json'), build: 'fake-build',
      env: { MODEL_SELECTED_DIAG: sink, SLEIGHT_TURBO_UNQUALIFIED: '1', ...(enabled ? { SLEIGHT_ELECTRON_DIAG: sink } : {}) },
      spawn(_node, _args, options) { inherited = options.env; throw Error('SPAWN_CAPTURED'); } }), /SPAWN_CAPTURED/);
    assert.equal(inherited.SLEIGHT_ELECTRON_DIAG, undefined);
  }
});

test('an explicit sink needs the exact qualification override and travels on a startup descriptor', async t => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const dir = temp(t), sink = join(dir, 'private.jsonl');
  writeFileSync(sink, '', { mode: 0o600 });
  for (const flag of [undefined, '0', 'true', '1']) {
    let startup = '', inherited, argv;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdio = [null, child.stdout, null, new PassThrough(), new PassThrough()];
    child.stdio[4].on('data', bytes => { startup += bytes; });
    child.kill = () => {};
    await assert.rejects(ensureHost({ stateDir: join(dir, 's'), tempRoot: join(dir, 'profiles'), registryPath: join(dir, 'r.json'), build: 'fake-build',
      qualificationDiagnosticPath: sink, env: { SLEIGHT_TURBO_UNQUALIFIED: flag }, timeoutMs: 1,
      spawn(_node, args, options) { argv = args; inherited = options.env; return child; } }), /ELECTRON_HOST_START_FAILED/);
    assert.deepEqual(argv.slice(argv.indexOf('--startup-fd'), argv.indexOf('--startup-fd') + 2), ['--startup-fd', '4']);
    assert.deepEqual(JSON.parse(startup), flag === '1' ? { diagnostic: sink } : {});
    assert.equal(inherited.SLEIGHT_ELECTRON_DIAG, undefined);
    assert.equal(inherited.SLEIGHT_TURBO_UNQUALIFIED, flag === '1' ? '1' : undefined);
  }
});

test('the host reads a diagnostic only from its startup descriptor and requires qualification mode', async t => {
  const { readQualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-host-run.mjs');
  const path = join(temp(t), 'sink');
  writeFileSync(path, '', { mode: 0o600 });
  const before = process.env.SLEIGHT_ELECTRON_DIAG;
  process.env.SLEIGHT_ELECTRON_DIAG = path;
  t.after(() => { if (before === undefined) delete process.env.SLEIGHT_ELECTRON_DIAG; else process.env.SLEIGHT_ELECTRON_DIAG = before; });
  const calls = [];
  const deps = { fd: 4, stat: fd => { calls.push(['stat', fd]); return { isSocket: () => true }; }, close: fd => calls.push(['close', fd]) };
  let unnamedReads = 0;
  assert.equal(readQualificationDiagnostic({ unqualified: '1', read: () => { unnamedReads++; return '{}'; } }), undefined);
  assert.equal(unnamedReads, 0);
  for (const unqualified of ['0', 'true']) assert.equal(readQualificationDiagnostic({ ...deps, unqualified, read: () => JSON.stringify({ diagnostic: path }) }), undefined);
  calls.length = 0;
  const record = readQualificationDiagnostic({ ...deps, unqualified: '1', read: fd => { calls.push(['read', fd]); return JSON.stringify({ diagnostic: path }); } });
  assert.deepEqual(calls, [['stat', 4], ['read', 4], ['close', 4]]);
  record({ method: 'DOM.describeNode', message: 'raw private failure' });
  const rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].method, 'sink-open');
  assert.equal(rows[1].message, 'raw private failure');
});

test('a real startup pipe closes before any host child can inherit it', async () => {
  const module = new URL('../plugins/sleight/lib/direct-browser/electron-host-run.mjs', import.meta.url).href;
  const source = `
    import { fstatSync } from 'node:fs';
    import { readQualificationDiagnostic } from ${JSON.stringify(module)};
    readQualificationDiagnostic({ fd: 4, unqualified: '1' });
    try { fstatSync(4); process.exitCode = 1; }
    catch (error) { if (error.code !== 'EBADF') throw error; }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ignore', 'pipe'], timeout: 10000 });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdio[4].on('error', () => {});
  child.stdio[4].end('{}');
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  assert.equal(status, 0, stderr);
});

test('startup descriptor validation and parse failures always close it before returning', async () => {
  const { readQualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-host-run.mjs');
  for (const failure of ['stat', 'type', 'parse', 'read']) {
    const closed = [];
    let reads = 0;
    const diagnostic = readQualificationDiagnostic({ fd: 4, unqualified: '1',
      stat: () => { if (failure === 'stat') throw Error('EBADF'); return { isSocket: () => failure !== 'type', isFIFO: () => false, isFile: () => false }; },
      read: () => { reads++; if (failure === 'read') throw Error('read failed'); return '{'; },
      close: fd => closed.push(fd) });
    assert.equal(diagnostic, undefined);
    assert.equal(reads, ['stat', 'type'].includes(failure) ? 0 : 1);
    assert.deepEqual(closed, [4]);
  }
});
