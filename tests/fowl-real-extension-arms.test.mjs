import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { realBrowserPlan, prepareRealProfile, profileSourceProblems, checkBrowserOwner, launchRealBrowser, browserVersion } from '../bench/fowl/real-browser.mjs';
import { taskSupport } from '../bench/fowl/support.mjs';
import { realGatePlan, runGateAgent, runRealGate } from '../bench/fowl/real-gate.mjs';
import { withClaudeManifest } from '../bench/fowl/real-gate-setup.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const task = { name: 'form-checkout', browser: 'helium', prompt: 'Fill the form in {browser}.', result: 'the submission id' };
const device = '83e6d921-8a11-4c87-a945-cbd5b5b883d6';

function chromeHome(t) {
  const home = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ext-arms-')));
  const chrome = join(home, 'Library/Application Support/Google/Chrome');
  const profile = join(chrome, 'Profile 7');
  for (const dir of ['Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn', 'Cache/Cache_Data', 'Sessions', 'Local Extension Settings/x']) mkdirSync(join(profile, dir), { recursive: true });
  mkdirSync(join(chrome, 'Default'), { recursive: true });
  writeFileSync(join(chrome, 'Default/Preferences'), '{"owner":true}');
  writeFileSync(join(profile, 'Preferences'), '{"extensions":{"ui":{"developer_mode":true}}}');
  writeFileSync(join(profile, 'Local Extension Settings/x/000003.log'), 'token');
  mkdirSync(join(profile, 'Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn'));
  writeFileSync(join(profile, 'Local Extension Settings/fcoeoabgfenejglbffodgkkbkcdhcgfn/000003.log'),
    Buffer.concat([Buffer.from('\x01\x00bridgeDeviceId\x2a"11111111-2222-4333-8444-555555555555"\x00'), Buffer.from('\x01\x0ebridgeDeviceId\x2a"44826f70-05b8-46d9-a64c-1bb491b78b9a"')]));
  writeFileSync(join(profile, 'Cache/Cache_Data/blob'), 'cache');
  writeFileSync(join(profile, 'Sessions/Session_1'), 'tabs');
  symlinkSync('/etc', join(profile, 'linked'));
  writeFileSync(join(chrome, 'Local State'), JSON.stringify({ browser: { last: 1 }, profile: { last_used: 'Default', last_active_profiles: ['Default', 'Profile 7'],
    info_cache: { Default: { name: 'owner', gaia_name: 'Owner Name' }, 'Profile 7': { name: 'sleight benchmark' } } } }));
  mkdirSync(join(chrome, 'NativeMessagingHosts'));
  writeFileSync(join(chrome, 'NativeMessagingHosts/com.fowl.browser.json'), JSON.stringify({ name: 'com.fowl.browser', path: '/fixture/fowlbrowser-host', type: 'stdio' }));
  return { home, chrome };
}

test('extension arms run where their extension does: FowlBrowser on Chrome or Helium, Claude in Chrome on Chrome', () => {
  for (const browser of ['chrome', 'helium']) assert.equal(taskSupport(task, 'fowlbrowser', { realBrowser: browser }), null);
  for (const browser of ['firefox', 'safari']) assert.match(taskSupport(task, 'fowlbrowser', { realBrowser: browser }), /Chrome or Helium/);
  assert.equal(taskSupport(task, 'claude-in-chrome', { realBrowser: 'chrome' }), null);
  for (const browser of ['helium', 'firefox', 'safari']) assert.match(taskSupport(task, 'claude-in-chrome', { realBrowser: browser }), /Chrome only/);
});

test('plans keep fresh rounds unchanged and refuse an extension arm that could not load its extension', () => {
  const plain = realBrowserPlan({ browser: 'chrome', round: 'fixture' });
  assert.equal(plain.profileMode, undefined);
  assert.deepEqual(realBrowserPlan({ browser: 'chrome', round: 'fixture', surface: 'codex' }), plain);
  assert.throws(() => realBrowserPlan({ browser: 'chrome', round: 'fixture', surface: 'fowlbrowser' }), /--real-profile benchmark/);
  assert.throws(() => realBrowserPlan({ browser: 'chrome', round: 'fixture', surface: 'claude-in-chrome' }), /--real-profile benchmark/);
  assert.throws(() => realBrowserPlan({ browser: 'helium', round: 'fixture', profile: 'benchmark' }), /Only Chrome/);
  assert.throws(() => realBrowserPlan({ browser: 'helium', round: 'fixture', surface: 'claude-in-chrome' }), /Chrome only/);
  assert.throws(() => realBrowserPlan({ browser: 'firefox', round: 'fixture', surface: 'fowlbrowser' }), /Chrome or Helium/);
  assert.throws(() => realBrowserPlan({ browser: 'chrome', round: 'fixture', profile: 'Default' }), /fresh or benchmark/);
  const helium = realBrowserPlan({ browser: 'helium', round: 'fixture', surface: 'fowlbrowser' });
  assert.equal(helium.profileMode, 'fresh');
  assert.deepEqual(helium.loadExtensions, [join(homedir(), 'Library/Application Support/FowlBrowser/extension')]);
  assert.deepEqual(helium.alsoQuit, ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
  const turbo = realBrowserPlan({ browser: 'chrome', round: 'fixture', profile: 'benchmark', surface: 'sleight-turbo' });
  assert.equal(turbo.profileMode, 'benchmark-copy');
  assert.equal(turbo.surface, undefined);
  assert.deepEqual(turbo.nativeHosts, []);
  assert.ok(turbo.args.includes('--remote-debugging-port=0'), 'the copy is a non-default folder, so remote debugging stays available');
});

test('the benchmark copy carries only that profile, without caches, the last session or links', t => {
  const { home, chrome } = chromeHome(t);
  const plan = realBrowserPlan({ browser: 'chrome', round: 'fixture', home, profile: 'benchmark', surface: 'fowlbrowser' });
  assert.deepEqual(profileSourceProblems(plan), []);
  mkdirSync(plan.profileRoot, { recursive: true, mode: 0o700 });
  const { spawnArgs, record } = prepareRealProfile(plan);
  const copy = join(plan.profileRoot, 'Profile 7');
  assert.equal(readFileSync(join(copy, 'Preferences'), 'utf8'), readFileSync(join(chrome, 'Profile 7/Preferences'), 'utf8'));
  assert.equal(readFileSync(join(copy, 'Local Extension Settings/x/000003.log'), 'utf8'), 'token');
  assert.ok(existsSync(join(copy, 'Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn')));
  for (const left of ['Cache', 'Sessions', 'linked']) assert.equal(existsSync(join(copy, left)), false, left);
  assert.equal(existsSync(join(plan.profileRoot, 'Default')), false);
  const state = JSON.parse(readFileSync(join(plan.profileRoot, 'Local State'), 'utf8'));
  assert.deepEqual(Object.keys(state.profile.info_cache), ['Profile 7']);
  assert.equal(state.profile.last_used, 'Profile 7');
  assert.deepEqual(state.profile.last_active_profiles, ['Profile 7']);
  assert.ok(!JSON.stringify(state).includes('Owner Name'));
  assert.equal(state.browser.last, 1);
  assert.equal(spawnArgs.at(-1), plan.args.at(-1), 'the marker page stays last for resets');
  assert.equal(spawnArgs.at(-2), '--profile-directory=Profile 7');
  assert.deepEqual(record, { profileFolder: 'Profile 7', nativeHosts: ['com.fowl.browser'] });
  assert.deepEqual(JSON.parse(readFileSync(join(plan.profileRoot, 'NativeMessagingHosts/com.fowl.browser.json'), 'utf8')).path, '/fixture/fowlbrowser-host');
  assert.equal(statSync(join(plan.profileRoot, 'Local State')).mode & 0o777, 0o600);
});

test('Claude in Chrome gets the pinned arm\'s native host and its own device pin in the round folder', async t => {
  const { home } = chromeHome(t);
  const plan = realBrowserPlan({ browser: 'chrome', round: 'fixture', home, profile: 'benchmark', surface: 'claude-in-chrome' });
  assert.match(profileSourceProblems(plan).join(' '), /Claude in Chrome arm is not installed/);
  mkdirSync(plan.profileRoot, { recursive: true, mode: 0o700 });
  const { record } = prepareRealProfile(plan);
  assert.deepEqual(record.nativeHosts, ['com.anthropic.claude_code_browser_extension']);
  assert.equal(record.claudeDeviceId, '44826f70-05b8-46d9-a64c-1bb491b78b9a', 'the newest record in the copy wins');
  assert.equal(readFileSync(record.claudeDeviceFile, 'utf8'), '44826f70-05b8-46d9-a64c-1bb491b78b9a\n');
  assert.equal(statSync(record.claudeDeviceFile).mode & 0o777, 0o600);
  const { realGatePlan: replan } = await import('../bench/fowl/real-gate.mjs');
  const deviceArms = replan({ args: { 'real-browser': 'chrome', surface: 'claude-in-chrome', 'chrome-local-state': join(home, 'Library/Application Support/Google/Chrome/Local State') },
    tasks: [task], realBrowser: { ...plan, ...record, pid: 1 } });
  assert.ok(deviceArms.arms[0].prompt.includes('44826f70-05b8-46d9-a64c-1bb491b78b9a'));
  const manifest = JSON.parse(readFileSync(join(plan.profileRoot, 'NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json'), 'utf8'));
  assert.equal(manifest.path, join(plan.profileRoot, '../claude-native-host'));
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/']);
  const wrapper = readFileSync(manifest.path, 'utf8');
  assert.match(wrapper, /CLAUDE_CONFIG_DIR='.*\/arms\/claude-in-chrome\/claude-config'\nexport CLAUDE_CONFIG_DIR\nexec '.*\/arms\/claude-in-chrome\/node_modules\/\.bin\/claude' --chrome-native-host\n$/);
  assert.equal(lstatSync(manifest.path).mode & 0o777, 0o700);
});

test('a missing benchmark profile, FowlBrowser host or extension shows up before launch', t => {
  const home = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ext-missing-')));
  mkdirSync(join(home, 'Library/Application Support/Google/Chrome'), { recursive: true });
  writeFileSync(join(home, 'Library/Application Support/Google/Chrome/Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'owner' } } } }));
  const chrome = realBrowserPlan({ browser: 'chrome', round: 'fixture', home, profile: 'benchmark', surface: 'fowlbrowser' });
  const problems = profileSourceProblems(chrome).join('; ');
  assert.match(problems, /missing.*name it "sleight benchmark"/);
  assert.match(problems, /native host is not registered for chrome/);
  const helium = realBrowserPlan({ browser: 'helium', round: 'fixture', home, surface: 'fowlbrowser' });
  assert.match(profileSourceProblems(helium).join('; '), /No unpacked extension/);
});

test('FowlBrowser rounds also need the other FowlBrowser browser closed', async () => {
  const plan = realBrowserPlan({ browser: 'helium', round: 'fixture', surface: 'fowlbrowser' });
  const rows = [{ pid: 40, ppid: 1, pgid: 40, executable: '/Applications/Helium.app/Contents/MacOS/Helium' }];
  assert.equal((await checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => rows })).ok, true);
  await assert.rejects(checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => [...rows,
    { pid: 50, ppid: 1, pgid: 50, executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }] }), /Quit helium and Google Chrome.*PID 50/);
  const turbo = realBrowserPlan({ browser: 'helium', round: 'fixture' });
  assert.equal((await checkBrowserOwner(turbo, { ownedPid: 40, listProcesses: async () => [...rows,
    { pid: 50, ppid: 1, pgid: 50, executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }] })).ok, true);
});

test('launch records the browser version from the app bundle and keeps the plan identity check', async t => {
  assert.equal(browserVersion('/Applications/X.app/Contents/MacOS/X', { read: () => '155.0.8059.80\n' }), '155.0.8059.80');
  assert.equal(browserVersion('/Applications/X.app/Contents/MacOS/X', { read: () => { throw Error('no plist'); } }), null);
  const plan = realBrowserPlan({ browser: 'chrome', round: 'test-' + randomUUID() });
  t.after(() => rmSync(join(plan.profileRoot, '..'), { recursive: true, force: true }));
  const child = new EventEmitter(); child.pid = 1234; child.kill = () => setImmediate(() => child.emit('close', 0));
  const browser = await launchRealBrowser(plan, { listProcesses: async () => [], readVersion: () => '155.0.8059.80', spawnBrowser: () => {
    writeFileSync(join(plan.profileRoot, 'DevToolsActivePort'), '12345\n/devtools/browser/fixture\n'); return child;
  } });
  assert.equal(browser.version, '155.0.8059.80');
  assert.equal(browser.versionVerified, true);
  await browser.stop();
  await assert.rejects(launchRealBrowser({ ...plan, profileMode: 'benchmark-copy' }, { listProcesses: async () => [] }), /PROFILE_UNSAFE/);
});

test('dry plans for both extension arms show their browser setup without launching', async t => {
  if (!existsSync(join(cache, 'tools/agents/codex-h2h.json'))) return t.skip('pinned FowlBrowser cache is absent');
  const tasks = JSON.parse(readFileSync(join(cache, 'tools/agents/codex-h2h.json'), 'utf8'));
  const { chrome } = chromeHome(t);
  const deviceFile = join(chrome, 'device'); writeFileSync(deviceFile, device, { mode: 0o600 });
  const out = join(chrome, 'never');
  const fowl = realGatePlan({ args: { 'real-browser': 'helium', surface: 'fowlbrowser', out }, tasks, repo: root, mcpRoot: cache, round: 'fixture' });
  assert.equal(fowl.arms.length, 13);
  for (const arm of fowl.arms) {
    assert.deepEqual(Object.keys(arm.mcpConfig.mcpServers), ['fowlbrowser']);
    assert.equal(arm.mcpConfig.mcpServers.fowlbrowser.command, join(cache, 'mcp/bin/fowlbrowser-mcp'));
    assert.equal(arm.mcpConfig.mcpServers.fowlbrowser.env.FOWLBROWSER_LABEL, `🧪 ${arm.task.name}`);
    assert.match(arm.settingsOverrides.hooks.Stop[0].hooks[0].command, /turn-ended\.mjs/);
    assert.equal(arm.args[arm.args.indexOf('--allowedTools') + 1], 'mcp__fowlbrowser');
    assert.ok(arm.args.includes('--no-chrome'));
    assert.ok(arm.prompt.includes('Helium'));
    assert.equal(arm.metadata.profileMode, 'fresh');
  }
  const args = { 'real-browser': 'chrome', surface: 'claude-in-chrome', out, 'chrome-local-state': join(chrome, 'Local State'), 'chrome-device-file': deviceFile };
  const cic = realGatePlan({ args, tasks, repo: root, mcpRoot: cache, round: 'fixture' });
  assert.equal(cic.browser.profileMode, 'benchmark-copy');
  assert.equal(cic.arms.length, 13);
  for (const arm of cic.arms) {
    assert.ok(arm.args.includes('--chrome'));
    assert.equal(arm.args[arm.args.indexOf('--permission-mode') + 1], 'default', 'auto mode sent page actions to an unanswered prompt in Chrome');
    assert.equal(arm.metadata.permissionMode, 'default');
    assert.ok(!arm.args.includes('--no-chrome'));
    assert.equal(arm.args.filter(arg => arg === '--tools').length, 1);
    assert.equal(arm.args[arm.args.indexOf('--tools') + 1], '');
    assert.equal(arm.args[arm.args.indexOf('--allowedTools') + 1], 'mcp__claude-in-chrome');
    assert.ok(arm.prompt.includes(device));
    assert.ok(arm.settingsOverrides.hooks.PreToolUse.length);
    assert.equal(arm.chrome.launch, undefined, 'the gate never opens the default Chrome folder');
    assert.equal(arm.metadata.chrome.profileFolder, 'Profile 7');
  }
  assert.throws(() => realGatePlan({ args: { ...args, 'real-profile': 'fresh' }, tasks, repo: root, mcpRoot: cache }), /--real-profile benchmark/);
  const turbo = realGatePlan({ args: { 'real-browser': 'chrome', surface: 'sleight-turbo', 'real-profile': 'benchmark', out }, tasks, repo: root, mcpRoot: cache, round: 'fixture' });
  assert.equal(turbo.browser.profileMode, 'benchmark-copy');
  assert.ok(turbo.arms.every(arm => arm.metadata.profileMode === 'benchmark-copy'));
  let printed;
  await runRealGate({ args: { 'real-browser': 'helium', surface: 'fowlbrowser', 'dry-run': true, out }, tasks, mcpRoot: cache,
    runtime: { print: text => { printed = JSON.parse(text); }, readVersion: () => '0.19.2.1' } });
  assert.equal(printed.browser.version, '0.19.2.1');
  assert.ok(Array.isArray(printed.browser.preflight));
  assert.equal(existsSync(out), false);
  await assert.rejects(runRealGate({ args: { ...args }, tasks, mcpRoot: cache, runtime: { admit: () => assert.fail('admitted') } }), /dry runs only/);
});

test('Claude in Chrome runs inside the manifest backup with a manifest already present', async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ext-manifest-')));
  const plan = { surface: 'claude-in-chrome', env: { CLAUDE_CONFIG_DIR: '/fixture/arm/claude-config' },
    chrome: { manifest: join(dir, 'hosts/com.anthropic.claude_code_browser_extension.json'), backupDir: join(dir, 'backups') } };
  const result = await withClaudeManifest(plan, async () => {
    assert.equal(JSON.parse(readFileSync(plan.chrome.manifest, 'utf8')).path, '/fixture/arm/claude-config/chrome/chrome-native-host');
    return 7;
  });
  assert.equal(result, 7);
  assert.equal(existsSync(plan.chrome.manifest), false, 'an absent manifest is absent again afterwards');
  writeFileSync(plan.chrome.manifest, 'owner manifest\n');
  await withClaudeManifest(plan, async () => { writeFileSync(plan.chrome.manifest, 'arm manifest'); });
  assert.equal(readFileSync(plan.chrome.manifest, 'utf8'), 'owner manifest\n');
  let guarded = 0;
  const arm = { surface: 'claude-in-chrome', dir: join(dir, 'run'), task: { name: 'fixture' }, command: '/fixture/claude', args: [], env: {},
    mcpConfig: { mcpServers: {} }, settingsOverrides: {}, metadata: {} };
  await runGateAgent(arm, { guardChrome: async (value, run) => { guarded++; assert.equal(value, arm); return run(); },
    runClaude: async () => ({ exit: { code: 0 }, stdout: '{"type":"result","result":"RESULT: ok"}', stderr: '', groupClean: true }) });
  assert.equal(guarded, 1);
});

test('the benchmark copy keeps Chrome\'s keychain key so claude.ai cookies still decrypt', () => {
  const copy = realBrowserPlan({ browser: 'chrome', round: 'fixture', profile: 'benchmark', surface: 'claude-in-chrome' });
  assert.ok(!copy.args.includes('--use-mock-keychain'));
  assert.ok(!copy.args.includes('--password-store=basic'));
  assert.match(copy.profileSource.keychain, /login keychain/);
  assert.ok(realBrowserPlan({ browser: 'chrome', round: 'fixture' }).args.includes('--use-mock-keychain'), 'fresh profiles keep the mock keychain');
});

test('evidence counts successful browser calls only, never device setup or failed calls', async () => {
  const { browserEvidence, evidenceProblems } = await import('../bench/fowl/real-gate-grade.mjs');
  const use = (id, name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id, content, isError = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  const memory = [use('a', 'mcp__sleight-turbo__browser_open', { url: 'https://en.wikipedia.org/wiki/Mount_Kilimanjaro' }),
    result('a', 'Turbo bench unavailable (effect unknown). Read before any retry.', true),
    use('b', 'mcp__claude-in-chrome__select_browser', { deviceId: device }), result('b', 'Selected browser "Chrome".')].join('\n');
  assert.deepEqual(browserEvidence(memory), { successfulCalls: 0, urls: [] });
  const wiki = { name: 'wikipedia' };
  assert.deepEqual(evidenceProblems({ task: wiki, evidence: browserEvidence(memory), visits: [] }),
    ['no successful browser tool call', 'no visit of wikipedia.org recorded']);
  const real = [use('c', 'mcp__claude-in-chrome__navigate', { url: 'https://en.wikipedia.org/wiki/Mount_Kilimanjaro' }), result('c', [{ type: 'text', text: 'Navigated' }])].join('\n');
  const evidence = browserEvidence(real);
  assert.equal(evidence.successfulCalls, 1);
  assert.deepEqual(evidence.urls, ['https://en.wikipedia.org/wiki/Mount_Kilimanjaro']);
  // Chrome and Helium need the browser's own navigation log; tool text counts only without one.
  assert.deepEqual(evidenceProblems({ task: wiki, evidence, visits: [] }), ['no visit of wikipedia.org recorded']);
  assert.deepEqual(evidenceProblems({ task: wiki, evidence, visits: ['https://en.wikipedia.org/wiki/Kilimanjaro'] }), []);
  assert.deepEqual(evidenceProblems({ task: wiki, evidence, visits: null }), []);
  assert.deepEqual(evidenceProblems({ task: { name: 'mdn' }, evidence, visits: ['https://developer.mozilla.org.evil.test/'] }), ['no visit of developer.mozilla.org recorded']);
  assert.deepEqual(evidenceProblems({ task: { name: 'mdn' }, evidence, visits: ['https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/418'] }), []);
  const codex = JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'completed', arguments: { code: 'open https://en.wikipedia.org/' } } });
  assert.equal(browserEvidence(codex).successfulCalls, 1);
  assert.equal(browserEvidence(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed', error: { message: 'x' } } })).successfulCalls, 0);
});

test('a lookup answered from memory fails even when its answer matches', async t => {
  const { gradeGateTask } = await import('../bench/fowl/real-gate-grade.mjs');
  const runner = { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) };
  const run = { exitCode: 0, result: { result: 'RESULT: 5,895 metres' } };
  const input = { task: { name: 'wikipedia' }, run, runner, after: {} };
  assert.equal(gradeGateTask({ ...input, evidence: { successfulCalls: 0, urls: [] }, visits: [] }).ok, false);
  assert.equal(gradeGateTask({ ...input, evidence: { successfulCalls: 3, urls: [] }, visits: ['https://en.wikipedia.org/wiki/Mount_Kilimanjaro'] }).ok, true);
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ext-lookup-')));
  const events = [];
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'chrome', out: join(dir, 'out') },
    tasks: [{ name: 'wikipedia', browser: 'helium', prompt: 'look it up in {browser}', result: 'the height' }], runner,
    runtime: { lockPath: join(dir, 'lock'), admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => ({ ...plan, pid: 1234, stop: async () => ({ browserClosed: true, profileDeleted: true }) }),
      checkOwner: async () => ({ ok: true }), resetBrowser: async () => ({}), observeBrowser: async () => ({}),
      watchBrowser: async () => { events.push('watch'); return { urls: () => [], close: async () => { events.push('unwatch'); } }; },
      runAgent: async arm => { mkdirSync(arm.dir); events.push('agent');
        return { groupClean: true, exitCode: 0, result: { result: 'RESULT: 5,895 m' }, evidence: { successfulCalls: 0, urls: [] } }; } } });
  process.exitCode = 0;
  assert.deepEqual(events, ['watch', 'agent', 'unwatch']);
  assert.equal(rows[0].outcome.ok, false);
  assert.match(rows[0].outcome.cell, /no successful browser tool call; no visit of wikipedia.org recorded/);
  assert.deepEqual(rows[0].navigation, { observed: true, urls: [] });
});

test('the navigation watcher records page URLs the browser reports while the agent runs', async () => {
  const { watchNavigations } = await import('../bench/fowl/real-browser.mjs');
  let listener; const sent = [];
  const connection = { on: fn => { listener = fn; }, close: async () => { sent.push('close'); },
    send: async method => { sent.push(method); return method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', url: 'data:text/html,marker' }] } : {}; } };
  const watch = await watchNavigations({}, { connect: async () => connection });
  listener({ method: 'Target.targetInfoChanged', params: { targetInfo: { type: 'page', url: 'https://en.wikipedia.org/wiki/Kilimanjaro' } } });
  listener({ method: 'Target.targetCreated', params: { targetInfo: { type: 'service_worker', url: 'https://worker.test/' } } });
  assert.deepEqual(watch.urls(), ['https://en.wikipedia.org/wiki/Kilimanjaro']);
  await watch.close();
  assert.deepEqual(sent, ['Target.setDiscoverTargets', 'Target.getTargets', 'close']);
});

test('a turbo round on a browser binary the product refuses stops before launch', async () => {
  const { gatePreflight } = await import('../bench/fowl/real-gate.mjs');
  const plan = { surface: 'sleight-turbo', browser: realBrowserPlan({ browser: 'chrome', round: 'fixture' }) };
  assert.match(gatePreflight(plan, { executable: () => 'writable by others (mode 775)' }).join(' '), /Turbo refuses .*Google Chrome \(writable by others \(mode 775\)\); the owner can run: chmod go-w/);
  assert.deepEqual(gatePreflight(plan, { executable: () => undefined }), []);
  assert.deepEqual(gatePreflight({ ...plan, surface: 'codex' }, { executable: () => 'writable by others (mode 775)' }), []);
});
