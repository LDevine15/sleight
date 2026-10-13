// Read-only discovery through the installed engine, not browser profile files.
// Own and collect the short-lived engine; no browser actions or accepted prompts.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sourceOf } from './browser-recovery.mjs';

async function selectedBrowser(cua, choice, scope, query) {
  if (!query || Object.keys(query).length !== 1 || query.extensionInstanceId !== choice.extensionInstanceId) {
    return cua.getBrowser(query);
  }
  const key = JSON.stringify([choice, scope]);
  const cached = globalThis.__sleightSelectedBrowser;
  delete globalThis.__sleightSelectedBrowser;
  const rows = (await cua.listBrowsers({ emit: false })).filter(row => row.type === 'extension' &&
    row.metadata?.extensionInstanceId === choice.extensionInstanceId && (!choice.profileName || row.profileName === choice.profileName));
  if (rows.length !== 1) throw new Error('The selected browser identity changed. Acquire the intended profile explicitly.');
  if (cached?.key === key) {
    if (cached.browser.browserId !== rows[0].id) throw new Error('The selected browser identity changed. Acquire the intended profile explicitly.');
    globalThis.__sleightSelectedBrowser = cached;
    return cached.browser;
  }
  const browser = await cua.getBrowser({ id: rows[0].id });
  const after = (await cua.listBrowsers({ emit: false })).filter(row => row.type === 'extension' &&
    row.metadata?.extensionInstanceId === choice.extensionInstanceId && (!choice.profileName || row.profileName === choice.profileName));
  if (browser.browserId !== rows[0].id || after.length !== 1 || after[0].id !== browser.browserId) {
    throw new Error('The selected browser identity changed during acquisition.');
  }
  globalThis.__sleightSelectedBrowser = { key, browser };
  return browser;
}

export function selectedBrowserCode(code, choice, scope) {
  if (!choice) return code;
  const source = sourceOf(code);
  if (!source) return code;
  const matches = [...source.matchAll(/(?<![\w$.])cua\s*\.\s*getBrowser(?=\s*\()/g)];
  if (!matches.length) return code;
  for (const match of matches.reverse()) code = code.slice(0, match.index) + 'sleight.selectedBrowser' + code.slice(match.index + match[0].length);
  return `globalThis.sleight ??= {}; sleight.selectedBrowser = query => (${selectedBrowser.toString()})(cua, ${JSON.stringify(choice)}, ${JSON.stringify(scope)}, query);\n` + code;
}

// A socket hint is never an identity proof. Verify its metadata through the engine before
// narrowing this launch, and retain only its inode and the caller's explicit profile choice.
export function createBrowserSelection({ selection = process.env.SLEIGHT_BROWSER_SELECTION,
  candidates = () => readdirSync('/tmp/codex-browser-use').map(name => join('/tmp/codex-browser-use', name)),
  stat = lstatSync, discover = discoverExtensions } = {}) {
  if (typeof selection === 'string') {
    try { selection = JSON.parse(selection); } catch { selection = undefined; }
  }
  const valid = selection && typeof selection.extensionInstanceId === 'string' && selection.extensionInstanceId.length > 0 &&
    selection.extensionInstanceId.length <= 128 && (selection.profileName === undefined ||
      (typeof selection.profileName === 'string' && selection.profileName.length > 0 && selection.profileName.length <= 256));
  let verified, hint = valid ? selection.backendPath : undefined;
  const socket = path => {
    if (typeof path !== 'string' || !/^\/tmp\/codex-browser-use\/[a-zA-Z0-9-]+\.sock$/.test(path)) return;
    const value = stat(path);
    if (!value.isSocket() || (process.getuid && value.uid !== process.getuid())) return;
    return { path, dev: value.dev, ino: value.ino };
  };
  const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino;
  return {
    get choice() { return valid ? { extensionInstanceId: selection.extensionInstanceId,
      ...(selection.profileName ? { profileName: selection.profileName } : {}) } : undefined; },
    changed() {
      if (!verified) return false;
      try { return !same(verified, socket(verified.path)); }
      catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; }
    },
    async prepare(server) {
      verified = undefined;
      if (!valid || server.env?.BROWSER_USE_BACKEND_PATHS !== undefined) return server;
      const check = async path => {
        try {
          const before = socket(path);
          if (!before) return;
          const scoped = { ...server, env: { ...server.env, BROWSER_USE_BACKEND_PATHS: path } };
          const rows = await discover(scoped, { strict: true });
          if (rows.length !== 1 || rows[0].type !== 'extension' ||
            rows[0].metadata?.extensionInstanceId !== selection.extensionInstanceId ||
            (selection.profileName && rows[0].profileName !== selection.profileName) ||
            !same(before, socket(path))) return;
          return before;
        } catch { /* Failed identity checks keep ordinary discovery available. */ }
      };
      if (hint) verified = await check(hint);
      if (!verified) {
        let paths;
        try { paths = [...new Set(await candidates())].filter(path => path !== hint).slice(0, 64); }
        catch { paths = []; }
        const found = [];
        for (let i = 0; i < paths.length; i += 4) {
          const matches = (await Promise.all(paths.slice(i, i + 4).map(check))).filter(Boolean);
          found.push(...matches);
          if (found.length > 1) return server;
        }
        verified = found[0];
      }
      if (!verified) { hint = undefined; return server; }
      hint = verified.path;
      return { ...server, env: { ...server.env, BROWSER_USE_BACKEND_PATHS: verified.path } };
    },
  };
}

export async function discoverExtensions(server, { timeoutMs = 4000, signal, strict = false } = {}) {
  if (signal?.aborted) { if (strict) throw new Error('Browser discovery cancelled'); return []; }
  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, ...server.env, CUA_REPL_ENABLED_SURFACES: 'browser', BROWSER_USE_AVAILABLE_BACKENDS: 'chrome' } });
  const stopped = new Promise(resolve => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  const marker = 'sleight-browser-discovery:';
  let finish, timer;
  const fail = reason => finish(strict ? new Error(`Browser discovery ${reason}`) : []);
  const answer = new Promise(resolve => { finish = resolve; timer = setTimeout(() => fail('timed out'), timeoutMs); });
  const abort = () => fail('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  const send = msg => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
  child.on('error', () => fail('engine failed to start'));
  child.stdin.on('error', () => fail('engine input failed'));
  child.once('close', () => fail('engine closed without an inventory'));
  lines.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      send({ id: msg.id, ...(msg.method === 'elicitation/create' ? { result: { action: 'decline' } } : { error: { code: -32601, message: 'Method not found' } }) });
    } else if (msg.id === 1) {
      if (msg.error) return fail('initialization failed');
      send({ method: 'notifications/initialized' });
      send({ id: 2, method: 'tools/call', params: { name: 'js', arguments: {
        code: `nodeRepl.write(${JSON.stringify(marker)} + JSON.stringify(await cua.listBrowsers({emit: false})))`,
      }, _meta: { 'x-codex-turn-metadata': JSON.stringify({ session_id: randomUUID(), turn_id: randomUUID() }) } } });
    } else if (msg.id === 2) {
      if (msg.error || msg.result?.isError || !Array.isArray(msg.result?.content)) return fail('inventory call failed');
      for (const block of msg.result.content) {
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        const at = block.text.lastIndexOf(marker);
        if (at < 0) continue;
        try {
          const result = JSON.parse(block.text.slice(at + marker.length).trim());
          return Array.isArray(result) ? finish(result.filter(b => b?.type === 'extension' && b.metadata?.extensionInstanceId)) : fail('returned a malformed inventory');
        } catch { /* Failed or changed output: keep the surface off. */ }
      }
      fail('returned no inventory');
    }
  });
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sleight-browser-discovery', version: '1' } } });
  try { const result = await answer; if (result instanceof Error) throw result; return result; }
  finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(timer); child.stdin.end();
    // cua-repl propagates these signals to its owned node_repl child.
    const gentle = setTimeout(() => child.kill('SIGTERM'), 500);
    const force = setTimeout(() => child.kill('SIGKILL'), 2500);
    await stopped; clearTimeout(gentle); clearTimeout(force); lines.close();
  }
}
