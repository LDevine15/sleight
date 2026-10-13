// Reuses the banked AA1-2 full-relay fixture (43c3652e); extended for NP-4 plans.
// Offline full-relay fixture qualification. This module never connects to an engine.
import { PassThrough } from 'node:stream';
import { createContext, runInContext, constants } from 'node:vm';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../../../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../../../plugins/sleight/lib/input-lease.mjs';
import { trackTemp, removeTemp } from '../../../scripts/temp-leftovers.mjs';

const appId = 'org.sleight.qualification-fixture', appName = 'Qualification Fixture';
const tick = () => new Promise(resolve => setImmediate(resolve));
export async function relayTrial(combined, { mode = 'default', fault, advance = () => {}, readDelay = 0, age = 0, split = false, treeFree = false, plan, scenario }  = {}) {
  const started = performance.now();
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-aa1-')));
  const file = join(directory, 'fixture.txt'); writeFileSync(file, 'before');
  const url = pathToFileURL(file).href;
  const lease = new InputLease({ directory, holder: 'aa1-offline' });
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  let value = 'before', title = 'Fixture', reads = 0, actions = 0, identityChecks = 0;
  let shifted = false, acquisitions = 0;
  let active = false, lastOperation, pendingApproval, engineQueue = Promise.resolve();
  let readGate = () => Promise.resolve();
  const received = [], approvals = [], sent = [];
  const tree = () => `Window: ${JSON.stringify(title)}, App: ${appName}.\n0 ${title === '' ? 'sheet' : 'standard window'} Fixture${mode === 'changeReview' ? `, URL: ${url}` : ''}\n` +
    (active && ['missing-id', 'hidden-target'].includes(fault) ? '\t2 button Other' :
      (shifted ? '\t1 button Focus\n' : '') + `\t${shifted ? 2 : 1} text field (settable) Value: ${value}, ID: entry` +
      (active && fault === 'ambiguous-id' ? '\n\t2 text field (settable), ID: entry' : '') +
      (fault === 'computed-index' ? Array.from({ length: 60 }, (_, i) => `\n\t${i + (shifted ? 3 : 2)} button Choice ${i}`).join('') : ''));
  let output = [];
  const methods = {
    async getAXState(options) {
      await readGate();
      reads++; lastOperation = 'read';
      if (active) advance(readDelay);
      if (active && fault === 'changed-window') title = 'Other';
      if (active && fault === 'expired-lease') {
        const key = [...lease.owned.keys()][0], grant = key && lease.grant(key);
        if (grant) { const record = JSON.parse(readFileSync(grant.path)); record.expires = 0; writeFileSync(grant.path, JSON.stringify(record)); }
      }
      const text = tree(); if (options?.emit !== false) output.push(text); return text;
    },
    async setValue(index, next) {
      if (index !== (shifted ? 2 : 1)) throw new Error('fixture has no field at that index');
      actions++; value = next; lastOperation = 'write'; writeFileSync(file, next);
      if (fault === 'invalidating-action') title = 'Other';
      if (fault === 'unknown-action') throw new Error('fixture transport lost after dispatch; effect unknown');
    },
    async click(index) {
      if (index !== (shifted ? 2 : 1)) throw new Error('fixture has no control at that index');
      if (fault === 'user-takeover') throw new Error('fixture user takeover; input refused');
      actions++; title = ''; lastOperation = 'click';
    },
    async pressKey(key) { if (key !== 'Tab') throw new Error('unexpected fixture key'); shifted = true; },
    async typeText(next) { actions++; value = next; lastOperation = 'write'; writeFileSync(file, next); },
  };
  const raw = new Proxy(methods, { get(target, key) {
    if (key === 'then' || typeof key === 'symbol') return undefined;
    if (key in target) return target[key];
    throw new Error(`unsupported fixture API: ${String(key)}`);
  } });
  const context = createContext({ app: raw, console, Date, setTimeout, clearTimeout,
    nodeRepl: { write: text => output.push(String(text)) },
    cua: {
      async getApp(id) {
        acquisitions++;
        if (id !== appId) throw new Error('fixture app identity mismatch');
        if (fault === 'policy-denied') throw new Error('Computer Use was not approved to use the fixture');
        await new Promise(resolve => {
          pendingApproval = resolve;
          serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 'fixture-approval', method: 'elicitation/create',
            params: { message: 'Allow fixture?', _meta: { connector_id: 'computer-use', persist: ['session'],
              tool_params: { app: appId }, riskLevel: 'low' } } }) + '\n');
        });
        output.push('[sleight:windows]' + JSON.stringify([{ id: appId, windows: [{ title }, { title }] }]));
        output.push(tree());
        return raw;
      },
      async listApps() { return [{ id: appId, name: appName, windows: [{ title, url }] }]; },
    },
  });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: lease,
    sessionId: 'aa1-offline', changeReview: mode === 'changeReview', guardMode: mode === 'careful' ? 'careful' : 'default',
    windowIdentity: async window => {
      identityChecks++; return { ...window, status: 'ok', matches: 1, epoch: 'fixture', window: 1, pid: 123, processStart: 1 };
    } });
  clientOut.setEncoding('utf8').on('data', chunk => {
    for (const line of chunk.trim().split('\n')) {
      const msg = JSON.parse(line); received.push(msg);
      if (msg.method === 'elicitation/create') clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        result: { action: 'accept', content: { decision: 'keep' }, _meta: { persist: 'session' } } }) + '\n');
    }
  });
  serverIn.setEncoding('utf8').on('data', chunk => {
    for (const line of chunk.trim().split('\n')) {
      const msg = JSON.parse(line); sent.push(msg);
      if (msg.id === 'fixture-approval' && msg.result) {
        approvals.push(msg.result._meta?.persist); pendingApproval?.(); continue;
      }
      if (msg.method !== 'tools/call' || msg.params.name !== 'js') continue;
      engineQueue = engineQueue.then(async () => {
        output = []; let error;
        try { await runInContext(`(async () => { ${msg.params.arguments.code} })()`, context,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (e) { error = String(e); output.push(error); }
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {
          isError: !!error, content: output.map(text => ({ type: 'text', text })),
          _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId, kind: 'appId' } } },
        } }) + '\n');
      });
    }
  });
  let id = 0;
  const call = async code => {
    const requestId = ++id;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call',
      params: { name: 'js', arguments: { code } } }) + '\n');
    for (let i = 0; i < 40; i++) {
      await tick(); await engineQueue;
      const result = received.find(msg => msg.id === requestId && msg.result)?.result;
      if (result) return result;
    }
    throw new Error('offline relay did not finish the fixture request');
  };
  try {
    const acquisition = split ? { isError: false } : await call(`app = await cua.getApp(${JSON.stringify(appId)});`);
    if (!acquisition.isError && fault === 'computed-index') await call('await app.pressKey("Tab");');
    reads = actions = acquisitions = 0; active = true;
    const read = split ? `let app = await cua.getApp(${JSON.stringify(appId)});` : 'await app.getAXState({ disableDiffing: true });';
    const write = plan ?? (treeFree ? 'await app.typeText("after");' : fault === 'computed-index' ? 'const index = 1; await app.setValue(index, "after");' :
      fault === 'invalidating-action' ? 'await app.setValue({ id: "entry" }, "first"); await app.setValue({ id: "entry" }, "after");' :
      'await app.setValue({ id: "entry" }, "after");');
    let result = acquisition, scenarioResult;
    if (!acquisition.isError) {
      if (scenario) scenarioResult = await scenario({ call, authorized: () => approvals.includes('session'), holdRead() {
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        readGate = () => gate;
        return () => { readGate = () => Promise.resolve(); release(); };
      } });
      else if (combined) result = await call(plan ?? (read + write));
      else { await call(read); advance(age); result = await call(write); }
    }
    return { reads, actions, value, finalRead: lastOperation === 'read', identityChecks, scenarioResult, elapsedMs: performance.now() - started,
      leaseHeld: lease.owned.size === 1, approvals, acquisitions,
      error: result.isError ? result.content.map(c => c.text ?? '').join('\n') : null,
      guardDecisions: received.filter(msg => msg.result?.isError).map(msg => msg.result.content.map(c => c.text ?? '').join('\n')),
      engineCalls: sent.filter(msg => msg.method === 'tools/call').length };
  } finally {
    const snapshots = relay.snapshotDirectory;
    relay.dispose(); lease.close();
    if (snapshots) removeTemp(snapshots);
    removeTemp(directory);
  }
}

export async function qualifyBatch(options = {}) {
  if (!['default', 'careful', 'changeReview'].includes(options.mode ?? 'default')) throw new Error('unknown mode');
  if (options.fault && !['changed-window', 'ambiguous-id', 'missing-id', 'expired-lease', 'policy-denied', 'invalidating-action', 'computed-index'].includes(options.fault)) throw new Error('unknown fault');
  return { separate: await relayTrial(false, options), combined: await relayTrial(true, options) };
}

if (import.meta.main) console.log(JSON.stringify(await qualifyBatch(), null, 2));
