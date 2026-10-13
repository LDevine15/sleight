import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { outsideGit, worldAgentSetup } from './browser.mjs';

export function chromeArmPlan({ deviceFile = path.join(os.homedir(), '.config/sleight-bench/world/claude-in-chrome-device'),
  localState = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Local State'),
  manifest = path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_code_browser_extension.json'),
  backupDir = path.join(os.homedir(), '.config/sleight-bench/world/chrome-manifest-backups') } = {}) {
  const stat = fs.lstatSync(deviceFile);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Chrome device file must be an owned ordinary file with mode 0600');
  const deviceId = fs.readFileSync(deviceFile, 'utf8').trim();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(deviceId)) throw new Error('Invalid Chrome benchmark device ID');
  const profileFolder = benchmarkProfile(localState);
  return { deviceId, profileFolder, deviceFile, manifest, backupDir,
    launch: { command: '/usr/bin/open', args: ['-n', '-a', '/Applications/Google Chrome.app', '--args', `--profile-directory=${profileFolder}`] } };
}

let chromeTail = Promise.resolve();
export function withChromeArm(plan, run, { launch = spawnSync } = {}) {
  const next = chromeTail.then(() => withManifestBackup(plan.manifest, plan.backupDir, async () => {
    const started = Date.now();
    const launched = launch(plan.launch.command, plan.launch.args, { encoding: 'utf8', timeout: 15000 });
    if (launched.error) throw launched.error;
    if (launched.status !== 0) throw new Error(`Chrome profile launch failed: ${launched.stderr || launched.status}`);
    return run(started);
  }));
  chromeTail = next.catch(() => {});
  return next;
}

export function chromeHooks(stateFile, deviceId) {
  const command = process.execPath;
  const args = [fileURLToPath(new URL('./chrome-hook.mjs', import.meta.url)), stateFile, deviceId];
  return Object.fromEntries(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].map(event => [event,
    [{ matcher: event === 'PreToolUse' ? '*' : '^mcp__claude-in-chrome__(select_browser|list_connected_browsers)$',
      hooks: [{ type: 'command', command, args, timeout: 10 }] }]]));
}

function browserRows(response) {
  if (response?.isError) throw new Error('Chrome selection failed');
  if (Array.isArray(response)) return response.flatMap(row => row?.type === 'text' ? browserRows(row.text) : [row]);
  if (response?.structuredContent) return browserRows(response.structuredContent);
  if (response?.deviceId) return [response];
  if (typeof response === 'string') { try { return browserRows(JSON.parse(response)); } catch { return []; } }
  return (response?.content || []).flatMap(block => block.type === 'text' ? browserRows(block.text) : []);
}

export function chromeDeviceHook(input, stateFile, deviceId, { now = Date.now } = {}) {
  const stop = reason => ({ continue: false, stopReason: reason });
  let locked = false;
  try {
    const name = input.tool_name;
    const select = name === 'mcp__claude-in-chrome__select_browser';
    const list = name === 'mcp__claude-in-chrome__list_connected_browsers';
    const selected = input.tool_input?.deviceId ?? input.tool_input?.device_id;
    const changesDevice = name === 'mcp__claude-in-chrome__switch_browser' || (select && (selected !== deviceId ||
      (input.tool_input?.deviceId !== undefined && input.tool_input?.device_id !== undefined && input.tool_input.deviceId !== input.tool_input.device_id)));
    const read = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { confirmed: false, phase: 'first' };
    const current = read();
    if (current.failed) return stop(current.failed);
    if (current.confirmed && !changesDevice) return {};
    fs.mkdirSync(stateFile + '.lock', { mode: 0o700 }); locked = true;
    const state = read();
    const save = () => {
      const temp = stateFile + '.' + crypto.randomUUID();
      try { fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, stateFile); }
      finally { fs.rmSync(temp, { force: true }); }
    };
    const refuse = reason => { state.failed = reason; save(); return stop(reason); };
    if (state.failed) return stop(state.failed);
    if (changesDevice) return refuse('Chrome benchmark device cannot be changed');
    const retry = () => {
      state.phase = 'verify'; save();
      return { hookSpecificOutput: { hookEventName: input.hook_event_name,
        additionalContext: 'Chrome device is not confirmed yet. Retry select_browser or list_connected_browsers until the pinned device has inUse true. Task tools remain blocked, and the gate stops after 10 seconds.' } };
    };
    if (input.hook_event_name === 'PreToolUse') {
      if (state.confirmed) return {};
      if (state.confirmationDeadline !== undefined && now() >= state.confirmationDeadline) return refuse('Chrome device was not confirmed within 10 seconds; retry the run after checking the benchmark profile');
      if ((state.phase === 'first' && select) || (state.phase === 'verify' && (select || list))) {
        state.confirmationDeadline ??= now() + 10000;
        state.phase = select ? 'selecting' : 'listing'; state.toolUseId = input.tool_use_id; save(); return {};
      }
      return refuse('First call must select the pinned Chrome device; task tools wait for an in-use confirmation');
    }
    if (state.confirmed) return {};
    if (input.tool_use_id !== state.toolUseId || (!select && !list)) return refuse('Chrome selection did not complete');
    if (input.hook_event_name === 'PostToolUseFailure' || input.tool_response?.isError) return retry();
    if (input.hook_event_name !== 'PostToolUse') return refuse('Chrome selection did not complete');
    const rows = browserRows(input.tool_response);
    if (rows.some(row => row?.deviceId !== deviceId && row?.inUse === true)) return refuse('Another connected Chrome browser is in use');
    const matches = rows.filter(row => row?.deviceId === deviceId);
    if (matches.length === 1 && matches[0].inUse === true) {
      state.confirmed = true; state.confirmedAt = now(); state.confirmationTool = name;
    } else if (matches.length > 1) return refuse('Chrome result has ambiguous entries for the pinned device');
    else return retry();
    save(); return {};
  } catch (error) { return stop(`Chrome device gate failed: ${error.message}`); }
  finally { if (locked) fs.rmdirSync(stateFile + '.lock'); }
}

export function chromeProbePlan({ dir, armRoot, chromeFiles } = {}) {
  const setup = worldAgentSetup({ surface: 'claude-in-chrome', dir, armRoot });
  const chrome = chromeArmPlan(chromeFiles);
  return { ...setup, env: { ...setup.env, ENABLE_TOOL_SEARCH: 'false' }, chrome,
    args: ['-p', '--model', 'claude-haiku-5-5', '--max-turns', '1', '--verbose', '--output-format', 'stream-json',
      '--chrome', '--strict-mcp-config', '--mcp-config', path.join(dir, 'mcp.json'), '--settings', path.join(dir, 'settings.json'),
      '--tools', '', ...setup.args, 'Reply OK without calling tools. This probe reads the tool inventory from the startup event.'] };
}

export function benchmarkProfile(localState) {
  const profiles = JSON.parse(fs.readFileSync(localState, 'utf8')).profile?.info_cache || {};
  const folders = Object.entries(profiles).filter(([, profile]) => profile.name === 'sleight benchmark').map(([folder]) => folder);
  if (folders.length !== 1) throw new Error(`Chrome benchmark profile ${folders.length ? 'is ambiguous' : 'is missing'}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(folders[0])) throw new Error('Invalid Chrome profile folder');
  return folders[0];
}

// The backup lock excludes this harness, not the owner's CLI. Device hooks check the connected inventory.
export async function withManifestBackup(manifest, backupDir, run) {
  outsideGit(backupDir);
  let stat;
  try { stat = fs.lstatSync(manifest); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && !stat.isFile()) throw new Error('Chrome native-messaging manifest must be an ordinary file');
  fs.mkdirSync(backupDir, { recursive: true });
  const active = path.join(backupDir, 'active');
  const backup = path.join(active, 'original.json');
  try { fs.mkdirSync(active, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Chrome manifest backup is active at ${active}. Verify no benchmark harness is running. If stale and ${backup} exists, restore its bytes and mode to ${manifest}. Without that backup, verify the prior manifest state before changing it. Then rename or remove ${active} before retrying. Do not remove a live run's backup.`);
  }
  try {
    if (stat) fs.writeFileSync(backup, fs.readFileSync(manifest), { mode: stat.mode & 0o777, flag: 'wx' });
  } catch (error) { fs.rmSync(active, { recursive: true, force: true }); throw error; }
  let restored = false;
  const restore = () => {
    if (restored) return;
    if (stat) {
      const restore = `${manifest}.sleight-${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(restore, fs.readFileSync(backup), { mode: stat.mode & 0o777, flag: 'wx' });
      fs.chmodSync(restore, stat.mode & 0o777);
      fs.renameSync(restore, manifest);
    } else fs.rmSync(manifest, { force: true });
    // Leave the backup for recovery if restoration throws.
    fs.rmSync(active, { recursive: true, force: true });
    restored = true;
  };
  process.once('exit', restore);
  try {
    const result = run();
    process.removeListener('exit', restore); process.once('exit', restore);
    return await result;
  } finally { process.removeListener('exit', restore); restore(); }
}
