// Strict fakes for the resident Electron host tests. No app, no Python, no engine: a fake app that
// answers CDP-shaped requests on in-memory pipes, and a fake launch adapter that models the
// directory/lock/process facts the real adapter (launch.py) reads from the Mac.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { ElectronBroker } from '../bench/direct-electron/broker.mjs';
import { createElectronHost } from '../plugins/sleight/lib/direct-browser/electron-host.mjs';
import { createElectronConnection } from '../plugins/sleight/lib/direct-browser/electron-connection.mjs';

export const tick = (ms = 0) => new Promise(resolve => ms ? setTimeout(resolve, ms) : setImmediate(resolve));
export async function until(check, label = 'condition', ms = 2000) {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > ms) throw Error('timed out waiting for ' + label); await tick(5); }
}

/** The fake app's pipe. Replies to CDP-shaped requests; records every frame it receives. */
export function fakeApp({ pid = 4100, birth = 'birth-1' } = {}) {
  const input = new PassThrough(), output = new PassThrough();
  const app = { pid, birth, input, output, frames: [], hang: new Set(), alive: true, sessions: 0, queue: [] };
  let buffer = '';
  input.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\0')) {
      const at = buffer.indexOf('\0');
      const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      app.frames.push(request);
      if (app.hang.has(request.method)) continue;
      const reply = result => queueMicrotask(() => output.write(JSON.stringify({ id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }) + '\0'));
      if (request.method === 'Page.fail') {
        queueMicrotask(() => output.write(JSON.stringify({ id: request.id, error: { code: -32000, message: 'No such thing' }, ...(request.sessionId ? { sessionId: request.sessionId } : {}) }) + '\0'));
      } else if (request.method === 'Target.attachToTarget') reply({ sessionId: 'S' + (++app.sessions) });
      else if (request.method === 'Browser.getVersion') reply({ protocolVersion: '1.3', product: 'Chrome/130.0.6723.0', revision: '@1', jsVersion: '13.0.245', pid,
        userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.0 Electron/33.0.0 Safari/537.36' });
      else reply({ ok: true });
    }
  });
  app.emit = (frame) => output.write(JSON.stringify(frame) + '\0');
  return app;
}

/** A model of the disk and process table that two hosts (before and after a crash) both see. */
export function fakeWorld() {
  return { lock: undefined, alive: false, descendants: [], inodeMatches: true, collectBlocked: undefined, apps: [], reservations: 0 };
}

export function fakeAdapter(world, { appFactory = () => fakeApp() } = {}) {
  const events = new EventEmitter();
  let app, reserved;
  const adapter = {
    events, lost: false, calls: [],
    streams: undefined,
    async rpc(cmd, payload = {}) {
      adapter.calls.push([cmd, payload]);
      if (cmd === 'lockstate') {
        if (!world.lock) return { exists: false };
        return { exists: true, directory: true, nonce: world.lock.nonce, profile: world.lock.root, phase: world.lock.phase, markerNonce: world.lock.markerNonce ?? world.lock.nonce };
      }
      if (cmd === 'reserve') {
        if (world.lock) throw Error('FileExistsError: retained ownership prevents another reservation');
        world.reservations++;
        world.lock = { nonce: 'nonce-' + world.reservations, root: '/tmp/sleight-ep2-fake' + world.reservations, phase: 'reserved', build: payload.build };
        reserved = world.lock;
        return { nonce: world.lock.nonce, root: world.lock.root, lock: '/tmp/lock' };
      }
      if (cmd === 'recover') {
        if (!world.lock || world.lock.nonce !== payload.nonce || !world.inodeMatches) throw Error('RuntimeError: recorded inode identity does not match the directories found');
        reserved = world.lock; return {};
      }
      if (cmd === 'spawn') {
        app = appFactory(); world.apps.push(app); world.alive = true; world.lock.phase = 'spawned';
        adapter.streams = { input: app.input, output: app.output };
        return { pid: app.pid, birth: app.birth };
      }
      if (cmd === 'inspect') {
        return { parent: world.alive ? { pid: app?.pid ?? world.lock.pid ?? 1, birth: app?.birth ?? 'birth-1' } : null, descendants: world.descendants, complete: world.complete !== false };
      }
      if (cmd === 'confirmAbsent') return { absent: !world.alive && world.descendants.length === 0 };
      if (cmd === 'collect') {
        if (world.collectBlocked) return { cleanup: 'retained', reason: world.collectBlocked };
        if (world.alive || world.descendants.length || world.complete === false) return { cleanup: 'retained', reason: 'descendant census incomplete or processes remain' };
        world.lock = undefined; return { cleanup: 'removed' };
      }
      throw Error('unknown fake adapter command ' + cmd);
    },
    close() {},
  };
  return adapter;
}

export function tempState() {
  const dir = mkdtempSync(join(tmpdir(), 'ehost-'));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function makeHost({ world = fakeWorld(), dir, appFactory, hostOptions = {}, adapter } = {}) {
  const state = dir ? { dir, remove() {} } : tempState();
  let current;
  const host = await createElectronHost({
    stateDir: state.dir, Broker: ElectronBroker, builds: ['fake-build'],
    createAdapter: async () => { current = adapter ?? fakeAdapter(world, { appFactory }); return current; },
    authorizeLaunch: async () => true,
    requestQuit: async () => { world.alive = false; world.apps.at(-1)?.output.end(); },
    resumeAuthority: async () => true,
    brokerOptions: { identityMaxAgeMs: 0 },
    ...hostOptions,
  });
  return { host, world, state, get adapter() { return current; }, get app() { return world.apps.at(-1); } };
}

export async function connectWorker(host, session = 'worker-1', ticketOptions = {}) {
  const handle = host.issueTicket({ session, ...ticketOptions });
  const connection = await createElectronConnection({ handle });
  await connection.connect();
  return { connection, handle };
}

/** Sends raw bytes to the host's socket and collects what comes back. For forged-client tests. */
export function rawSocket(path) {
  const socket = net.connect(path);
  const received = [];
  let closed = false;
  socket.on('data', chunk => received.push(chunk));
  socket.on('error', () => {});
  socket.on('close', () => { closed = true; });
  return { socket, received, text: () => Buffer.concat(received).toString(), get closed() { return closed; } };
}
