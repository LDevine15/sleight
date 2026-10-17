#!/usr/bin/env node
// XL1B: sleight-arch runs this only with the owner away. Imports never launch an app.
// node bench/xl1-probe.mjs --live --owner-away
// Fifteen fresh workbooks; no saves. Retain the bank and lock if cleanup is unproved.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { writeDocument } from './battery/documents.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { benchmarkDecision } from './approve.mjs';

export function probeApproval(params) {
  if (!/^Allow Computer Use to use "(?:Microsoft Excel|Excel|com\.microsoft\.Excel)"\?$/.test(params.message ?? ''))
    return { action: 'decline' };
  const answer = benchmarkDecision({ mcp_server_name: 'plugin:sleight:computer',
    message: params.message, requested_schema: params.requestedSchema }, { BENCH_SUITE: 'real' })?.hookSpecificOutput;
  return answer?.action === 'accept' ? { action: 'accept', content: answer.content ?? {} } : { action: 'decline' };
}

export function sheetTabs(state) {
  const tabs = [];
  for (const line of state.split('\n')) {
    const match = /^\t*(\d+) button (Selected, )?.*?, Description: (.*?), Help: Press to make this sheet active(?:,|$)/.exec(line);
    if (match) tabs.push({ number: Number(match[1]), name: match[3], selected: !!match[2] });
  }
  assert.ok(tabs.length && tabs.filter(tab => tab.selected).length === 1, 'Tab order or selection unavailable');
  assert.equal(new Set(tabs.map(tab => tab.name)).size, tabs.length, 'Ambiguous sheet names');
  return tabs;
}

// /tmp and /var are symlinks into /private; compare resolved paths, never raw URLs.
export function normalPath(path) {
  return String(path).replace(/\/+/g, '/').replace(/(.)\/$/, '$1').replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '');
}
export function fileUrlPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:' || parsed.host && parsed.host !== 'localhost') return null;
    return normalPath(decodeURIComponent(parsed.pathname));
  } catch { return null; }
}

// A host refusal keeps its diagnostic (window roles and sizes, never titles or paths) for the report.
export function checkHost(value) {
  if (value.ok) return value;
  const { ok, error, ...details } = value;
  throw Object.assign(new Error(error ?? 'Host fixture check failed'), { details });
}

// Always ask the owned process to quit, even after a trial or engine-close error, and record what it left.
// Returns undefined once exit is confirmed; throws (leaving the fixture owned) otherwise.
export async function cleanupFixture({ client, owned, pointer, host, persist }) {
  let closeError;
  if (client) { try { await client.close(); } catch (error) { closeError = error; } }
  if (owned) {
    if (!owned.pid) {
      const bound = await host('bind').catch(() => ({}));
      if (bound.pid) Object.assign(owned, { pid: bound.pid, birth: bound.birth });
    }
    let result;
    try { result = await host('quit', { pointer }); } catch (error) {
      await persist({ phase: 'cleanup', path: owned.path, exited: false, error: error.message, ...error.details });
      throw error;
    }
    await persist({ phase: 'cleanup', path: owned.path, ...result });
    assert.ok(result.exited && result.pointerRestored, 'Owned process exit or pointer restore unconfirmed');
  }
  if (closeError) throw closeError;
  return undefined;
}

export async function runTrials({ prepare, sample, balance, park, act, read, cleanup, record, sleep: pause = sleep }) {
  const rows = [];
  for (const arm of ['A', 'B', 'C', 'D', 'E']) for (let index = 1; index <= 3; index++) {
    const row = { arm, index };
    try {
      row.before = await prepare(arm, index);
      assert.equal(row.before.length, 2, 'Expected original and newly renamed sheet');
      const target = row.before.find(tab => tab.name === 'Fixture');
      assert.ok(target && !target.selected, 'Original sheet must be unselected');
      if (arm === 'B') await balance();
      if (arm === 'C') await pause(500);
      if (arm === 'E') await park();
      row.beforeClick = await sample();
      await record({ phase: 'before-click', ...row });
      row.after = await act(arm === 'D' ? 'press' : 'click', target.number);
      await record({ phase: 'after-click', ...row });
      row.nextRead = await read();
      rows.push(row);
      await record({ phase: 'next-read', ...row });
    } catch (error) {
      row.error = error.message;
      await record({ phase: 'failed', ...row });
      throw error;
    } finally { await cleanup(); }
  }
  return rows;
}

async function main(argv) {
  assert.deepEqual(argv, ['--live', '--owner-away'], 'Use --live --owner-away; sleight-arch only');
  assert.equal(process.platform, 'darwin', 'Requires macOS');
  assert.ok(process.env.CLAUDE_CONFIG_DIR?.startsWith('/tmp/lane-claude-'), 'Supply a throwaway CLAUDE_CONFIG_DIR');
  let cancelled = false, release, bank, client, owned, pointer;
  const report = { started: new Date().toISOString(), records: [] };
  const cancel = () => { cancelled = true; };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const free = async () => {
    assert.ok(!cancelled, 'Interrupted');
    try { await access('/tmp/sleight-hold'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('Timed window began; stopping input');
  };
  const persist = async record => {
    report.records.push(record);
    if (bank) await writeFile(join(bank, 'report.json'), JSON.stringify(report, null, 2).replaceAll(homedir(), '~') + '\n');
  };
  const host = async (op, extra = {}) => {
    const { stdout } = await promisify(execFile)('/usr/bin/osascript', ['-l', 'JavaScript',
      fileURLToPath(new URL('./xl1-probe-host.js', import.meta.url)), JSON.stringify({ op, ...owned, ...extra })],
    { timeout: 45000, maxBuffer: 1024 * 1024 });
    try { return checkHost(JSON.parse(stdout)); } catch (error) {
      if (error.details) await persist({ phase: 'host-refused', op, error: error.message, ...error.details });
      throw error;
    }
  };
  const plain = result => (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const call = async (code, allowRenameSheet = false) => {
    await free();
    await host('verify', { allowRenameSheet });
    const result = await client.call('js', { code });
    // Persist the raw result for delayed order and guard diagnosis, including failures.
    await persist({ phase: 'engine', code, result });
    assert.ok(!result.isError, 'Engine call failed; see report');
    const state = plain(result);
    assert.doesNotMatch(state, /input lease.*(?:stopped|changed)|document scope.*stopped|outcome unconfirmed/i);
    const window = windowFromText(state);
    if (window?.url) assert.equal(fileUrlPath(window.url), normalPath(owned.path), 'Engine selected another document');
    return state;
  };
  const read = async () => sheetTabs(await call('await app.getAXState({ disableDiffing: true })'));
  const cleanup = async () => {
    const closing = client; client = undefined;
    // On failure owned stays set, so the final cleanup tries the gentle quit again.
    await cleanupFixture({ client: closing, owned, pointer, host, persist });
    owned = undefined;
  };
  try {
    // Wait before starting, then recheck before every engine or pointer action.
    while (true) {
      try { await access('/tmp/sleight-hold'); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
      assert.ok(!cancelled, 'Interrupted'); await sleep(30000);
    }
    release = await acquireLiveLock();
    bank = await mkdtemp('/private/tmp/sleight-xl1-'); report.bank = bank;
    const server = resolveServer(); assert.ok(!server.error, server.error); report.engine = server.version;
    await runTrials({
      prepare: async (arm, index) => {
        await free();
        const preflight = await host('preflight');
        pointer = preflight.pointer;
        const path = join(bank, `XL1-${arm}-${index}.xlsx`);
        writeDocument(path, 'xlsx', `XL1-${arm}-${index}`);
        // Record intended launch before open: uncertain opens retain the bank and lock.
        owned = { path, started: Date.now(), front: preflight.front };
        await persist({ phase: 'launch', ...owned });
        await promisify(execFile)('/usr/bin/open', ['-g', '-b', 'com.microsoft.Excel', path], { timeout: 10000 });
        for (const deadline = Date.now() + 20000; ;) {
          const bound = await host('bind');
          if (bound.pid) { owned = { ...owned, pid: bound.pid, birth: bound.birth }; break; }
          assert.ok(Date.now() < deadline, 'Launch identity unavailable'); await sleep(100);
        }
        // A just-launched Excel answers AXWindows with -25204 (cannot complete), then with no windows, for a while
        // (17:17Z and 17:19Z runs). Wait for its window before any input.
        for (const deadline = Date.now() + 30000; ;) {
          try { await host('verify'); break; } catch (error) {
            const starting = /AX error -25204/.test(error.message) ||
              (/Owned workbook window not found/.test(error.message) && error.details?.windows?.length === 0);
            if (!starting || Date.now() >= deadline) throw error;
            await sleep(250);
          }
        }
        client = await probeClient(server, { relay: true, label: 'xl1', approve: probeApproval, record: () => {}, timeoutMs: 90000 });
        await call('var app = await cua.getApp("com.microsoft.Excel")');
        assert.deepEqual((await read()).map(tab => tab.name), ['Fixture']);
        await call('await app.click({ id: "addBlankSheetButton" })');
        const inserted = await read();
        assert.equal(inserted.length, 2, 'Sheet insertion unconfirmed');
        const fresh = inserted.find(tab => tab.selected && tab.name !== 'Fixture');
        assert.ok(fresh, 'New sheet is not selected');
        await call(`await app.click(${fresh.number}, { clickCount: 2 })`);
        const rename = await call('await app.getAXState({ disableDiffing: true })', true);
        // Do not type unless the double click exposed the rename editor.
        assert.match(rename, /text (?:field|entry area).*\(.*settable.*\).*Value: (?:Sheet\d+|Worksheet\d+)/i, 'Rename editor unavailable');
        const name = `Review-${arm}-${index}`;
        await call(`await app.pressKey("super+a"); await app.typeText(${JSON.stringify(name)}); await app.pressKey("Return")`, true);
        const tabs = await read();
        assert.deepEqual(tabs.map(tab => tab.name), ['Fixture', name], 'Rename changed initial tab order');
        assert.equal(tabs.find(tab => tab.selected)?.name, name);
        return tabs;
      },
      balance: async () => { await free(); await host('balance'); },
      park: async () => { await free(); await host('park'); },
      sample: async () => { await free(); return host('sample'); },
      act: async (method, number) => sheetTabs(await call(method === 'press'
        ? `await app.performSecondaryAction(${number}, "Press"); await app.getAXState({ disableDiffing: true })`
        : `await app.click(${number}); await app.getAXState({ disableDiffing: true })`)),
      read, cleanup, record: persist,
    });
  } catch (error) { report.error = error.message; process.exitCode = 1; }
  finally {
    try { await cleanup(); report.cleanupConfirmed = true; }
    catch (error) { report.cleanupError = error.message; process.exitCode = 1; }
    report.finished = new Date().toISOString();
    await persist({ phase: 'finished' });
    if (release && report.cleanupConfirmed) await release();
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    console.log(JSON.stringify({ report: bank && join(bank, 'report.json'), error: report.error,
      cleanupError: report.cleanupError, cleanupConfirmed: report.cleanupConfirmed }));
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main(process.argv.slice(2));
