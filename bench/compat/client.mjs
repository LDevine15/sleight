// A small stdio MCP client for the compatibility suite: the raw engine server, or sleight's launcher.
// Approvals go to `approve`; anything else the server asks gets "Method not found". Closing ends stdin first, which
// makes the launcher end its turn and stop its engine child, then signals only this client's own process group.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export const textOf = result => (result?.content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string')
  .map(item => item.text).join('\n');

export async function openClient({ command, args = [], env = process.env, approve = () => ({ action: 'decline' }),
  timeoutMs = 60000, startupTimeoutMs = 20000, turnMeta = false, name = 'sleight-compat', graceMs = 4000, forceMs = 8000 } = {}) {
  // detached: the engine and its helpers share one group, so cleanup can't miss a grandchild.
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env, detached: true });
  const sessionId = randomUUID();
  let turnId = randomUUID();
  let stderr = '', nextId = 0, ended = false;
  const pending = new Map();
  const stopped = new Promise(resolve => child.once('close', () => { ended = true; resolve(); }));
  const failAll = error => { for (const reply of pending.values()) reply.reject(error); pending.clear(); };
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  child.once('error', failAll);
  child.stdin.on('error', failAll);
  child.once('exit', (code, signal) => failAll(new Error(`${command.split('/').at(-1)} exited (${signal ?? code})${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ''}`)));
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
    } else if (!msg.method && pending.has(msg.id)) {
      const reply = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reply.reject(new Error(msg.error.message || 'MCP request failed')) : reply.resolve(msg.result);
    }
  });
  const meta = () => (turnMeta ? { _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: sessionId, turn_id: turnId }) } } : {});
  const client = {
    pid: child.pid,
    stderr: () => stderr,
    listTools: async () => (await request('tools/list', {}))?.tools,
    call: (tool, args, ms) => request('tools/call', { name: tool, arguments: args, ...meta() }, ms),
    // The raw engine's turn end, with the arguments the relay sends (relay.mjs endTurnArgs).
    endTurn: async () => {
      const answer = await request('tools/call', { name: 'turn_ended', arguments: { hook_event_name: 'Stop', session_id: sessionId, turn_id: turnId }, ...meta() });
      turnId = randomUUID();
      return answer;
    },
    close: async () => {
      if (!ended) child.stdin.end();
      const signal = name => { if (!ended && child.pid) { try { process.kill(-child.pid, name); } catch {} } };
      const gentle = setTimeout(() => signal('SIGTERM'), graceMs);
      const force = setTimeout(() => signal('SIGKILL'), forceMs);
      let deadline;
      const collected = await Promise.race([stopped.then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), forceMs + 2000); })]);
      clearTimeout(gentle); clearTimeout(force); clearTimeout(deadline);
      input.close();
      failAll(new Error('client closed'));
      return collected;
    },
  };
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } },
      clientInfo: { name, version: '1' } }, startupTimeoutMs);
    send({ method: 'notifications/initialized' });
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
