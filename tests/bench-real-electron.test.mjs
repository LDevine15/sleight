import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { checkEditor, cleanupElectron, editorLaunchArgs, editorMains, makeEditorProfile, openElectron, parseProcesses, prepareEditor,
  profileProcesses, setupEditor } from '../bench/real-electron.mjs';
import { checkChat, cleanupChat, expectedChat, labelsChat, observationFromAX, prepareChat,
  promptChat, setupChat } from '../bench/real-chat.mjs';
import { getTasks } from '../bench/tasks.mjs';

function context(t) {
  const dir = mkdtempSync(join(tmpdir(), 'electron-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, nonce: 'abc123' };
}

test('running probe matches bundle IDs on the workspace list', async () => {
  const calls = [];
  const { appRunning } = await import('../bench/real-electron.mjs');
  await appRunning('com.apple.finder', {
    exec: async (file, args) => {
      calls.push([file, args.join(' ')]);
      return { stdout: '1\n' };
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /NSWorkspace\.sharedWorkspace\.runningApplications/);
  assert.match(calls[0][1], /const want = "com.apple.finder"/);
  assert.doesNotMatch(calls[0][1], /runningApplicationsWithBundleIdentifier/);
});

test('editor checker requires the replaced word on disk', t => {
  const ctx = context(t);
  prepareEditor(ctx);
  assert.equal(readFileSync(ctx.document, 'utf8'), 'alpha beta gamma\n');
  assert.notEqual(checkEditor(ctx), true);
  writeFileSync(ctx.document, 'alpha delta gamma\n');
  assert.equal(checkEditor(ctx), true);
  writeFileSync(ctx.document, 'alpha delta gamma extra\n');
  assert.notEqual(checkEditor(ctx), true);
  rmSync(ctx.document);
  assert.equal(checkEditor(ctx), 'edit document is missing');
});

const EDITOR_CASES = [
  ['Visual Studio Code', 'com.microsoft.VSCode', '/Applications/Visual Studio Code.app', 'Code'],
  ['Cursor', 'com.todesktop.230313mzl4w4u92', '/Applications/Cursor.app', 'Cursor'],
];
const START = Date.parse('2026-10-17T21:00:00Z');
const psLine = (pid, ms, args) => `${String(pid).padStart(6)} ${new Date(ms).toString().replace(/^(\w{3}) (\w{3}) 0?(\d+) (\d{4}) ([\d:]{8}).*$/, '$1 $2 $3 $5 $4')}     ${args}`;

// A fake Mac: the owner's own instance of the same app runs throughout, and the launch adds this run's main process and a helper.
function fakeEditorMac(t, [app, bundle, appPath, executable], { ownerRunning = true, helperLingers = false, exitConfirmed = true } = {}) {
  const ctx = context(t), calls = [], removed = [];
  const exe = `${appPath}/Contents/MacOS/${executable}`;
  const root = mkdtempSync(join(tmpdir(), 'ed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let clock = START, launched = false, quit = false;
  const owner = { pid: 500, startedAtMs: START - 3600000, args: `${exe} --some-owner-flag` };
  const options = {
    appPath, makeProfile: () => root, now: () => clock, pause: async ms => { clock += ms; },
    identity: async path => ({ path, bundle, executable: exe }),
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file === '/usr/bin/open') launched = true;
      return { stdout: '' };
    },
    list: async () => parseProcesses([
      ...(ownerRunning ? [psLine(owner.pid, owner.startedAtMs, owner.args)] : []),
      // An earlier run's leftover naming a different profile, and the helper of this run.
      psLine(400, START - 60000, `${exe} --user-data-dir=/tmp/other/profile`),
      ...(launched && !quit ? [psLine(900, START + 2000, `${exe} --user-data-dir=${root}/profile --extensions-dir=${root}/extensions --new-window ${ctx.document ?? ''}`)] : []),
      ...(launched && (!quit || helperLingers) ? [psLine(901, START + 2000, `${appPath}/Contents/Frameworks/${executable} Helper (Renderer).app/Contents/MacOS/x --user-data-dir=${root}/profile`)] : []),
    ].join('\n')),
    run: async (file, args) => {
      const request = JSON.parse(args.at(-1));
      calls.push(['helper', request.mode, request.pid, request.bundle]);
      if (request.mode === 'quit') quit = true;
      return { groupClean: true, exit: { code: 0 }, stdout: JSON.stringify({ stage: request.mode, reason: 'exited' }) + '\n' };
    },
    exited: async pid => { calls.push(['exited', pid]); return exitConfirmed; },
    remove: path => { removed.push(path); },
  };
  return { ctx, calls, removed, root, options, owner };
}

for (const editor of EDITOR_CASES) {
  const [app, bundle, appPath] = editor;
  test(`${app} launches its own instance with a temporary profile and quits only that pid`, async t => {
    for (const ownerRunning of [true, false]) {
      const mac = fakeEditorMac(t, editor, { ownerRunning });
      await setupEditor(mac.ctx, { app, bundle }, mac.options);
      const open = mac.calls.find(call => call[0] === '/usr/bin/open');
      assert.deepEqual(open.slice(1), editorLaunchArgs(appPath, mac.root, mac.ctx.document));
      assert.deepEqual(open.slice(1, 6), ['-n', '-g', '-a', appPath, '--args']);
      assert.ok(open.includes(`--user-data-dir=${mac.root}/profile`) && open.includes(`--extensions-dir=${mac.root}/extensions`));
      for (const flag of ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust']) assert.ok(open.includes(flag));
      assert.equal(open.at(-1), mac.ctx.document);
      assert.equal(mac.ctx.electronLease.pid, 900);
      assert.equal(mac.ctx.pendingAcquisitions.size, 0);
      assert.deepEqual(mac.calls.filter(call => call[0] === 'helper'), [['helper', 'ready', 900, bundle]]);
      await cleanupElectron(mac.ctx);
      assert.deepEqual(mac.calls.filter(call => call[0] === 'helper').at(-1), ['helper', 'quit', 900, bundle]);
      assert.deepEqual(mac.calls.filter(call => call[0] === 'exited'), [['exited', 900]]);
      assert.ok(!JSON.stringify(mac.calls).includes(String(mac.owner.pid)), 'the owner instance is never addressed');
      assert.ok(!JSON.stringify(mac.calls).includes('tell application'), 'no Apple event');
      assert.ok(!mac.calls.some(call => call[0] === '/usr/bin/osascript'));
      assert.deepEqual(mac.removed, [mac.root]);
      assert.equal(mac.ctx.fixtureDiagnostics[0].appQuit, true);
      assert.equal(mac.ctx.fixtureDiagnostics[0].profileRemoved, true);
    }
  });
}

test('editor quit keeps the profile while a process still names it or the kernel still runs the pid', async t => {
  const lingering = fakeEditorMac(t, EDITOR_CASES[0], { helperLingers: true });
  await setupEditor(lingering.ctx, { app: 'Visual Studio Code', bundle: 'com.microsoft.VSCode' }, lingering.options);
  await assert.rejects(cleanupElectron(lingering.ctx), /fixture processes remain \(901\); profile kept/);
  assert.deepEqual(lingering.removed, []);
  const running = fakeEditorMac(t, EDITOR_CASES[1], { exitConfirmed: false });
  await setupEditor(running.ctx, { app: 'Cursor', bundle: 'com.todesktop.230313mzl4w4u92' }, running.options);
  await assert.rejects(cleanupElectron(running.ctx), /exit disagreement after quit: pid 900/);
  assert.deepEqual(running.ctx.exitDisagreements, [{ app: 'Cursor', bundle: 'com.todesktop.230313mzl4w4u92', step: 'quit', pid: 900 }]);
  assert.deepEqual(running.removed, []);
});

test('editor setup refuses an unknown or mismatched app before any launch', async t => {
  const mac = fakeEditorMac(t, EDITOR_CASES[0]);
  await assert.rejects(setupEditor(mac.ctx, { app: 'Other', bundle: 'com.example.other' }, mac.options), e => e.noMutation === true);
  await assert.rejects(setupEditor(mac.ctx, { app: 'Visual Studio Code', bundle: 'com.microsoft.VSCode' },
    { ...mac.options, identity: async path => ({ path, bundle: 'com.example.other', executable: '/x' }) }), e => e.noMutation === true);
  assert.equal(mac.calls.length, 0);
  assert.equal(mac.ctx.windowLeases, undefined);
  assert.equal(mac.ctx.pendingAcquisitions.size, 0);
});

test('editor main process is the one naming this profile and started after launch', () => {
  const exe = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const processes = parseProcesses([
    psLine(1, START - 5000, `${exe} --user-data-dir=/r/profile`),
    psLine(2, START + 1000, `${exe} --user-data-dir=/r/profile2`),
    psLine(3, START + 1000, `${exe} --user-data-dir=/r/profile --new-window /r/a.txt`),
    psLine(4, START + 1000, `/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper --user-data-dir=/r/profile`),
    psLine(5, START + 1000, exe),
  ].join('\n'));
  assert.equal(processes.length, 5);
  assert.deepEqual(editorMains(processes, { executable: exe, profile: '/r/profile', launchedAtMs: START + 400 }).map(item => item.pid), [3]);
  assert.deepEqual(profileProcesses(processes, '/r').map(item => item.pid), [1, 2, 3, 4]);
});

test('editor profile is a short temporary folder with update and telemetry off', t => {
  const base = mkdtempSync(join(tmpdir(), 'b-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = makeEditorProfile({ base });
  const settings = JSON.parse(readFileSync(join(root, 'profile', 'User', 'settings.json'), 'utf8'));
  assert.equal(settings['update.mode'], 'none');
  assert.equal(settings['telemetry.telemetryLevel'], 'off');
  assert.equal(settings['security.workspace.trust.enabled'], false);
  const deep = join(base, 'x'.repeat(90));
  mkdirSync(deep);
  assert.throws(() => makeEditorProfile({ base: deep }), e => e.noMutation === true && /too long/.test(e.message));
  assert.deepEqual(readdirSync(deep), []);
});

function editorHelper() {
  const sandbox = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-electron.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}
function helperClock() {
  let now = 0;
  const events = [];
  return { events, clock: { now: () => now, wait: ms => { now += ms; }, emit: value => events.push(value) } };
}
const QUIT = { pid: 900, bundle: 'com.microsoft.VSCode', appPath: '/Applications/Visual Studio Code.app', waitMs: 1000 };

test('editor helper answers its own Don\'t Save sheet, forces only after the wait and refuses another identity', () => {
  const { quitElectron, waitReady } = editorHelper();
  const actions = [];
  let alive = true, sheetUp = true;
  const app = { pid: 900, bundle: QUIT.bundle, path: QUIT.appPath,
    terminate: () => { actions.push('terminate'); return true; }, forceTerminate: () => { actions.push('force'); alive = false; return true; } };
  const api = { running: () => alive ? app : null, dontSave: () => sheetUp ? ['button'] : [],
    press: button => { actions.push(['press', button]); sheetUp = false; } };
  let { clock, events } = helperClock();
  assert.equal(quitElectron(QUIT, { ...api, press: button => { api.press(button); alive = false; } }, clock).reason, 'exited');
  assert.deepEqual(actions, ['terminate', ['press', 'button']]);
  actions.length = 0; alive = true; sheetUp = false;
  ({ clock, events } = helperClock());
  assert.equal(quitElectron(QUIT, api, clock).reason, 'force-terminated');
  assert.deepEqual(actions, ['terminate', 'force']);
  assert.equal(events.at(-1).forced, true);
  actions.length = 0; alive = true;
  assert.throws(() => quitElectron(QUIT, { ...api, running: () => ({ ...app, path: '/Applications/Other.app' }) }, helperClock().clock), /identity changed/);
  assert.throws(() => quitElectron(QUIT, { ...api, running: () => ({ ...app, pid: 500 }) }, helperClock().clock), /identity changed/);
  assert.deepEqual(actions, []);
  assert.equal(quitElectron(QUIT, { ...api, running: () => null }, helperClock().clock).reason, 'already-exited');
  let windows = 0;
  ({ clock } = helperClock());
  assert.equal(waitReady(QUIT, { running: () => app, windowCount: () => windows++ }, clock).windows, 1);
  assert.throws(() => waitReady(QUIT, { running: () => app, windowCount: () => 0 }, helperClock().clock), /did not open/);
  assert.throws(() => waitReady(QUIT, { running: () => null, windowCount: () => 0 }, helperClock().clock), /exited before/);
});

test('editor tasks give every arm the same isolated fixture and a tool-neutral prompt', async t => {
  for (const id of ['vscode-edit', 'cursor-edit']) {
    const task = getTasks('real').find(item => item.id === id);
    assert.equal(task.fixtureLifecycle, true);
    assert.ok(task.allowedApps.includes(task.app) && task.allowedApps.includes(task.bundle));
    const ctx = context(t);
    task.prepare(ctx);
    const prompt = task.prompt(ctx);
    assert.ok(prompt.includes(`${task.app} window showing ${basename(ctx.document)}`) && prompt.includes(ctx.document));
    assert.doesNotMatch(prompt, /mcp__|computer use|open \//i);
  }
});

test('Firefox setup opens the fixture URL in the background and quits only if it launched Firefox', async () => {
  const calls = [];
  const ctx = { url: 'http://127.0.0.1:9/abc123/', windowLeases: [] };
  await openElectron(ctx, { app: 'Firefox', bundle: 'org.mozilla.firefox', target: ctx.url }, {
    running: async () => false,
    open: async (bundle, target) => calls.push(['open', bundle, target]),
    quit: async bundle => calls.push(['quit', bundle]),
  });
  assert.deepEqual(calls, [['open', 'org.mozilla.firefox', ctx.url]]);
  assert.equal(ctx.electronLease.launched, true);
  await cleanupElectron(ctx);
  assert.deepEqual(calls, [['open', 'org.mozilla.firefox', ctx.url], ['quit', 'org.mozilla.firefox']]);
});

test('Firefox already running is opened and not quit', async () => {
  const calls = [];
  const ctx = { url: 'http://127.0.0.1:9/abc123/', windowLeases: [] };
  await openElectron(ctx, { app: 'Firefox', bundle: 'org.mozilla.firefox', target: ctx.url }, {
    running: async () => true,
    open: async (bundle, target) => calls.push(['open', bundle, target]),
    quit: async () => calls.push('quit'),
  });
  await cleanupElectron(ctx);
  assert.deepEqual(calls, [['open', 'org.mozilla.firefox', ctx.url]]);
});

test('AX observation refuses an unstructured list of static text', () => {
  assert.equal(observationFromAX([
    { role: 'row', title: 'Invented channel', selected: true },
    { role: 'row', title: 'Other channel', selected: false },
    { role: 'static text', title: 'Invented Older' },
    { role: 'static text', title: 'Invented Author' },
    { role: 'text area', title: 'Message' },
  ]), null);
  assert.equal(observationFromAX([{ role: 'row', title: 'Invented channel', selected: true }]), null);
  assert.equal(observationFromAX(undefined), null);
});

async function acquiredChat(t, kind = 'slack', options = {}) {
  const ctx = context(t);
  const receipt = {
    running: true, launched: false, expected: 'Invented Author', target: 'Invented channel',
    terms: ['Invented channel', 'Invented Author'], prompt: 'Open the conversation named "Invented channel".',
    ...options.receipt,
  };
  await setupChat(ctx, kind, { adapter: async () => receipt });
  ctx.answer = JSON.stringify({ answer: 'Invented Author' });
  return ctx;
}

for (const kind of ['slack', 'discord', 'whatsapp']) {
  test(`${kind}-read accepts only the independently observed author`, async t => {
    const ctx = await acquiredChat(t, kind);
    assert.equal(checkChat(ctx), true);
    ctx.answer = JSON.stringify({ answer: 'Wrong invented author' });
    assert.equal(checkChat(ctx), 'CHAT_ANSWER_MISMATCH');
    ctx.answer = JSON.stringify({ answer: 'Invented Author', extra: true });
    assert.equal(checkChat(ctx), 'CHAT_ANSWER_INVALID');
    ctx.answer = 'Invented Author';
    assert.equal(checkChat(ctx), 'CHAT_ANSWER_INVALID');
  });
}

test('chat setup refuses an unowned launch receipt and keeps author strings off enumerable context', async t => {
  const ctx = context(t);
  await assert.rejects(setupChat(ctx, 'slack', { adapter: async () => ({
    running: true, launched: true, expected: 'Invented Author', target: 'Invented channel',
    terms: ['Invented channel'], prompt: 'Open it.',
  }) }), e => e.code === 'CHAT_WINDOW_OWNERSHIP_UNPROVED');
  const ready = await acquiredChat(t);
  const text = JSON.stringify({ ...ready, answer: undefined });
  for (const secret of ['Invented Author', 'Invented channel']) assert.equal(text.includes(secret), false);
  assert.equal(expectedChat(ready), 'Invented Author');
  assert.deepEqual(labelsChat(ready), ['Invented channel', 'Invented Author']);
  const prompt = promptChat(ready);
  assert.match(prompt, /Never send/);
  assert.match(prompt, /JSON.*one.*answer/s);
  assert.doesNotMatch(prompt, /mcp__|getApp/);
});

test('chat adapter requires the owner and refuses a missing independent AX baseline', async t => {
  await assert.rejects(setupChat(context(t), 'slack', { native: async () => assert.fail('owner gate must run first') }),
    e => e.code === 'CHAT_OWNER_PRESENT_UNPROVED' && e.noMutation === true);
  const unproved = { ...context(t), ownerPresent: true };
  await assert.rejects(setupChat(unproved, 'slack', { native: async (_ctx, _kind, operation) => operation === 'table' ?
    { processes: [{ pid: 42, launchedAt: 100 }], frontmost: null } : { nodes: [] } }), e => e.code === 'CHAT_CONVERSATION_UNPROVED');
});

test('chat dry preparation stores no author and Firefox web tasks keep independent page checks', async t => {
  const ctx = context(t);
  prepareChat(ctx);
  assert.equal(expectedChat(ctx), null);
  assert.throws(() => promptChat(ctx), e => e.code === 'CHAT_BASELINE_UNPROVED');
  await cleanupChat(ctx);
  const grid = getTasks('real').find(task => task.id === 'firefox-grid');
  const spa = getTasks('real').find(task => task.id === 'firefox-spa');
  const page = { nonce: 'abc123' };
  await grid.prepare(page);
  t.after(() => page.closeServer?.());
  assert.notEqual(grid.check(page), true);
  assert.equal(spa.app, 'Firefox');
  assert.match(grid.prompt(page), /Orchid/);
  assert.doesNotMatch(grid.prompt(page), /open_file|mcp__/);
});
