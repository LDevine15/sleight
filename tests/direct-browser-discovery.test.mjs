import test from 'node:test';
import assert from 'node:assert/strict';
import { parseActivePort, validateEndpoint, discoverSelected, effectiveOrigin } from '../plugins/sleight/lib/direct-browser/discovery.mjs';

const selected = { application: '/fixture/Browser.app', root: '/fixture/root', pid: 42, start: 100 };
const processIdentity = { ...selected, alive: true };
const endpoint = 'ws://127.0.0.1:9222/devtools/browser/fixture-id';
const fixture = extra => ({ selected, processes: [processIdentity], canonicalRoot: selected.root,
  file: { path: '/fixture/root/DevToolsActivePort', canonicalPath: '/fixture/root/DevToolsActivePort',
    mtime: 101, text: '9222\n/devtools/browser/fixture-id\n' }, setting: true, supported: true,
  connection: { state: 'connected', endpoint, peer: processIdentity, redirected: false }, ...extra });

test('full integer and bounded browser suffix only', () => {
  assert.deepEqual(parseActivePort('65535\n/devtools/browser/a-b_9\n'), { port: 65535, path: '/devtools/browser/a-b_9' });
  for (const text of ['9222x\n/devtools/browser/x', '0\n/devtools/browser/x', '65536\n/devtools/browser/x',
    '+9222\n/devtools/browser/x', '9.2\n/devtools/browser/x', '9222\n', '9222\n/devtools/browser/',
    '9222\n/devtools/browser/x\nextra', '9222\n/devtools/browser/../x', '9222\n/devtools/browser/x?query',
    '9222\n/devtools/browser/x#hash', '9222\n//evil.test/x', `9222\n/devtools/browser/${'x'.repeat(257)}`])
    assert.throws(() => parseActivePort(text), /active port/);
});

test('endpoint cannot redirect, escape loopback or contain encoded path, credentials or suffix tricks', () => {
  assert.equal(validateEndpoint(endpoint), endpoint);
  assert.equal(validateEndpoint('ws://[::1]:9222/devtools/browser/x'), 'ws://[::1]:9222/devtools/browser/x');
  assert.equal(discoverSelected(fixture({ file: { ...fixture().file, text: '80\n/devtools/browser/fixture-id' },
    connection: { ...fixture().connection, endpoint: 'ws://127.0.0.1:80/devtools/browser/fixture-id' } })).state, 'connected');
  for (const url of ['ws://evil.test:9222/devtools/browser/x', 'ws://127.0.0.1.evil.test:9222/devtools/browser/x',
    'ws://user@127.0.0.1:9222/devtools/browser/x', 'http://127.0.0.1:9222/devtools/browser/x',
    'ws://127.1:9222/devtools/browser/x', 'ws://127.0.0.1:9222/devtools/browser/%78',
    `${endpoint}?x`, `${endpoint}#x`]) assert.throws(() => validateEndpoint(url), /endpoint/);
});

test('selected process, canonical root and accepted connection identify one incarnation', () => {
  const result = discoverSelected(fixture());
  assert.equal(result.state, 'connected');
  assert.equal(result.identity.root, selected.root);
  assert.equal(result.endpoint, endpoint);
  assert.equal(discoverSelected(fixture({ processes: [] })).state, 'stale-instance');
  assert.equal(discoverSelected(fixture({ processes: [processIdentity, { ...processIdentity, pid: 43 }] })).state, 'stale-instance');
  for (const key of ['application', 'root', 'pid', 'start']) {
    const f = fixture(); f.connection.peer = { ...processIdentity, [key]: 'changed' };
    assert.equal(discoverSelected(f).state, 'stale-instance');
  }
});

test('stale/partial file, symlink/root escape and uncertain identity refuse', () => {
  for (const extra of [{ file: null }, { canonicalRoot: '/other' },
    { file: { ...fixture().file, mtime: 99 } }, { file: { ...fixture().file, text: '9222' } },
    { file: { ...fixture().file, canonicalPath: '/other/DevToolsActivePort' } },
    { connection: { state: 'connected', endpoint, peer: null } },
    { connection: { ...fixture().connection, redirected: true } },
    { connection: { ...fixture().connection, endpoint: 'ws://127.0.0.1:9223/devtools/browser/fixture-id' } }])
    assert.equal(discoverSelected(fixture(extra)).state, 'stale-instance');
});

test('off, unsupported, approval-pending, declined and disconnected remain distinct', () => {
  assert.equal(discoverSelected(fixture({ supported: false })).state, 'unsupported');
  assert.equal(discoverSelected(fixture({ setting: false })).state, 'off');
  for (const state of ['approval-pending', 'declined', 'disconnected'])
    assert.equal(discoverSelected(fixture({ connection: { state } })).state, state);
  assert.equal(discoverSelected(fixture({ connection: null })).state, 'disconnected');
});

test('creator origin controls blank/blob/data, never a profile label', () => {
  for (const url of ['about:blank', 'blob:https://fixture.test/uuid', 'data:text/html,x']) {
    assert.equal(effectiveOrigin(url, 'https://fixture.test'), 'https://fixture.test');
    assert.throws(() => effectiveOrigin(url), /origin/);
  }
  assert.throws(() => effectiveOrigin('blob:https://other.test/uuid', 'https://fixture.test'), /origin/);
  assert.throws(() => effectiveOrigin('file:///fixture'), /origin/);
});
