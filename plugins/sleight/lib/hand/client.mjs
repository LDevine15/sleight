// The relay's side of the ghost hand, and the owner of the session's host: one consent-host process at a time that draws the
// hand and, from turbo's fork on, serves turbo's consent channel (fds 3 and 4 of a host opened for that fork, handed to the
// worker by shareConsent, and closed in the relay right after). send and hide
// are fire-and-forget pipe writes that never throw or wait. A dead host or a failed spawn only traces, and the session goes on
// without a hand. When the host isn't compiled yet, first use starts the build in the background and that session has no hand.
//
// Caller frames: { kind, pid, windowId, at: [x, y], path: [[x, y], ...], delayMs, beats } in global top-left screen points
// (kCGWindowBounds and AX frames). kind is click, double, right, key, type, drag or scroll. The hand glides along path into at
// and flourishes there beats times; a drag grabs at at and carries along path. path defaults to [at], delayMs to 0 and beats to 1.
import { randomBytes } from 'node:crypto';
import { readFileSync, watch as fsWatch } from 'node:fs';
import { dirname } from 'node:path';
import { handHostBuilt, prepareHandHost } from '../direct-browser/host.mjs';
import { handConfigPath, handSetting } from './settings.mjs';
import { setHandPid } from './pid.mjs';
import { currentApp as noted } from '../permissions.mjs';

const kinds = new Set(['click', 'double', 'right', 'key', 'type', 'drag', 'scroll']);
const round = value => Math.round(value * 100) / 100;
const point = value => Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000)
  ? [round(value[0]), round(value[1])] : undefined;
const id = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
// A longer path keeps its ends and 62 evenly spaced points between them.
const thin = path => path.length <= 64 ? path : Array.from({ length: 64 }, (_, i) => path[Math.round(i * (path.length - 1) / 63)]);
// The version the hand's menu block shows.
const version = (() => {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version) ? version : '0.0.0';
  } catch { return '0.0.0'; }
})();

/** The host's frame for a caller frame, without nonce or seq, or a reason string when it can't be drawn. */
export function handWireFrame(frame) {
  if (!frame || typeof frame !== 'object' || !kinds.has(frame.kind)) return 'kind';
  const pid = id(frame.pid, 2147483647), windowId = id(frame.windowId, 4294967295), at = point(frame.at);
  if (!pid || !windowId || !at) return 'target';
  const raw = frame.path === undefined || Array.isArray(frame.path) && !frame.path.length ? [frame.at] : frame.path;
  if (!Array.isArray(raw)) return 'path';
  const path = thin(raw).map(point);
  if (path.some(p => !p)) return 'path';
  const delayMs = Math.min(10000, Math.max(0, Math.round(Number.isFinite(frame.delayMs) ? frame.delayMs : 0)));
  const beats = Math.min(20, Math.max(1, Math.round(Number.isFinite(frame.beats) ? frame.beats : 1)));
  return { kind: frame.kind, pid, windowId, at, path, delayMs, beats };
}

// The process's latest open client: turbo's bridge shares its host.
let current;
const sharing = new WeakMap();
/** Turbo's bridge, right before it forks its worker: a consent channel to the session's host as { write, read, release }. It
 *  starts the host even with the hand off. undefined when there is no open client or no host. */
export async function shareConsent() {
  const share = current && sharing.get(current);
  return share ? share() : undefined;
}
/** The ghost hand's integration point: the session's one client for the relay and its hooks, created on the first call and
 *  the same one after (while open), and none while the settings keep it off. The launcher creates it at startup, so turbo's first fork
 *  can share its host. */
export function sessionHandClient(options = {}) {
  const env = options.env ?? process.env;
  if (env.SLEIGHT_HAND === '0' || !(options.setting ?? (() => handSetting({ env })))().enabled) return undefined;
  return current ?? createHandClient(options);
}

// The files behind the menu's Permissions rows. A change to any of them sends the host a fresh menu frame.
const permissionFiles = new Set(['preapproved.json', 'permissions.json', 'electron-grants.json', 'turbo.json']);
const command = async () => import('../permissions-command.mjs');

/** `enabled` is true while this session may still show the hand: the settings allow it and the host hasn't failed.
 *  permissions: the menu's Permissions rows (menu() gives { payload, offered }) and their clicks (apply), or null for none. */
export function createHandClient({ env = process.env, setting = () => handSetting({ env }), built = handHostBuilt, prepare = prepareHandHost,
  trace = () => {}, now = Date.now, defer = setImmediate, recheckMs = 60000, killAfterMs = 2000,
  setHand = async enabled => (await import('./command.mjs')).writeHandSetting({ enabled }),
  permissions = { menu: async () => (await command()).permissionsMenu(), apply: async (event, offered) => (await command()).applyMenuEvent(event, offered) },
  currentApp = noted,
  watch = (folder, listener) => process.platform === 'darwin' ? fsWatch(folder, { persistent: false }, listener) : undefined } = {}) {
  const nonce = randomBytes(32).toString('hex'), queue = [];
  // host: none, starting, running or dead (failed or closed this session; final). hand: the settings allow the hand.
  let seq = 0, child, host = 'none', starting, hand = false, capture = 'hidden', checked = now(), checking = false, events = '';
  // Hosts opened for turbo's fork, which serve its consent channel: never killed, they end with their worker.
  const attached = new WeakSet();
  let chain = Promise.resolve();
  const read = () => {
    try {
      const value = setting();
      capture = value?.capture === 'visible' ? 'visible' : 'hidden';
      return value?.enabled === true;
    } catch { return false; }
  };
  hand = read();
  const note = (direction, detail) => { try { trace(direction, detail); } catch {} };
  const write = line => {
    try {
      if (child.stdin.writableLength > 65536) { note('hand-dropped', { reason: 'backpressure' }); return; }
      child.stdin.write(line);
    } catch (error) { note('hand-dropped', { reason: error?.code ?? 'write' }); }
  };
  const act = (wire, delayMs = wire.delayMs) => JSON.stringify({ hand: 'act', nonce, seq: ++seq, kind: wire.kind, pid: wire.pid,
    windowId: wire.windowId, at: wire.at, path: wire.path, delayMs, beats: wire.beats }) + '\n';
  // perms: the last Permissions rows sent, with the targets a click may act on; permsText detects a change.
  let perms, permsText, permsApp, refreshing = false, again = false;
  const menu = () => JSON.stringify({ hand: 'menu', nonce, enabled: hand, capture, version, ...perms?.payload ? { permissions: perms.payload } : {} }) + '\n';
  async function loadPermissions() {
    if (!permissions) return false;
    let next;
    try { next = await permissions.menu(); } catch (error) { note('permissions-unavailable', { code: error?.code ?? 'read' }); return false; }
    permsApp = currentApp()?.bundleId;
    const text = JSON.stringify(next?.payload ?? null);
    if (text === permsText) return false;
    perms = next; permsText = text;
    return true;
  }
  // Off the caller's path, one at a time; a change while one runs reads again once it ends.
  function refreshPermissions() {
    if (!permissions || host !== 'running') return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    loadPermissions().then(changed => { if (changed && host === 'running') write(menu()); })
      .finally(() => { refreshing = false; if (again) { again = false; refreshPermissions(); } });
  }
  // A host exits at the end of its hand input. A hand-only one that hasn't after killAfterMs is killed; one serving turbo's
  // consent channel stays until that channel ends, so neither the hand's faults nor its close take turbo down.
  const stopChild = ending => {
    if (!attached.has(ending)) {
      const timer = setTimeout(() => { if (ending.exitCode == null && ending.signalCode == null) try { ending.kill(); } catch {} }, killAfterMs);
      timer.unref?.();
      ending.once('exit', () => clearTimeout(timer));
    }
    try { ending.stdin.end(); } catch {}
  };
  const stop = () => {
    queue.length = 0;
    if (!child) return;
    const ending = child; child = undefined;
    stopChild(ending);
  };
  const die = (reason, detail) => { if (host === 'dead') return; host = 'dead'; stop(); note('hand-off', { reason, ...detail }); };
  // The Permissions rows' clicks: { permissions: 'revoke' | 'block', nonce, target } or { permissions: 'revoke-all', nonce }, with this
  // session's nonce. apply acts only on a target the last menu offered, and only ever removes access.
  function permissionEvent(event) {
    const keys = Object.keys(event).sort().join();
    if (!permissions || event.nonce !== nonce || !(keys === 'nonce,permissions' && event.permissions === 'revoke-all' ||
        keys === 'nonce,permissions,target' && ['revoke', 'block'].includes(event.permissions) && typeof event.target === 'string' && event.target.length <= 300)) return false;
    note('permissions-click', { op: event.permissions });
    Promise.resolve().then(() => permissions.apply(event, perms?.offered)).then(() => refreshPermissions(),
      error => note('permissions-failed', { code: /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'PERMISSIONS_FAILED' }));
    return true;
  }
  // The Ghost Hand row's clicks: exact { hand: 'toggle', nonce, enabled } lines with this session's nonce, on the host's stdout.
  function onEvents(chunk) {
    events += chunk;
    if (events.length > 65536) { events = ''; note('hand-toggle-refused', { reason: 'size' }); return; }
    let end;
    while ((end = events.indexOf('\n')) >= 0) {
      const text = events.slice(0, end); events = events.slice(end + 1);
      let event;
      try { event = JSON.parse(text); } catch {}
      if (event && typeof event === 'object' && Object.hasOwn(event, 'permissions') && permissionEvent(event)) continue;
      if (!event || typeof event !== 'object' || Object.keys(event).sort().join() !== 'enabled,hand,nonce' || event.hand !== 'toggle' ||
          event.nonce !== nonce || typeof event.enabled !== 'boolean') { note('hand-toggle-refused', {}); continue; }
      Promise.resolve().then(() => setHand(event.enabled)).then(() => recheck(true),
        error => note('hand-toggle-failed', { code: /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'HAND_SETUP_FAILED' }));
    }
  }
  // Spawns a host, hand-only or with turbo's consent channel, and makes it the session's: the hand's menu frame and queued
  // frames go to it, and the host it replaces is stopped. Resolves the new host, or undefined when there is none.
  async function launch(consent) {
    let ready;
    try { ready = built(); } catch { ready = false; }
    if (!ready) {
      die('building');
      Promise.resolve().then(prepare).then(result => note('hand-built', { status: result?.status, code: result?.code }),
        () => note('hand-built', { status: 'unavailable' }));
      return undefined;
    }
    try {
      const result = await prepare();
      if (host === 'dead') return undefined;
      if (result?.status !== 'ready') { die('unavailable', { code: result?.code }); return undefined; }
      // The first menu frame already carries the Permissions rows.
      await loadPermissions();
      if (host === 'dead') return undefined;
      const started = result.spawn({ capture, consent });
      if (consent) attached.add(started);
      started.on('error', error => { if (child === started) die('spawn', { code: error?.code }); });
      started.stdin.on('error', error => note('hand-dropped', { reason: error?.code ?? 'pipe' }));
      started.stdout?.on('data', onEvents);
      started.on('exit', (code, signal) => { if (child === started) { setHandPid(0); die('exit', { code, signal }); } else if (!child) setHandPid(0); });
      const previous = child;
      child = started; host = 'running';
      setHandPid(started.pid);
      note('hand-started', { pid: started.pid, consent });
      write(menu());
      for (const { wire, at } of queue.splice(0)) write(act(wire, Math.max(0, wire.delayMs - (now() - at))));
      if (previous) stopChild(previous);
      return started;
    } catch (error) { die('spawn', { code: error?.code ?? error?.message }); return undefined; }
  }
  // Launches run one at a time, off the caller's path.
  const serial = consent => {
    const next = chain.then(() => new Promise(resolve => defer(() => resolve(launch(consent)))));
    chain = next.catch(() => {});
    return next;
  };
  // While no host runs, frames queue behind the launch in flight.
  const begin = next => {
    if (host !== 'running') {
      host = 'starting';
      const pending = next.then(Boolean).finally(() => { if (starting === pending) starting = undefined; });
      starting = pending;
    }
    return next;
  };
  // Starts the session's hand-only host once. Resolves true while a host runs.
  function ensure() {
    if (host === 'running') return Promise.resolve(true);
    if (host === 'dead') return Promise.resolve(false);
    if (!starting) begin(serial(false));
    return starting;
  }
  // The settings are read again when sleight's settings folder changes (the Ghost Hand row or the hand command), and at most
  // once a minute otherwise, off the caller's path. Off hides the hand at once and keeps the shared host, which turbo may use;
  // the host's menu frame carries the new setting and capture mode.
  function recheck(force = false) {
    if (checking || !force && now() - checked < recheckMs) return;
    checking = true;
    defer(() => {
      checking = false; checked = now();
      const before = [hand, capture];
      hand = read();
      if (!hand) queue.length = 0;
      if (host === 'running' && (before[0] !== hand || before[1] !== capture)) {
        if (!hand) { write(JSON.stringify({ hand: 'hide', nonce }) + '\n'); note('hand-off', { reason: 'setting' }); }
        write(menu());
      }
      // Last-use times come from other sessions' records too, so the rows are read again with the minute's recheck.
      refreshPermissions();
    });
  }
  let watcher;
  try {
    watcher = watch(dirname(handConfigPath()), (_event, name) => {
      if (!name || String(name) === 'hand.json') recheck(true);
      if (!name || permissionFiles.has(String(name))) refreshPermissions();
    });
  }
  catch {} // no settings folder yet: the minute's recheck covers it

  const client = Object.freeze({
    send(frame) {
      recheck();
      // A new app to act in changes the menu's Never Act in row.
      if (host === 'running' && currentApp()?.bundleId !== permsApp) refreshPermissions();
      if (!hand || host === 'dead') return;
      const wire = handWireFrame(frame);
      if (typeof wire === 'string') { note('hand-dropped', { reason: wire }); return; }
      if (host === 'running') { write(act(wire)); return; }
      if (queue.length < 32) queue.push({ wire, at: now() });
      ensure();
    },
    hide() {
      if (host === 'running') write(JSON.stringify({ hand: 'hide', nonce }) + '\n');
      else queue.length = 0;
    },
    close() {
      try { watcher?.close(); } catch {}
      watcher = undefined;
      if (current === client) current = undefined;
      if (host !== 'dead') { host = 'dead'; stop(); }
    },
    get enabled() { return hand && host !== 'dead'; },
  });
  // The relay keeps no copy of the consent channel: release closes its ends once the worker has its own.
  // Each fork of turbo's worker gets a fresh host with a fresh consent channel, which replaces the session's host (one glove),
  // so a worker after a crash reattaches. The relay holds the channel's ends only until release, right after the fork.
  sharing.set(client, async () => {
    if (host === 'dead') return undefined;
    const started = await begin(serial(true));
    if (!started?.stdio?.[3] || !started.stdio[4]) return undefined;
    const [write, read] = [started.stdio[3], started.stdio[4]];
    return Object.freeze({ write, read, release() { for (const end of [write, read]) try { end.destroy(); } catch {} } });
  });
  current = client;
  return client;
}
