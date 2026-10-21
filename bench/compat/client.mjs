// A small stdio MCP client for the compatibility suite: the raw engine server, or sleight's launcher.
// Approvals go to `approve`; anything else the server asks gets "Method not found". Closing ends stdin first, which
// makes the launcher end its turn and stop its engine child, then signals only this client's own process group.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

// A detached child's group is still ours after its leader exits. ESRCH is the
// collection proof; EPERM and other inspection failures leave it uncertain.
function groupCollected(pid) {
  if (!pid) return true;
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH' ? true : undefined; }
}

// After child close, transient EPERM is uncertainty, not collection or evidence
// of a live group. Retry only the read probe, at most four times for unknowns.
export async function exitedGroupCollected(pid, { probe = groupCollected, wait = sleep, stopped = () => false } = {}) {
  let unknown = 0;
  while (!stopped()) {
    const state = probe(pid);
    if (state === true) return true;
    if (state !== false) {
      if (unknown++ === 4) return false;
      await wait(50);
    } else await wait(20);
  }
  return false;
}

// Process groups of clients still open. If this process exits without closing one (a crash, process.exit), the exit
// handler kills the group, so no engine or launcher outlives the check.
const groups = new Set();
let exitHook = false;
function track(pid) {
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => { for (const group of groups) { try { process.kill(-group, 'SIGKILL'); } catch {} } });
  }
  groups.add(pid);
}

export const textOf = result => (result?.content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string')
  .map(item => item.text).join('\n');

export async function openClient({ command, args = [], env = process.env, approve = () => ({ action: 'decline' }),
  timeoutMs = 60000, startupTimeoutMs = 20000, turnMeta = false, name = 'sleight-compat', graceMs = 4000, forceMs = 8000,
  onLifecycle = () => {}, capabilities = { elicitation: { form: {} } }, onNotification = () => {},
  requireGroupCollection = false } = {}) {
  // detached: the engine and its helpers share one group, so cleanup can't miss a grandchild.
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, detached: true });
  if (child.pid) track(child.pid);
  const sessionId = randomUUID();
  let turnId = randomUUID();
  let stderr = '', nextId = 0, ended = false, closing, cleanupReceipt;
  const pending = new Map();
  const observe = record => { try { onLifecycle(record); } catch { /* Observation cannot change transport behavior. */ } };
  const stopped = new Promise(resolve => child.once('close', (code, signal) => {
    ended = true;
    if (!requireGroupCollection) groups.delete(child.pid);
    observe({ event: 'close', pid: child.pid, code, signal });
    resolve();
  }));
  const failAll = error => { for (const reply of pending.values()) reply.reject(error); pending.clear(); };
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.once('error', failAll);
  child.stdin.on('error', failAll);
  child.once('exit', (code, signal) => failAll(new Error(`${command.split('/').at(-1)} exited (${signal ?? code})${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''}`)));
  observe({ event: 'spawn', pid: child.pid });
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const request = (method, params, ms = timeoutMs) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${ms} ms`)); }, ms);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    send({ id, method, params });
  });
  const input = createInterface({ input: child.stdout });
  input.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { failAll(new Error('the server wrote a line that is not JSON')); return; }
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'elicitation/create') {
        Promise.resolve().then(() => approve(msg.params ?? {})).catch(() => ({ action: 'decline' }))
          .then(answer => send({ id: msg.id, result: answer }));
      } else send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
    } else if (msg.method && msg.id === undefined) {
      // An observer may request EOF on this exact owned child, including during initialize.
      try { if (onNotification(msg) === 'close') void client.close().catch(() => {}); }
      catch (error) { failAll(error); void client.close().catch(() => {}); }
    } else if (!msg.method && pending.has(msg.id)) {
      const reply = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reply.reject(new Error(msg.error.message || 'MCP request failed')) : reply.resolve(msg.result);
    }
  });
  const meta = () => (turnMeta ? { _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: sessionId, turn_id: turnId }) } } : {});
  const client = {
    pid: child.pid,
    cleanupReceipt: () => cleanupReceipt && { ...cleanupReceipt },
    stderr: () => stderr,
    listTools: async () => (await request('tools/list', {}))?.tools,
    call: (tool, args, ms) => request('tools/call', { name: tool, arguments: args, ...meta() }, ms),
    // The raw engine's turn end, with the arguments the relay sends (relay.mjs endTurnArgs).
    endTurn: async () => {
      const answer = await request('tools/call', { name: 'turn_ended', arguments: { hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId }, ...meta() });
      turnId = randomUUID();
      return answer;
    },
    close: () => closing ??= (async () => {
      if (!ended) child.stdin.end();
      const signal = name => {
        if ((!ended || requireGroupCollection && groupCollected(child.pid) === false) && child.pid) {
          try { process.kill(-child.pid, name); } catch {}
        }
      };
      const gentle = setTimeout(() => signal('SIGTERM'), graceMs);
      const force = setTimeout(() => signal('SIGKILL'), forceMs);
      let deadline, stopWaiting = false, strictGroupCollected = false;
      const collected = await Promise.race([(async () => {
        await stopped;
        if (!requireGroupCollection) return true;
        strictGroupCollected = await exitedGroupCollected(child.pid, { stopped: () => stopWaiting });
        return strictGroupCollected;
      })(), new Promise(resolve => { deadline = setTimeout(() => resolve(false), forceMs + 2000); })]);
      clearTimeout(gentle); clearTimeout(force); clearTimeout(deadline);
      stopWaiting = true;
      input.close();
      failAll(new Error('client closed'));
      cleanupReceipt = { started: !!child.pid, childPid: child.pid ?? null, groupId: child.pid ?? null,
        childCollected: ended, groupCollected: requireGroupCollection ? strictGroupCollected : groupCollected(child.pid) === true };
      if (cleanupReceipt.childCollected && cleanupReceipt.groupCollected) groups.delete(child.pid);
      return collected && (!requireGroupCollection || cleanupReceipt.groupCollected);
    })(),
  };
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities,
      clientInfo: { name, version: '1' } }, startupTimeoutMs);
    send({ method: 'notifications/initialized' });
    return client;
  } catch (error) {
    await client.close();
    error.cleanupReceipt = client.cleanupReceipt();
    throw error;
  }
}
