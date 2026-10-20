// Read only the bundle and three named state files. Never read daemon credentials, browser storage or bot data.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The same JXA helper sleight uses for native AX metadata, under this caller's process tree.
// AXIsProcessTrusted checks TCC without requesting access or sending Apple events.
export function readNativeAccessibility({ exec = execFileSync } = {}) {
  const result = JSON.parse(exec('/usr/bin/osascript', ['-l', 'JavaScript',
    fileURLToPath(new URL('app-health.js', import.meta.url)), '--accessibility-check'],
  { encoding: 'utf8', timeout: 3000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }));
  return typeof result.trusted === 'boolean' ? result.trusted : undefined;
}

function pidRunning(pid) {
  // Signal 0 checks existence without sending a signal. This does not prove daemon identity or health.
  try { process.kill(pid, 0); return true; }
  catch (err) { if (err.code === 'ESRCH') return false; throw err; }
}

export function grokbotStatus({ home = homedir(), read = readFileSync, running = pidRunning,
  accessibility = readNativeAccessibility } = {}) {
  let installed = false, version;
  for (const app of ['/Applications/Grok Bot.app', join(home, 'Applications/Grok Bot.app')]) {
    let contents;
    try { contents = read(join(app, 'Contents/Info.plist')); }
    catch (err) { if (err.code === 'ENOENT') continue; installed = undefined; break; }
    installed = true;
    try {
      // Decode XML and binary plists from the injected bytes, without letting plutil open another file.
      const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'],
        { input: contents, encoding: 'utf8', timeout: 2000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'ignore'] }));
      if (typeof info?.CFBundleShortVersionString === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(info.CFBundleShortVersionString)
        && info.CFBundleShortVersionString.length <= 64) version = info.CFBundleShortVersionString;
    } catch {}
    break;
  }
  const dir = join(home, '.grokbot');
  const json = name => { try { return JSON.parse(read(join(dir, name))); } catch { return undefined; } };
  const gate = json('local-computer-use-gate.json');
  const settings = json('settings.json');
  const daemon = json('local-exec-daemon.json');
  const computerUse = typeof gate?.isOn === 'boolean' ? gate.isOn : undefined;
  const localToolPermission = ['always', 'ask', 'never'].includes(settings?.localToolPermission) ? settings.localToolPermission : undefined;
  let daemonRunning;
  if (Number.isInteger(daemon?.pid) && daemon.pid > 0 && daemon.pid <= 2147483647) {
    try { const result = running(daemon.pid); if (typeof result === 'boolean') daemonRunning = result; } catch {}
  }
  let nativeAccessibility;
  try { const value = accessibility(); if (typeof value === 'boolean') nativeAccessibility = value; } catch {}
  return { installed, version, computerUse, daemonRunning, localToolPermission, nativeAccessibility };
}

export function grokbotDoctorLines(status) {
  const computerUse = status.computerUse === true ? 'on' : status.computerUse === false ? 'off' : 'unknown';
  const daemon = status.daemonRunning === true ? 'running (recorded PID exists, identity and health unchecked)'
    : status.daemonRunning === false ? 'not running (recorded PID exited)' : 'unknown';
  const lines = [`Grok Bot${status.version ? ` ${status.version}` : ''}, computer use ${computerUse}, route: shell (sleight-mcp js)`];
  if (status.installed === false) lines.push('note      Grok Bot bundle not found in /Applications or ~/Applications.');
  else if (!status.version) lines.push('note      Grok Bot bundle version unknown.');
  lines.push(`note      local daemon: ${daemon}`, `note      local tool permission: ${status.localToolPermission ?? 'unknown'}`);
  const trust = status.nativeAccessibility === true ? 'granted' : status.nativeAccessibility === false ? 'denied' : 'unknown';
  lines.push(`note      native helper Accessibility: ${trust} (current process tree, AXIsProcessTrusted; no prompt)`);
  if (status.nativeAccessibility === false) lines.push('PROBLEM   grant Accessibility to the responsible app for this process tree, Grok Bot when called through its local shell, or the terminal when called there. Then rerun doctor from that same caller.');
  if (status.nativeAccessibility === undefined) lines.push('note      native helper trust check unavailable; rerun doctor from Grok Bot\'s local shell to check its grant.');
  if (status.computerUse === true) lines.push('PROBLEM   Grok Bot computer use is a second driver. Its input does not share sleight\'s lease.');
  return lines;
}
