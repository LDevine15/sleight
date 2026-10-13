import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSelection } from '../plugins/sleight/lib/browser-discovery.mjs';
import * as discovery from '../plugins/sleight/lib/browser-discovery.mjs';
import { createContext, runInContext } from 'node:vm';

const row = (id = 'chosen', profileName = 'Fixture profile') => ({ id: '1', type: 'extension',
  profileName, metadata: { extensionInstanceId: id } });
const engine = () => ({ command: 'fake-engine', args: [], env: { CUA_REPL_ENABLED_SURFACES: 'browser,computer' } });
function fixture(options = {}) {
  const sockets = new Map([['/tmp/codex-browser-use/fixture.sock', 1]]), calls = [];
  const selection = createBrowserSelection({ selection: { extensionInstanceId: 'chosen', profileName: 'Fixture profile' },
    candidates: () => [...sockets.keys()],
    stat: path => {
      if (!sockets.has(path)) throw Object.assign(Error('gone'), { code: 'ENOENT' });
      return { dev: 1, ino: sockets.get(path), uid: process.getuid?.() ?? 0, mode: 0o600, isSocket: () => true };
    }, discover: async server => { calls.push(server.env.BROWSER_USE_BACKEND_PATHS); return [row()]; },
    ...options });
  return { selection, sockets, calls };
}

test('explicit profile selection filters only after engine metadata matches', async () => {
  const h = fixture(), server = engine();
  const selected = await h.selection.prepare(server);
  assert.equal(selected.env.BROWSER_USE_BACKEND_PATHS, '/tmp/codex-browser-use/fixture.sock');
  assert.equal(selected.env.CUA_REPL_ENABLED_SURFACES, 'browser,computer');
  assert.equal(server.env.BROWSER_USE_BACKEND_PATHS, undefined);
  assert.deepEqual(h.calls, ['/tmp/codex-browser-use/fixture.sock']);
  assert.equal(h.selection.changed(), false);
});

for (const browsers of [[row('other')], [row('chosen', 'Other profile')], [row(), row()], []]) {
  test(`mismatched or ambiguous metadata keeps ordinary discovery: ${JSON.stringify(browsers)}`, async () => {
    const h = fixture({ discover: async () => browsers });
    const server = await h.selection.prepare(engine());
    assert.equal(server.env.BROWSER_USE_BACKEND_PATHS, undefined);
    assert.equal(h.selection.changed(), false);
  });
}

test('socket replacement and disappearance invalidate only that session', async () => {
  const one = fixture(), two = fixture();
  await one.selection.prepare(engine()); await two.selection.prepare(engine());
  one.sockets.set('/tmp/codex-browser-use/fixture.sock', 2);
  assert.equal(one.selection.changed(), true);
  assert.equal(two.selection.changed(), false);
  one.sockets.clear();
  assert.equal(one.selection.changed(), true);
  const fallback = await one.selection.prepare(engine());
  assert.equal(fallback.env.BROWSER_USE_BACKEND_PATHS, undefined);
  assert.equal(two.selection.changed(), false);
});

test('uncertain stat errors never authorize a restart', async () => {
  let denied = false;
  const h = fixture({ stat: () => {
    if (denied) throw Object.assign(Error('denied'), { code: 'EACCES' });
    return { dev: 1, ino: 1, uid: process.getuid?.() ?? 0, mode: 0o600, isSocket: () => true };
  } });
  await h.selection.prepare(engine()); denied = true;
  assert.equal(h.selection.changed(), false);
});

test('replacement during identity verification cannot publish a filtered socket', async () => {
  let h;
  h = fixture({ discover: async () => {
    h.sockets.set('/tmp/codex-browser-use/fixture.sock', 2); return [row()];
  } });
  assert.equal((await h.selection.prepare(engine())).env.BROWSER_USE_BACKEND_PATHS, undefined);
});

test('absence of an explicit choice and discovery failure preserve configured surfaces', async () => {
  const off = fixture({ selection: undefined, discover: () => assert.fail('unexpected discovery') });
  assert.deepEqual(await off.selection.prepare(engine()), engine());
  const failed = fixture({ discover: async () => { throw Error('disconnected'); } });
  assert.deepEqual(await failed.selection.prepare(engine()), engine());
});

test('verified browser objects are reused only within the same session and turn', async () => {
  let gets = 0, lists = 0;
  const browser = { browserId: '1', tabs: {} };
  const context = createContext({ cua: {
    listBrowsers: async options => { assert.equal(options.emit, false); lists++; return [row()]; },
    getBrowser: async selector => { assert.equal(selector.id, '1'); gets++; return browser; },
  } });
  const code = scope => discovery.selectedBrowserCode('return await cua.getBrowser({extensionInstanceId:"chosen"})',
    { extensionInstanceId: 'chosen', profileName: 'Fixture profile' }, scope);
  const run = scope => runInContext(`(async () => {${code(scope)}})()`, context);
  assert.equal(await run('session-one:turn-one'), browser);
  assert.equal(await run('session-one:turn-one'), browser);
  assert.equal(gets, 1); assert.equal(lists, 3);
  await run('session-one:turn-two'); assert.equal(gets, 2);
  await run('session-two:turn-one'); assert.equal(gets, 3);
});

test('a swapped browser id or profile cannot enter the retained handle cache', async () => {
  for (const rows of [[row('other')], [row('chosen', 'Other profile')]]) {
    let acquired = false;
    const context = createContext({ cua: {
      listBrowsers: async () => rows,
      getBrowser: async () => { acquired = true; return { browserId: '1' }; },
    } });
    const code = discovery.selectedBrowserCode('return await cua.getBrowser({extensionInstanceId:"chosen"})',
      { extensionInstanceId: 'chosen', profileName: 'Fixture profile' }, 'session:turn');
    await assert.rejects(runInContext(`(async () => {${code}})()`, context), /selected browser identity/);
    assert.equal(acquired, false);
  }
});

test('browser selection leaves strings, comments and unrelated selectors unchanged', async () => {
  const choice = { extensionInstanceId: 'chosen' };
  const source = '// cua.getBrowser({})\nnodeRepl.write("cua.getBrowser({})");';
  assert.equal(discovery.selectedBrowserCode(source, choice, 's:t'), source);
  let selected;
  const context = createContext({ cua: { getBrowser: async query => { selected = query.extensionInstanceId; return 'other'; } } });
  const code = discovery.selectedBrowserCode('return await cua.getBrowser({extensionInstanceId:"other"})', choice, 's:t');
  assert.equal(await runInContext(`(async () => {${code}})()`, context), 'other');
  assert.equal(selected, 'other');
});

test('explicit backend hints are reverified and never replace an operator filter', async () => {
  const h = fixture({ selection: { extensionInstanceId: 'chosen', backendPath: '/tmp/codex-browser-use/fixture.sock' },
    candidates: () => assert.fail('a verified hint does not need a scan') });
  await h.selection.prepare(engine()); await h.selection.prepare(engine());
  assert.equal(h.calls.length, 2);
  const server = { ...engine(), env: { BROWSER_USE_BACKEND_PATHS: '/operator/filter.sock' } };
  assert.equal(await h.selection.prepare(server), server);
  assert.equal(h.calls.length, 2);
});

test('duplicate identities in separate discovery batches keep the engine unfiltered', async () => {
  const paths = Array.from({ length: 5 }, (_, i) => `/tmp/codex-browser-use/socket-${i}.sock`);
  const h = fixture({ candidates: () => paths,
    stat: path => ({ dev: 1, ino: paths.indexOf(path), uid: process.getuid?.() ?? 0, isSocket: () => true }),
    discover: async server => [paths[0], paths[4]].includes(server.env.BROWSER_USE_BACKEND_PATHS) ? [row()] : [] });
  assert.equal((await h.selection.prepare(engine())).env.BROWSER_USE_BACKEND_PATHS, undefined);
  assert.equal(h.selection.changed(), false);
});

test('a returned browser with a swapped id is never cached', async () => {
  let gets = 0;
  const context = createContext({ cua: { listBrowsers: async () => [row()],
    getBrowser: async () => { gets++; return { browserId: 'swapped' }; } } });
  const code = discovery.selectedBrowserCode('return await cua.getBrowser({extensionInstanceId:"chosen"})',
    { extensionInstanceId: 'chosen' }, 's:t');
  for (let i = 0; i < 2; i++) await assert.rejects(runInContext(`(async () => {${code}})()`, context), /identity changed/);
  assert.equal(gets, 2);
});

test('identity replacement during getBrowser cannot publish a cached object', async () => {
  let acquired = false;
  const context = createContext({ cua: {
    listBrowsers: async () => [row(acquired ? 'replacement' : 'chosen')],
    getBrowser: async () => { acquired = true; return { browserId: '1' }; },
  } });
  const code = discovery.selectedBrowserCode('return await cua.getBrowser({extensionInstanceId:"chosen"})',
    { extensionInstanceId: 'chosen' }, 's:t');
  await assert.rejects(runInContext(`(async () => {${code}})()`, context), /identity changed/);
  assert.equal(context.__sleightSelectedBrowser, undefined);
});

for (const [name, changed] of [
  ['extension', [row('replacement')]],
  ['profile', [row('chosen', 'Replacement profile')]],
  ['browser id', [{ ...row(), id: '2' }]],
  ['missing browser', []],
  ['ambiguous browser', [row(), { ...row(), id: '2' }]],
  ['unavailable inventory', new Error('inventory unavailable')],
]) {
  test(`a warmed cache refuses a changed ${name} and drops its retained handle`, async () => {
    let rows = [row()], gets = 0;
    const browser = { browserId: '1' };
    const context = createContext({ cua: new Proxy({
      listBrowsers: async options => {
        assert.equal(options.emit, false);
        if (rows instanceof Error) throw rows;
        return rows;
      },
      getBrowser: async selector => { assert.equal(selector.id, '1'); gets++; return browser; },
    }, { get(target, name) {
      if (!(name in target)) throw Error('unsupported engine method: ' + String(name));
      return target[name];
    } }) });
    const code = discovery.selectedBrowserCode('return await cua.getBrowser({extensionInstanceId:"chosen"})',
      { extensionInstanceId: 'chosen', profileName: 'Fixture profile' }, 'session:turn');
    const acquire = () => runInContext(`(async () => {${code}})()`, context);
    assert.equal(await acquire(), browser);
    rows = changed;
    await assert.rejects(acquire(), /identity changed|inventory unavailable/);
    assert.equal(gets, 1, 'a stale cache never silently acquires a replacement');
    assert.equal(context.__sleightSelectedBrowser, undefined);
    rows = [row()];
    assert.equal(await acquire(), browser);
    assert.equal(gets, 2, 'a subsequent explicit acquisition can reverify the restored identity');
  });
}
