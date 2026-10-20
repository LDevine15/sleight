import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connectAdmin } from '../plugins/sleight/lib/direct-browser/electron-admin.mjs';
import { connectWorker, makeHost, until } from './direct-browser-electron-host-fixture.mjs';

test('the harness confines the switch to its run and copies private diagnostics into receipts and summary', async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const before = process.env.SLEIGHT_ELECTRON_DIAG;
  const first = { method: 'DOM.describeNode', code: -32602, message: 'private raw cause', sessionKind: 'iframe', targetType: 'iframe', frameType: 'iframe' };
  let source;
  const value = await withQualificationDiagnostics(out, async path => {
    source = path;
    assert.ok(source.startsWith(out + '/'));
    assert.equal(statSync(source).mode & 0o777, 0o600);
    const { qualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-diagnostics.mjs');
    qualificationDiagnostic(source);
    appendFileSync(source, JSON.stringify(first) + '\n' + JSON.stringify({ ...first, method: 'Page.fail' }) + '\n');
    return { code: 1, summary: { kind: 'electron-live-run', phases: [] } };
  });
  assert.equal(process.env.SLEIGHT_ELECTRON_DIAG, before);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.firstCDPFailure, { method: first.method, code: first.code, message: first.message });
  assert.equal(dirname(summary.diagnostics), out);
  assert.equal(statSync(summary.diagnostics).mode & 0o777, 0o600);
  assert.equal(statSync(join(out, 'summary.json')).mode & 0o777, 0o600);
  const rows = readFileSync(summary.diagnostics, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].method, 'sink-open');
  assert.deepEqual(rows[1], first);
  assert.equal(existsSync(source), false);
  assert.equal(value.code, 1);
});

test('a harness exception preserves the diagnostic and restores the inherited switch', async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const before = process.env.SLEIGHT_ELECTRON_DIAG;
  await assert.rejects(withQualificationDiagnostics(out, async () => { throw Error('fixture failure'); }), /fixture failure/);
  assert.equal(process.env.SLEIGHT_ELECTRON_DIAG, before);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.firstCDPFailure, null);
  assert.ok(existsSync(summary.diagnostics));
});

test('a header alone is no failure and a host park becomes the first failure', async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const { qualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-diagnostics.mjs');
  for (const park of [false, true]) {
    const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    await withQualificationDiagnostics(out, async path => {
      const record = qualificationDiagnostic(path);
      if (park) record({ method: 'park', code: null, message: 'pipe queue full', sessionKind: 'host' });
      return 1;
    });
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.firstCDPFailure, park ? { method: 'park', code: null, message: 'pipe queue full' } : null);
  }
});

test('a passing run tags deliberate revokes and disconnects, while earlier unexpected revokes remain failures', async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const { qualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-diagnostics.mjs');
  for (const fault of [false, true]) {
    const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    await withQualificationDiagnostics(out, async path => {
      const secret = randomBytes(32), record = qualificationDiagnostic(path);
      const h = await makeHost({ hostOptions: { adminSecret: secret, brokerOptions: { diagnostic: record } } });
      t.after(() => { h.host._crashForTest(); h.state.remove(); });
      await h.host.start({ build: 'fake-build' });
      const admin = await connectAdmin({ stateDir: h.state.dir, secret });
      t.after(() => admin.close());
      if (fault) { h.host.broker.revoke('revoked'); await admin.resume(); }
      await connectWorker(h.host, 's');
      await admin.revoke({ session: 's', expected: true });
      // The consent store fires this same untagged revoke after the explicit disconnect.
      await admin.revoke({ session: 's' });
      await until(() => h.host.status().workers.length === 0);
      await admin.resume();
      await connectWorker(h.host, 's');
      await admin.revoke({ session: 's', expected: true });
      return fault ? 1 : 0;
    });
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.firstCDPFailure, fault ? { method: 'park', code: null, message: 'revoked' } : null);
    const parks = readFileSync(summary.diagnostics, 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.method === 'park');
    assert.equal(parks.length, fault ? 3 : 2);
    assert.deepEqual(parks.slice(fault ? 1 : 0).map(row => row.expected), [true, true]);
    if (fault) assert.equal(parks[0].expected, undefined);
  }
});

test('malformed rows anywhere in the diagnostic file are reported without hiding valid failures', async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const { qualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-diagnostics.mjs');
  const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await withQualificationDiagnostics(out, async path => {
    const record = qualificationDiagnostic(path);
    record({ method: 'queue', code: 'CDP_HOST_QUEUE_FULL', message: 'client queue full', sessionKind: 'host' });
    appendFileSync(path, 'null\n{}\n[]\nprivate malformed row\n');
    return 1;
  });
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.diagnosticsError, 'INVALID_DIAGNOSTIC_RECORD');
  assert.deepEqual(summary.firstCDPFailure, { method: 'queue', code: 'CDP_HOST_QUEUE_FULL', message: 'client queue full' });
});

test('an authorized Quit and collection are expected, while an unrelated pipe failure after revoke remains visible', async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const { qualificationDiagnostic } = await import('../plugins/sleight/lib/direct-browser/electron-diagnostics.mjs');
  for (const fault of [false, true]) {
    const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    await withQualificationDiagnostics(out, async path => {
      let h;
      h = await makeHost({ hostOptions: { brokerOptions: { diagnostic: qualificationDiagnostic(path) },
        requestQuit: async () => { h.world.alive = false; h.app.output.end(); } } });
      t.after(() => { h.host._crashForTest(); h.state.remove(); });
      await h.host.start({ build: 'fake-build' });
      h.host.revokeSession('s', 'revoked', { expected: true });
      if (fault) h.app.input.emit('error', Error('write EPIPE: private path'));
      else assert.equal((await h.host.quit(async () => true)).cleanup, 'removed');
      return fault ? 1 : 0;
    });
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    assert.deepEqual(summary.firstCDPFailure, fault ? { method: 'park', code: null, message: 'write EPIPE' } : null);
  }
});

for (const failure of ['mkdtemp', 'write']) test(`diagnostic ${failure} failure removes its summary and temporary directory so a retry can run`, async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const broken = failure === 'mkdtemp' ? { mkdtemp: () => { throw Error('setup failed'); } }
    : { write: path => { writeFileSync(path, '', { mode: 0o600 }); throw Error('setup failed'); } };
  await assert.rejects(withQualificationDiagnostics(out, () => assert.fail('setup failed'), broken), /setup failed/);
  assert.deepEqual(readdirSync(out), []);
  await withQualificationDiagnostics(out, () => 0);
  assert.equal(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).code, 0);
});

test('summary cleanup failure preserves the original diagnostic setup error', async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const original = Error('diagnostic setup failed');
  await assert.rejects(withQualificationDiagnostics(out, () => assert.fail('setup failed'), { write: () => {
    rmSync(join(out, 'summary.json'));
    mkdirSync(join(out, 'summary.json'));
    throw original;
  } }), error => error === original);
  assert.deepEqual(readdirSync(out), ['summary.json'], 'the temporary sink still gets cleaned up');
});

test('an existing summary is preserved and a malformed diagnostic never becomes exception text', async t => {
  const { withQualificationDiagnostics } = await import('../bench/electron-diagnostics.mjs');
  const out = realpathSync(mkdtempSync('/tmp/eqhd-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await withQualificationDiagnostics(out, async path => {
    appendFileSync(path, 'private malformed upstream text\n');
    return 1;
  });
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.diagnosticsError, 'INVALID_DIAGNOSTIC_RECORD');
  assert.equal(summary.firstCDPFailure, null);
  writeFileSync(join(out, 'summary.json'), 'existing receipt');
  const before = readdirSync(out).sort();
  await assert.rejects(withQualificationDiagnostics(out, async () => assert.fail('no run after output collision')), { code: 'EEXIST' });
  assert.equal(readFileSync(join(out, 'summary.json'), 'utf8'), 'existing receipt');
  assert.deepEqual(readdirSync(out).sort(), before, 'a refused run creates no temporary directory');
});
