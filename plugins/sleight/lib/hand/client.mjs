// The relay's side of the ghost hand: one host per session, spawned on first use through host.mjs's build pipeline. send and hide
// are fire-and-forget pipe writes that never throw or wait. A dead host or a failed spawn only traces, and the session goes on
// without a hand. When the host isn't compiled yet, first use starts the build in the background and that session has no hand.
//
// Caller frames: { kind, pid, windowId, at: [x, y], path: [[x, y], ...], delayMs, beats } in global top-left screen points
// (kCGWindowBounds and AX frames). kind is click, double, right, key, type, drag or scroll. The hand glides along path into at
// and flourishes there beats times; a drag grabs at at and carries along path. path defaults to [at], delayMs to 0 and beats to 1.
import { randomBytes } from 'node:crypto';
import { handHostBuilt, prepareHandHost } from '../direct-browser/host.mjs';
import { handSetting } from './settings.mjs';
import { setHandPid } from './pid.mjs';

const kinds = new Set(['click', 'double', 'right', 'key', 'type', 'drag', 'scroll']);
const round = value => Math.round(value * 100) / 100;
const point = value => Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000)
  ? [round(value[0]), round(value[1])] : undefined;
const id = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
// A longer path keeps its ends and 62 evenly spaced points between them.
const thin = path => path.length <= 64 ? path : Array.from({ length: 64 }, (_, i) => path[Math.round(i * (path.length - 1) / 63)]);

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

/** `enabled` is true while this session may still show the hand: the settings allow it and the host hasn't failed. */
export function createHandClient({ env = process.env, setting = () => handSetting({ env }), built = handHostBuilt, prepare = prepareHandHost,
  trace = () => {}, now = Date.now, defer = setImmediate, recheckMs = 60000 } = {}) {
  const nonce = randomBytes(32).toString('hex'), queue = [];
  let seq = 0, child, state, checked = now(), checking = false, capture = 'hidden', running;
  // idle (not started), starting, running, disabled (settings say off; rechecked) or dead (failed this session; final)
  const allowed = () => {
    try {
      const current = setting();
      capture = current?.capture === 'visible' ? 'visible' : 'hidden';
      return current?.enabled === true;
    } catch { return false; }
  };
  state = allowed() ? 'idle' : 'disabled';
  const note = (direction, detail) => { try { trace(direction, detail); } catch {} };
  const write = line => {
    try {
      if (child.stdin.writableLength > 65536) { note('hand-dropped', { reason: 'backpressure' }); return; }
      child.stdin.write(line);
    } catch (error) { note('hand-dropped', { reason: error?.code ?? 'write' }); }
  };
  const act = (wire, delayMs = wire.delayMs) => JSON.stringify({ hand: 'act', nonce, seq: ++seq, kind: wire.kind, pid: wire.pid,
    windowId: wire.windowId, at: wire.at, path: wire.path, delayMs, beats: wire.beats }) + '\n';
  const stop = () => {
    queue.length = 0;
    if (!child) return;
    const ending = child; child = undefined;
    try { ending.stdin.end(); } catch {}
  };
  const die = (reason, detail) => { if (state === 'dead') return; state = 'dead'; stop(); note('hand-off', { reason, ...detail }); };

  function start() {
    if (state !== 'starting') return;
    if (!allowed()) { state = 'disabled'; queue.length = 0; return; }
    let ready;
    try { ready = built(); } catch { ready = false; }
    if (!ready) {
      die('building');
      Promise.resolve().then(prepare).then(result => note('hand-built', { status: result?.status, code: result?.code }),
        () => note('hand-built', { status: 'unavailable' }));
      return;
    }
    Promise.resolve().then(prepare).then(result => {
      if (state !== 'starting') return;
      if (result?.status !== 'ready') return die('unavailable', { code: result?.code });
      const started = result.spawn({ capture });
      running = capture;
      started.on('error', error => die('spawn', { code: error?.code }));
      started.stdin.on('error', error => note('hand-dropped', { reason: error?.code ?? 'pipe' }));
      // A host replaced for a new capture mode exits after its successor may have started, and must not clear its pid.
      started.on('exit', (code, signal) => {
        if (child === started) { setHandPid(0); die('exit', { code, signal }); } else if (!child) setHandPid(0);
      });
      child = started; state = 'running';
      setHandPid(started.pid);
      note('hand-started', { pid: started.pid });
      for (const { wire, at } of queue.splice(0)) write(act(wire, Math.max(0, wire.delayMs - (now() - at))));
    }).catch(error => die('spawn', { code: error?.code ?? error?.message }));
  }
  // The settings are read again at most once a minute, off the caller's path: hand off stops this session's host, hand on lets
  // a disabled session start one, and a new capture mode replaces the running host at the next frame.
  function recheck() {
    if (checking || now() - checked < recheckMs) return;
    checking = true;
    defer(() => {
      checking = false; checked = now();
      const on = allowed();
      if (!on && ['idle', 'starting', 'running'].includes(state)) { state = 'disabled'; stop(); note('hand-off', { reason: 'setting' }); }
      else if (on && state === 'disabled') state = 'idle';
      else if (on && state === 'running' && running !== capture) { stop(); state = 'idle'; note('hand-restart', { capture }); }
    });
  }

  return Object.freeze({
    send(frame) {
      recheck();
      if (state === 'disabled' || state === 'dead') return;
      const wire = handWireFrame(frame);
      if (typeof wire === 'string') { note('hand-dropped', { reason: wire }); return; }
      if (state === 'running') { write(act(wire)); return; }
      if (queue.length < 32) queue.push({ wire, at: now() });
      if (state === 'idle') { state = 'starting'; defer(start); }
    },
    hide() {
      if (state === 'running') write(JSON.stringify({ hand: 'hide', nonce }) + '\n');
      else queue.length = 0;
    },
    close() { if (state !== 'dead') { state = 'dead'; stop(); } },
    get enabled() { return state !== 'disabled' && state !== 'dead'; },
  });
}
