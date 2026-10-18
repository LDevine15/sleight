// The resident Electron host: the one process that holds an opted-in app's pipe and its ownership
// record while turn workers come and go. Nothing imports this file in the installed path yet
// (EPV3-7 wires it); it opens no listener or process until createElectronHost() is called.
//
// Layers, from the app outwards:
//   Python adapter (electron/launch.py --adapter): reserves the profile and lock,
//     spawns the app on the pipe ends this process created, reports identity and census.
//   ElectronBroker (electron/broker.mjs): the only reader/writer of the app's pipe.
//   this file: the app owner (journal, reconciliation) and the local channel workers use.
// Trusted Playwright traffic reaches the broker only through an authenticated channel. The
// worker's v3 context and the shared rules decide whether an operation may happen at all; the
// host checks transport access (client, epoch, app incarnation, method class, session
// ownership) and has no way to grant an operation.
import net from 'node:net';
import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstatSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNEL_VERSION, DEFAULT_MAX_FRAME_BYTES, FrameReader, HANDSHAKE_MAX_BYTES, bare, deriveChannel, macEqual, opener, plainJson,
  randomToken, sealer, validToken } from './electron-channel.mjs';
import { classify, createJournal, privateDirectory, reconcile } from './electron-ownership.mjs';

const refuse = code => { throw Error(code); };
const SOCKET_NAME = 'host.sock';
// macOS limits a socket path to 104 bytes including the terminator.
const MAX_SOCKET_PATH = 100;

// Closed set of error codes a worker can see. Internal messages, paths and pipe text stay in the host.
export function errorFrame(error) {
  const text = String(error?.message ?? '');
  if (error?.cdp === true) return { code: 'CDP_ERROR', message: text.slice(0, 500), dispatched: true };
  const known = ['CDP_COMMAND_REFUSED', 'CDP_SESSION_NOT_OWNED', 'CDP_TARGET_NOT_OWNED', 'ELECTRON_BUSY', 'FENCE_REQUIRED', 'GRANT_NOT_CURRENT',
    'BUILD_NOT_REGISTERED', 'SESSION_INVALID', 'TICKET_BANK_FULL', 'TICKET_BOUND_INVALID'].find(code => text === code);
  if (known) return { code: known, dispatched: false };
  if (/^ownership unresolved/.test(text)) return { code: 'OWNERSHIP_UNRESOLVED', dispatched: false };
  if (/^retained ownership/.test(text)) return { code: 'OWNERSHIP_RETAINED', dispatched: false };
  if (/parked|not ready/i.test(text)) return { code: 'APP_PARKED', dispatched: error?.dispatched === true };
  if (/unauthenticated|detached/i.test(text)) return { code: 'UNAUTHENTICATED', dispatched: false };
  if (/queue full/i.test(text)) return { code: 'QUEUE_FULL', dispatched: false };
  if (error?.dispatched === true || /effect unknown/i.test(text)) return { code: 'EFFECT_UNKNOWN', dispatched: true };
  return { code: 'FAILED', dispatched: false };
}

/** Launches launch.py --adapter. Descriptors 3 and 4 are the app's pipe: the host keeps these
 * ends and the adapter passes the other ends to the app, then closes its own copies. */
export function createPythonAdapter({ python = 'python3', script, registryPath, tempRoot, spawn = spawnProcess, timeoutMs = 15000, maxReplyBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  if (typeof script !== 'string' || typeof registryPath !== 'string' || typeof tempRoot !== 'string') refuse('ADAPTER_CONFIG_REQUIRED');
  const events = new EventEmitter(), pending = new Map();
  const child = spawn(python, ['-I', '-B', script, '--adapter', '--registry', registryPath, '--temp-root', tempRoot], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONDONTWRITEBYTECODE: '1' },
  });
  let sequence = 0, lost = false;
  const reader = new FrameReader(maxReplyBytes);
  const lose = reason => {
    if (lost) return;
    lost = true;
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(Object.assign(Error('ADAPTER_LOST'), { reason })); }
    pending.clear(); events.emit('lost', reason);
  };
  child.stdout.on('data', chunk => {
    try {
      for (const frame of reader.push(chunk)) {
        const message = plainJson(frame);
        if (message.event === 'exit') { events.emit('exit', message.status); continue; }
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.ok === true) entry.resolve(message.result); else entry.reject(Error(String(message.error ?? 'ADAPTER_ERROR').slice(0, 300)));
      }
    } catch { lose('adapter sent an invalid frame'); try { child.kill?.('SIGTERM'); } catch { /* already gone */ } }
  });
  for (const stream of [child.stdin, child.stdout, child.stderr, child.stdio[3], child.stdio[4]]) stream?.on('error', () => {});
  child.stderr?.on('data', () => {}); // Drained, never forwarded: adapter text is not for workers.
  child.on('exit', () => lose('adapter exited'));
  child.on('error', () => lose('adapter failed to start'));
  return Object.freeze({
    events, child,
    streams: Object.freeze({ input: child.stdio[3], output: child.stdio[4] }),
    rpc(cmd, payload = {}) {
      if (lost) return Promise.reject(Error('ADAPTER_LOST'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('ADAPTER_TIMEOUT')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\0', error => {
          if (error) { pending.delete(id); clearTimeout(timer); reject(Error('ADAPTER_LOST')); }
        });
      });
    },
    get lost() { return lost; },
    close() { try { child.stdin.end(); } catch { /* already closed */ } },
  });
}

export async function createElectronHost({
  stateDir, Broker, createAdapter, builds = [], authorizeLaunch, requestQuit, resumeAuthority, admitTarget, authorizeIssue, prepareProfile, brokerOptions = {},
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, maxChannels = 64, maxUnauthenticated = 8, handshakeMs = 2000, maxPendingPerChannel = 64,
  maxBufferedBytes = 4 * 1024 * 1024, maxTicketTtlMs = 300000, maxTickets = 256, fenceLeaseMs = 30000, now = Date.now, adminSecret, uid = process.getuid?.(),
} = {}) {
  if (typeof Broker !== 'function' || typeof createAdapter !== 'function' || prepareProfile !== undefined && typeof prepareProfile !== 'function' ||
      typeof now !== 'function') refuse('HOST_DEPENDENCIES_REQUIRED');
  for (const value of [maxFrameBytes, maxChannels, maxUnauthenticated, handshakeMs, maxPendingPerChannel, maxBufferedBytes, maxTicketTtlMs, maxTickets, fenceLeaseMs]) {
    if (!Number.isSafeInteger(value) || value < 1) refuse('HOST_BOUND_INVALID');
  }
  privateDirectory(stateDir, uid);
  const socketPath = join(stateDir, SOCKET_NAME);
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) refuse('STATE_DIR_TOO_LONG');
  const hostId = randomToken(16);
  const journal = createJournal({ dir: stateDir, uid });
  // The admin secret comes from the trusted parent for this start only (in process, or an inherited
  // descriptor through electron-host-entry.mjs) and is never written: anything running as this user can
  // read the state directory, including the model's shell. Without it there is no admin channel.
  // A restarted host gets a new secret from its parent. Worker tickets never persist either.
  if (adminSecret !== undefined && (!Buffer.isBuffer(adminSecret) || adminSecret.length < 32)) refuse('ADMIN_SECRET_INVALID');
  const adminKey = adminSecret === undefined ? undefined : Buffer.from(adminSecret);
  // session -> { grant, revoked }: the debugger grant the parent bound to a session (bindGrant).
  const boundGrants = new Map();

  let adapter, broker, ownership = { state: 'free' }, closed = false;
  // An adapter process gets exactly one pair of pipe ends (its descriptors 3 and 4), so one launch.
  let adapterSpent = false, adapterHolds = false;
  const channels = new Set(), tickets = new Map();
  const events = new EventEmitter();
  // One session drives the app at a time: another session's ticket or channel is refused ELECTRON_BUSY while a worker
  // channel of a different session is open.
  const busyFor = session => [...channels].some(item => item.role === 'worker' && item.client && !item.dropped && item.session !== session);
  // The instance mutation fence: one worker channel may send Input.* at a time. It lapses fenceLeaseMs after the
  // holder's last send or verify (clock: now), and a dropped channel releases it.
  let fence = null;
  const fenceHolder = () => {
    if (fence && (fence.channel.dropped || now() - fence.touched >= fenceLeaseMs)) fence = null;
    return fence?.channel;
  };
  const touchFence = channel => { if (fenceHolder() === channel) fence.touched = now(); };

  // --- Ownership -----------------------------------------------------------------------------
  async function inspectLocks() {
    const locks = [];
    for (const build of builds) {
      try { locks.push({ build, state: await adapter.rpc('lockstate', { build }) }); }
      catch { locks.push({ build, state: { exists: true, unreadable: true } }); }
    }
    return locks;
  }
  adapter = await createAdapter();
  const first = journal.read();
  const found = classify({ journal: first, locks: await inspectLocks() });
  ownership = found.state === 'free' ? { state: 'free' } : { ...found, journal: first };
  let record;

  function watchAdapter(current) {
    current.events.on('lost', () => {
      if (adapter !== current || closed) return;
      // The app and its pipe are fine, but nothing can now collect them. Stop commands; a person
      // quits the app and reconciles.
      if (broker && broker.state !== 'collected') broker.park('adapter lost');
      if (ownership.state === 'owned') ownership = { ...ownership, state: 'unresolved', reason: 'adapter-lost', possibleAppExit: false };
    });
  }
  watchAdapter(adapter);

  const write = fields => { record = { ...record, ...fields, hostId, hostPid: process.pid, at: Date.now() }; journal.write(record); };

  function brokerParts() {
    const ownershipHooks = {
      async reserve({ spec }) {
        // A user-profile launch (the relaunch flow) opens the app on its own profile: the adapter's root is only sleight's
        // launch record, and nothing fills or reads the profile.
        const user = spec.profile === 'user';
        const reserved = await adapter.rpc('reserve', { build: spec.build, ...(user ? { mode: 'user' } : {}) });
        adapterHolds = true;
        record = { state: 'reserved', build: spec.build, nonce: reserved.nonce, root: reserved.root, lock: reserved.lock, observed: [], ...(user ? { mode: 'user' } : {}) };
        write({});
        // The caller fills the reserved temporary profile (a workspace to open) before anything runs in it. A failure here
        // leaves the reservation held, so ownership is unresolved until reconcile() collects it.
        if (prepareProfile && !user) await prepareProfile(reserved.root, structuredClone(spec));
        return reserved;
      },
      async record(_owned, identity) { write({ state: 'running', pid: identity.pid, birth: identity.birth }); },
      async observe(_owned, fresh) {
        const merged = [...(record.observed ?? []), ...fresh.map(item => [item.pid, item.birth])];
        if (merged.length > 512) refuse('OBSERVED_BANK_FULL');
        write({ observed: merged });
      },
      async remove() {
        const result = await adapter.rpc('collect');
        if (result?.cleanup !== 'removed') refuse(result?.reason ? 'cleanup retained: ' + result.reason : 'cleanup retained');
        journal.write({ state: 'none', hostId, hostPid: process.pid, at: Date.now() });
        ownership = { state: 'free' };
      },
    };
    const launch = async () => {
      adapterSpent = true;
      const spawned = await adapter.rpc('spawn');
      return {
        identity: { pid: spawned.pid, birth: spawned.birth },
        input: adapter.streams.input, output: adapter.streams.output, events: adapter.events,
        inspect: () => adapter.rpc('inspect'),
        confirmAbsent: async identities => (await adapter.rpc('confirmAbsent', { identities: identities.map(item => [item.pid, item.birth]) })).absent === true,
        // The parent quits through the app's own Quit. The birth is checked again right before, so a recycled PID is never asked.
        requestQuit: async identity => {
          if (typeof requestQuit !== 'function') refuse('QUIT_UNAVAILABLE');
          const observed = await broker.inspect();
          if (observed.parent?.pid !== identity.pid || observed.parent?.birth !== identity.birth) refuse('QUIT_IDENTITY_CHANGED');
          await requestQuit(Object.freeze({ pid: identity.pid, birth: identity.birth }));
        },
      };
    };
    return { ownership: ownershipHooks, launch };
  }

  async function start(spec) {
    if (closed) refuse('HOST_CLOSED');
    if (ownership.state === 'unresolved') refuse('ownership unresolved: ' + ownership.reason);
    if (ownership.state !== 'free' || broker && !['collected', 'new'].includes(broker.state)) refuse('retained ownership prevents another launch');
    if (adapterSpent || adapter.lost) {
      adapter.close?.();
      adapter = await createAdapter(); watchAdapter(adapter); adapterSpent = false; adapterHolds = false;
    }
    ownership = { state: 'owned' };
    const parts = brokerParts();
    broker = new Broker({ ...parts, authorizeLaunch, admitTarget, ...brokerOptions });
    broker.on('routed', route);
    broker.on('parked', info => {
      for (const channel of [...channels]) if (channel.role === 'worker') channel.send({ op: 'parked', reason: info.reason, resumable: info.resumable, epoch: info.epoch }, true);
      events.emit('parked', info);
    });
    try {
      return await broker.start(spec);
    } catch (error) {
      // reserve/spawn may have happened: ownership stays held until reconciled or collected.
      if (broker.state === 'new') ownership = { state: 'free' };
      else ownership = { state: 'unresolved', reason: 'launch-uncertain', possibleAppExit: false, record };
      throw error;
    }
  }

  const quit = consent => broker ? broker.quit(consent) : Promise.reject(Error('no app connection'));
  const collect = () => broker ? broker.collect() : Promise.reject(Error('no app connection'));

  // --- Channels ------------------------------------------------------------------------------
  function route(client, frame) {
    for (const channel of channels) {
      if (channel.role !== 'worker' || !channel.open) continue;
      if (client === undefined || channel.client === client) channel.send({ op: 'event', frame });
    }
  }

  const server = net.createServer({ allowHalfOpen: false });
  server.maxConnections = maxChannels + maxUnauthenticated;

  function handle(socket) {
    if (closed || channels.size >= maxChannels + maxUnauthenticated) { socket.destroy(); return; }
    const channel = { socket, role: undefined, client: undefined, open: false, pending: new Map(), sealed: false };
    let unauthenticated = [...channels].filter(item => !item.open).length;
    if (unauthenticated >= maxUnauthenticated) { socket.destroy(); return; }
    channels.add(channel);
    socket.on('error', () => {});
    const reader = new FrameReader(HANDSHAKE_MAX_BYTES);
    const hostNonce = randomToken();
    let seal, openFrame, ticket, derived;
    const drop = () => {
      if (channel.dropped) return; channel.dropped = true;
      clearTimeout(timer); channels.delete(channel);
      if (fence?.channel === channel) fence = null;
      for (const [, controller] of channel.pending) controller.abort();
      channel.pending.clear();
      if (channel.client) broker?.detach(channel.client);
      socket.destroy();
    };
    const timer = setTimeout(drop, handshakeMs);
    channel.send = (payload, last = false) => {
      if (channel.dropped) return;
      if (!channel.sealed) return;
      try { socket.write(seal(payload)); } catch { drop(); return; }
      if (socket.writableLength > maxBufferedBytes) drop(); // a reader that never drains is dropped, not buffered
      else if (last) socket.end();
    };
    socket.write(bare({ t: 'hello', v: CHANNEL_VERSION, host: hostId, nonce: hostNonce }));
    socket.on('close', drop);
    socket.on('data', chunk => {
      let frames;
      try { frames = reader.push(chunk); } catch { drop(); return; }
      for (const frame of frames) {
        try {
          if (!channel.sealed) authenticate(frame); else dispatch(openFrame(frame));
        } catch { drop(); return; }
        if (channel.dropped) return;
      }
    });

    function authenticate(frame) {
      const hello = plainJson(frame);
      const keys = Object.keys(hello).sort().join();
      if (keys !== 'cn,proof,role,t,ticket' || hello.t !== 'auth' || !validToken(hello.cn) || !validToken(hello.proof) ||
          (hello.role !== 'admin' && hello.role !== 'worker')) refuse('CHANNEL_AUTH_FAILED');
      let secret;
      if (hello.role === 'admin') {
        if (hello.ticket !== 'admin' || !adminKey) refuse('CHANNEL_AUTH_FAILED');
        if ([...channels].some(item => item.role === 'admin')) refuse('CHANNEL_AUTH_FAILED'); // one administrator at a time
        secret = adminKey;
      } else {
        if (!validToken(hello.ticket)) refuse('CHANNEL_AUTH_FAILED');
        ticket = tickets.get(hello.ticket);
        if (!ticket || ticket.expires <= Date.now() || ticket.uses >= ticket.maxUses || ticket.failures >= 5) refuse('CHANNEL_AUTH_FAILED');
        secret = ticket.secret;
      }
      derived = deriveChannel(secret, { host: hostId, hostNonce, clientNonce: hello.cn, ticket: hello.ticket, role: hello.role });
      if (!macEqual(hello.proof, derived.clientProof)) { if (ticket) ticket.failures++; refuse('CHANNEL_AUTH_FAILED'); }
      if (ticket) ticket.uses++;
      clearTimeout(timer);
      channel.role = hello.role; channel.session = ticket?.session;
      openFrame = opener(derived.clientKey); seal = sealer(derived.hostKey);
      reader.max = maxFrameBytes;
      socket.write(bare({ t: 'ready', proof: derived.hostProof }));
      channel.sealed = true;
      if (channel.role === 'worker') {
        if (!broker || broker.state !== 'ready') { channel.open = true; channel.send({ op: 'refused', code: 'APP_PARKED', state: broker?.state ?? 'none' }, true); return; }
        // A ticket issued before another session connected cannot open beside it.
        if (busyFor(channel.session)) { channel.open = true; channel.send({ op: 'refused', code: 'ELECTRON_BUSY', state: broker.state }, true); return; }
        channel.client = broker.connect(channel.session);
        channel.open = true;
        channel.send({ op: 'open', epoch: broker.epoch, incarnation: broker.identity, instance: broker.instance });
      } else { channel.open = true; channel.send({ op: 'open', admin: true }); }
    }

    function dispatch(message) {
      if (typeof message.op !== 'string') refuse('CHANNEL_FRAME_INVALID');
      if (channel.role === 'admin') { admin(channel, message); return; }
      if (!channel.client || channel.dropped) refuse('CHANNEL_FRAME_INVALID');
      if (message.op === 'bye') { drop(); return; }
      if (message.op === 'cancel') { channel.pending.get(message.id)?.abort(); return; }
      if (!Number.isSafeInteger(message.id) || message.id < 1 || channel.pending.has(message.id)) refuse('CHANNEL_FRAME_INVALID');
      if (channel.pending.size >= maxPendingPerChannel) { channel.send({ op: 'reply', id: message.id, error: { code: 'QUEUE_FULL', dispatched: false } }); return; }
      const controller = new AbortController();
      channel.pending.set(message.id, controller);
      const finish = (error, result) => {
        channel.pending.delete(message.id);
        channel.send(error ? { op: 'reply', id: message.id, error: errorFrame(error) } : { op: 'reply', id: message.id, result });
      };
      if (message.op === 'send') {
        if (Object.keys(message).some(key => !['op', 'id', 'method', 'params', 'sessionId'].includes(key))) refuse('CHANNEL_FRAME_INVALID');
        // Input reaches the app only from the fence holder. The worker's registry fence is the first check, this is the one
        // another session's worker cannot skip.
        if (typeof message.method === 'string' && message.method.startsWith('Input.') && fenceHolder() !== channel) { finish(Error('FENCE_REQUIRED')); return; }
        touchFence(channel);
        broker.transportSend(channel.client, { method: message.method, params: message.params ?? {}, sessionId: message.sessionId }, { signal: controller.signal })
          .then(result => finish(undefined, result ?? {}), error => finish(error));
      } else if (message.op === 'fence') {
        if (Object.keys(message).sort().join() !== 'action,id,op' || !['acquire', 'release'].includes(message.action)) refuse('CHANNEL_FRAME_INVALID');
        const holder = fenceHolder();
        if (message.action === 'acquire' && (!holder || holder === channel)) fence = { channel, touched: now() };
        if (message.action === 'release' && holder === channel) fence = null;
        finish(undefined, { held: fenceHolder() === channel, holder: fenceHolder()?.session ?? null, leaseMs: fenceLeaseMs });
      } else if (message.op === 'verify') {
        touchFence(channel);
        broker.fresh().then(() => finish(undefined, { ok: broker.state === 'ready' && broker.epoch === channel.client.epoch && broker.clients.has(channel.client),
          epoch: broker.epoch, instance: broker.instance }), () => finish(undefined, { ok: false, epoch: broker.epoch, instance: broker.instance }));
      } else refuse('CHANNEL_FRAME_INVALID');
    }
  }
  server.on('connection', handle);

  // --- Administration ------------------------------------------------------------------------
  // Every ticket asks the parent whether the session's debugger grant is current, and a grant bound
  // with bindGrant must not be revoked. Holding the admin channel alone grants nothing.
  async function issueTicket({ session, ttlMs = 30000, maxUses = 1 } = {}) {
    if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) refuse('SESSION_INVALID');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > maxTicketTtlMs || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 8) refuse('TICKET_BOUND_INVALID');
    const bound = boundGrants.get(session);
    let current = false;
    try { current = typeof authorizeIssue === 'function' && await authorizeIssue(Object.freeze({ session })) === true; } catch { current = false; }
    try { if (bound && (bound.revoked || bound.grant.current() !== true)) current = false; } catch { current = false; }
    if (!current || closed) refuse('GRANT_NOT_CURRENT');
    if (busyFor(session)) refuse('ELECTRON_BUSY');
    for (const [id, item] of tickets) if (item.expires <= Date.now()) tickets.delete(id);
    if (tickets.size >= maxTickets) refuse('TICKET_BANK_FULL');
    const id = randomToken(), secret = Buffer.from(randomToken(32), 'base64url');
    tickets.set(id, { session, secret, expires: Date.now() + ttlMs, uses: 0, maxUses, failures: 0 });
    return Object.freeze({ socket: socketPath, host: hostId, ticket: id, secret: secret.toString('base64url'), session, expiresAt: Date.now() + ttlMs });
  }
  // A broker that is ready, resuming or already parked takes the revoke: one that lands during a resume
  // ends that resume (it sees the new epoch) instead of being lost.
  const revocable = () => broker && !['new', 'collected', 'authorizing', 'launching', 'retained'].includes(broker.state);
  function revokeSession(session, reason = 'revoked') {
    for (const [id, item] of tickets) if (item.session === session) tickets.delete(id);
    for (const channel of [...channels]) if (channel.session === session) channel.send({ op: 'parked', reason, resumable: true, epoch: broker?.epoch }, true);
    // Revocation stops every command and parks the connection; it never closes the app's pipe.
    if (revocable()) broker.revoke(reason);
  }
  function revokeAll(reason = 'revoked') {
    tickets.clear();
    if (revocable()) broker.revoke(reason);
  }
  // The parent binds a session's debugger grant (electron-consent.mjs). Its revocation (turn end for a once
  // grant, session or app revoke, a removed Always record) revokes the session here at once.
  function bindGrant(session, grant) {
    if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) refuse('SESSION_INVALID');
    if (typeof grant?.current !== 'function' || typeof grant?.onRevoke !== 'function') refuse('GRANT_INVALID');
    const entry = { grant, revoked: false };
    boundGrants.set(session, entry);
    grant.onRevoke(info => {
      entry.revoked = true;
      if (boundGrants.get(session) === entry) revokeSession(session, 'debugger grant revoked: ' + String(info?.reason ?? 'revoked').slice(0, 64));
    });
  }
  async function resume() {
    if (!broker) refuse('no app connection');
    return broker.resume(resumeAuthority ?? (async () => false));
  }
  async function reconcileOwnership({ acceptDiskEvidence = false } = {}) {
    if (ownership.state !== 'unresolved') return { resolved: ownership.state === 'free', reason: 'nothing-unresolved' };
    // Recovery speaks to a fresh adapter: the previous one (if any) belonged to the lost host.
    if (adapter.lost) { adapter = await createAdapter(); watchAdapter(adapter); adapterSpent = false; adapterHolds = false; }
    const locks = await inspectLocks();
    const current = classify({ journal: journal.read(), locks });
    if (current.state === 'free') { ownership = { state: 'free' }; return { resolved: true }; }
    const outcome = await reconcile({ unresolved: current, adapter, acceptDiskEvidence, holds: adapterHolds });
    if (outcome.resolved) {
      journal.write({ state: 'none', hostId, hostPid: process.pid, at: Date.now() });
      ownership = { state: 'free' };
    } else ownership = { ...ownership, ...current, lastAttempt: outcome.reason };
    return outcome;
  }
  function status() {
    return Object.freeze({ hostId, socket: socketPath, closed, channels: channels.size, tickets: tickets.size,
      ownership: { state: ownership.state, reason: ownership.reason, possibleAppExit: ownership.possibleAppExit === true, lastAttempt: ownership.lastAttempt },
      // The sessions whose worker channel is open (busyFor's view), so the parent refuses another session before its card.
      workers: [...new Set([...channels].filter(item => item.role === 'worker' && item.client && !item.dropped).map(item => item.session))],
      broker: broker?.status() });
  }
  function admin(channel, message) {
    if (!Number.isSafeInteger(message.id) || message.id < 1) refuse('CHANNEL_FRAME_INVALID');
    const reply = (value, error) => channel.send({ op: 'reply', id: message.id, ...(error ? { error: errorFrame(error) } : { result: value }) });
    const run = async () => {
      if (message.op === 'issue') return issueTicket(message.args);
      if (message.op === 'revoke') { revokeSession(String(message.args?.session)); return {}; }
      if (message.op === 'revokeAll') { revokeAll(); return {}; }
      if (message.op === 'status') return JSON.parse(JSON.stringify(status()));
      if (message.op === 'resume') return resume();
      if (message.op === 'reconcile') return reconcileOwnership({ acceptDiskEvidence: message.args?.acceptDiskEvidence === true });
      // A start names a reviewed build from the registry the host was given, and profile 'user' for the user's own profile
      // (the relaunch flow); nothing else reaches the launch spec.
      if (message.op === 'start') {
        const build = message.args?.build, keys = Object.keys(message.args ?? {}).sort().join();
        const user = keys === 'build,profile' && message.args.profile === 'user';
        if (typeof build !== 'string' || !builds.includes(build) || keys !== 'build' && !user) refuse('BUILD_NOT_REGISTERED');
        return JSON.parse(JSON.stringify(await start(user ? { build, profile: 'user' } : { build })));
      }
      // The parent sends quit only on the user's click; the app's own Quit runs, with its unsaved-work prompts.
      if (message.op === 'quit') return JSON.parse(JSON.stringify(await quit(async () => true)));
      if (message.op === 'collect') return JSON.parse(JSON.stringify(await collect()));
      refuse('CHANNEL_FRAME_INVALID');
    };
    run().then(value => reply(value), error => reply(undefined, error));
  }

  // --- Lifecycle -----------------------------------------------------------------------------
  // A previous host's socket is stale only if nothing answers on it.
  async function claimSocketPath() {
    let existing;
    try { existing = lstatSync(socketPath); } catch { return; }
    if (!existing.isSocket()) refuse('STATE_DIR_UNSAFE');
    const alive = await new Promise(resolve => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (alive) refuse('HOST_ALREADY_RUNNING');
    unlinkSync(socketPath);
  }
  await claimSocketPath();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);

  async function close() {
    if (closed) return;
    // Closing the host closes the app's pipe, and Electron quits on pipe EOF. Refuse while an app is owned.
    if (broker && broker.state !== 'collected' && ownership.state === 'owned') refuse('app owned: quit it first');
    closed = true;
    for (const channel of [...channels]) channel.socket.destroy();
    await new Promise(resolve => server.close(resolve));
    try { unlinkSync(socketPath); } catch { /* already gone */ }
    adapter.close?.();
  }
  // Test hook: the host process vanishes. No journal write, no collection, pipes simply dropped.
  function _crashForTest() {
    closed = true;
    for (const channel of [...channels]) channel.socket.destroy();
    server.close();
    try { unlinkSync(socketPath); } catch { /* already gone */ }
    // A dead process closes every descriptor it held, including the app's pipe ends.
    adapter.streams?.input?.destroy(); adapter.streams?.output?.destroy();
    adapter.close?.();
  }

  return Object.freeze({
    hostId, socketPath, start, status, issueTicket, bindGrant, revokeSession, revokeAll, resume, reconcile: reconcileOwnership, close, _crashForTest,
    quit, collect,
    get broker() { return broker; }, events,
  });
}
