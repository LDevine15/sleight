import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import * as launch from '../plugins/sleight/lib/launch.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const app = 'Example Editor', appId = 'org.example.editor';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-open-fast-')), path = join(dir, 'note.txt');
  writeFileSync(path, 'hello'); utimesSync(path, 10, 10); t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { app, path };
}

test('fast open skips LaunchServices only for an exact existing document after validation', async t => {
  const args = fixture(t);
  for (const fast of [false, true]) for (const present of [false, true]) {
    const events = [], openedFiles = new Map([[JSON.stringify([appId, args.path]), Date.now()]]);
    const result = await launch.openDocument(args, { fast, openedFiles, resolve: async () => appId,
      hasDocument: async (id, path) => { events.push(['check', id, path]); return present; },
      exec: async () => events.push(['open']) });
    assert.equal(result.isError, undefined);
    assert.equal(result._meta['sleight/openedApp'], appId);
    assert.equal(events.some(e => e[0] === 'check'), fast);
    assert.equal(events.some(e => e[0] === 'open'), !(fast && present));
    if (fast) assert.deepEqual(events[0], ['check', appId, args.path]);
  }
});

test('failed document observation falls back to background open; blocked targets never get observed', async t => {
  const args = fixture(t), events = [];
  const options = { fast: true, resolve: async () => appId,
    hasDocument: async () => { events.push('check'); throw Error('AX unavailable'); }, exec: async () => events.push('open') };
  assert.equal((await launch.openDocument(args, options)).isError, undefined);
  assert.deepEqual(events, ['check', 'open']);
  events.length = 0;
  assert.equal((await launch.openDocument({ ...args, path: args.path + '.sh' }, options)).isError, true);
  assert.deepEqual(events, []);
});

function harness(t, options) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const received = [];
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, ...options });
  t.after(() => relay.close());
  return { received, relay, send: (name = 'open_file') => clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name,
    arguments: { app, path: '/tmp/note.txt' } } }) + '\n') };
}

test('fast open overlaps resolution with target lookup but defers its one approval until lookup succeeds', async t => {
  const target = deferred(), resolution = deferred(), approval = deferred(), events = [];
  const h = harness(t, { openFast: true, ask: async () => { events.push('approval'); return approval.promise; },
    inputLease: { acquire: () => { events.push('lease'); return 'lease'; }, renew: () => events.push('renew'), release() {}, close() {} },
    localTools: { tools: [{ name: 'open_file' }], target: () => { events.push('target'); return target.promise; },
      prepareOpen: (args, approve) => launch.prepareOpenFile(args, approve, { resolve: () => { events.push('resolve'); return resolution.promise; } }),
      call: async (_name, _args, approve, _run, _resolved, prepared) => {
        assert.equal(await approve(['open_file', app], 'Allow?'), true);
        assert.equal(await prepared.bundleId, appId);
        events.push('action'); return { content: [] };
      } } });
  h.send(); await tick();
  assert.deepEqual(new Set(events), new Set(['target', 'resolve']));
  approval.resolve('accept'); resolution.resolve(appId); await tick();
  assert.ok(!events.includes('action'));
  target.resolve({ appId, app, title: null, url: null }); await tick();
  assert.ok(events.indexOf('lease') < events.indexOf('action'));
  assert.ok(events.indexOf('renew') < events.indexOf('action'));
  assert.equal(events.filter(e => e === 'approval').length, 1);
});

test('fast open denial, failed target and Stop during preparation cannot open a file', async t => {
  for (const mode of ['denied', 'target-failed', 'stopped']) {
    const target = deferred(); let actions = 0, prompts = 0;
    const h = harness(t, { openFast: true, ask: async () => { prompts++; return mode === 'denied' ? 'decline' : 'accept'; },
      localTools: { tools: [{ name: 'open_file' }], target: () => target.promise,
        prepareOpen: (args, approve) => launch.prepareOpenFile(args, approve, { resolve: async () => appId }),
        call: async (_name, _args, approve) => { if (await approve(['open_file', app], 'Allow?')) actions++; return { content: [] }; } } });
    h.send(); await tick();
    if (mode === 'stopped') await h.relay.close();
    target.resolve(mode === 'target-failed' ? Promise.reject(Error('target changed')) : { appId, app });
    await tick(); assert.equal(actions, 0, mode);
    assert.equal(prompts, mode === 'denied' ? 1 : 0, mode + ' must not leave an approval or grant');
  }
});

test('local open reuses preparation, preserves its approval wording and refuses before observation on denial', async t => {
  const args = fixture(t);
  for (const allowed of [false, true]) {
    let resolutions = 0, prompts = 0, checks = 0, opens = 0;
    const prepared = launch.prepareOpenFile(args, async (parts, message) => {
      prompts++; assert.deepEqual(parts, ['open_file', app]);
      assert.equal(message, `Allow Claude to open files in ${app}? They open in the background.`);
      return allowed;
    }, { resolve: async () => { resolutions++; return appId; } });
    const result = await launch.callLocalTool('open_file', args, () => prepared.approval, undefined, undefined, {
      ...prepared, hasDocument: async () => { checks++; return true; }, exec: async () => { opens++; },
    });
    assert.equal(result.isError, allowed ? undefined : true);
    assert.equal(resolutions, 1); assert.equal(prompts, 1); assert.equal(checks, allowed ? 1 : 0); assert.equal(opens, allowed ? 1 : 0);
  }
});

test('Stop after native observation prevents background open and a false successful reuse', async t => {
  const args = fixture(t);
  for (const matches of [false, true]) {
    let stopped = false, opens = 0;
    await assert.rejects(launch.openDocument(args, { fast: true, resolve: async () => appId,
      current: () => { if (stopped) throw Error('stopped'); },
      hasDocument: async () => { stopped = true; return matches; }, exec: async () => { opens++; } }), /stopped/);
    assert.equal(opens, 0);
  }
});

test('flag-off and other local tools do not start speculative preparation', async t => {
  for (const [openFast, name] of [[false, 'open_file'], [true, 'drag']]) {
    const target = deferred(); let prepared = 0;
    const h = harness(t, { openFast, localTools: { tools: [{ name }], target: () => target.promise,
      prepareOpen: () => { prepared++; }, call: async () => ({ content: [] }) } });
    h.send(name); await tick(); assert.equal(prepared, 0);
    target.resolve({ appId, app }); await tick();
  }
});

test('fast open requires session freshness and rechecks file changes during observation', async t => {
  const args = fixture(t);
  for (const mode of ['unknown', 'fresh', 'newer', 'changed-during-probe']) {
    const openedFiles = new Map(), events = [];
    utimesSync(args.path, 10, 10);
    if (mode !== 'unknown') openedFiles.set(JSON.stringify([appId, args.path]), 20000);
    if (mode === 'newer') utimesSync(args.path, 30, 30);
    await launch.openDocument(args, { fast: true, openedFiles, resolve: async () => appId,
      hasDocument: async () => {
        if (mode === 'changed-during-probe') utimesSync(args.path, 30, 30);
        return true;
      }, exec: async () => events.push('open') });
    assert.deepEqual(events, mode === 'fresh' ? [] : ['open'], mode);
  }
});

test('successful background open establishes freshness for this session and app only', async t => {
  const args = fixture(t), openedFiles = new Map(), events = [];
  const options = { fast: true, openedFiles, resolve: async () => appId,
    hasDocument: async () => true, exec: async () => events.push('open') };
  await launch.openDocument(args, options);
  await launch.openDocument(args, options);
  assert.deepEqual(events, ['open']);
  await launch.openDocument(args, { ...options, resolve: async () => 'org.example.other' });
  assert.deepEqual(events, ['open', 'open']);
});

test('a hung document probe falls back at one second total and ignores its late match', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const args = fixture(t), probe = deferred(), events = [];
  const pending = launch.openDocument(args, { fast: true, resolve: async () => appId,
    openedFiles: new Map([[JSON.stringify([appId, args.path]), Date.now()]]),
    hasDocument: () => probe.promise, exec: async () => events.push('open') });
  await tick(); t.mock.timers.tick(999); await tick();
  assert.deepEqual(events, []);
  t.mock.timers.tick(1); await tick();
  assert.deepEqual(events, ['open']);
  assert.equal((await pending).isError, undefined);
  probe.resolve(true); await tick();
  assert.deepEqual(events, ['open']);
});

test('document probe child gets a one-second timeout instead of the generic helper deadline', async () => {
  let options;
  await launch.runScript('open-file-window.js', {}, { run: (_cmd, _args, opts, reply) => {
    options = opts; reply(null, '{"ok":true,"matches":false}', '');
  } });
  assert.equal(options.timeout, 1000);
});

function observe({ ids = [appId], documents = [], hidden = false, minimized = false, visible = true, visibilityError = false, axError = false } = {}) {
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const $ = key => key;
  Object.assign($, { NSWorkspace: { sharedWorkspace: { runningApplications: list(ids.map(bundleIdentifier => ({ bundleIdentifier, processIdentifier: 123 }))) } },
    NSURL: { fileURLWithPath: path => ({ absoluteString: new URL('file://' + path.replaceAll(' ', '%20')).href }) },
    AXUIElementCreateApplication: pid => ({ pid }), AXUIElementSetMessagingTimeout: () => 0,
    AXUIElementCopyAttributeValue: (element, key, out) => {
      if (axError) return -1;
      if (key === 'AXWindows') out[0] = list(documents.map(document => ({ document })));
      else if (key === 'AXHidden') out[0] = hidden;
      else if (key === 'AXMinimized') out[0] = minimized;
      else if (key === 'AXVisible') out[0] = visible;
      else out[0] = element.document;
      if (visibilityError && ['AXHidden', 'AXMinimized', 'AXVisible'].includes(key)) return -1;
      return 0;
    } });
  const source = readFileSync(new URL('../plugins/sleight/lib/open-file-window.js', import.meta.url), 'utf8');
  return JSON.parse(runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, Ref: () => [],
    ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value }, request: { appId, path: '/tmp/a b.txt' } }));
}

test('read-only window probe matches only the exact AXDocument URL in one matching process', () => {
  assert.equal(observe({ documents: ['file:///tmp/a%20b.txt'] }).matches, true);
  for (const options of [
    { documents: ['file:///tmp/a%20b.txt.bak'] }, { documents: ['/tmp/a b.txt'] },
    { documents: ['https://example.com/a%20b.txt'] }, { documents: [null] }, { documents: [] },
    { ids: [] }, { ids: [appId, appId], documents: ['file:///tmp/a%20b.txt'] },
    { ids: ['org.example.other'], documents: ['file:///tmp/a%20b.txt'] }, { axError: true },
  ]) assert.equal(observe(options).matches, false);
});

test('document probe cannot reuse hidden, minimized or unknown-visibility windows', () => {
  for (const state of [{ hidden: true }, { minimized: true }, { visible: false }, { visibilityError: true }]) {
    assert.equal(observe({ documents: ['file:///tmp/a%20b.txt'], ...state }).matches, false, JSON.stringify(state));
  }
});
