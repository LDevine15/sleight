// EPV3-8 live qualification of turbo on Electron apps (epv3-contracts.md, "EPV3-8 integration checklist").
// sleight-arch runs it in the owner's away window: node bench/electron-qualification.mjs --owner-away [--apps vscode,cursor].
// --dry-run runs every cell against fakes and touches nothing live. Cells drive only the five turbo tools; the live driver
// (electron-qualification-live.mjs) launches its own instance with a temporary profile, never the owner's, sends no Apple
// events, and never clicks a consent card or a macOS permission prompt. Importing this file starts nothing.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const HOLD = '/tmp/sleight-hold', LOCK = '/tmp/sleight-live.lock';
export const APPS = Object.freeze({
  vscode: Object.freeze({ key: 'vscode', name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', path: '/Applications/Visual Studio Code.app' }),
  cursor: Object.freeze({ key: 'cursor', name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', path: '/Applications/Cursor.app' }),
});
// The benchmark allowlist (LAWS): only these bundles are launched, and only as their own temporary-profile instance.
export const BENCHMARK_ALLOWLIST = Object.freeze(Object.values(APPS).map(app => app.bundleId));
const TOOLS = new Set(['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs']);
const SAMPLE_MS = 50;

// Bench-side ARIA patterns for the fixture workspace. Runtime code stays app-agnostic; these only find the fixture's rows.
export const SELECTORS = Object.freeze({
  notes: /treeitem "a-notes\.md"/,
  scratch: /treeitem "a-scratch\.txt"/,
  scratchTab: /tab "a-scratch\.txt/,
  editor: /textbox[^\n]*(?:a-scratch\.txt|Editor content)/i,
  quickOpen: /(?:combobox|textbox)[^\n]*(?:Search files by name|Quick ?open|type the name)/i,
  terminal: /textbox[^\n]*Terminal/i,
  frameRef: /\[ref=(f\d+e\d+)\]/,
  overlay: /dialog[^\n]*(?:Sign in|Log in|Welcome)/i,
});

export function prepareWorkspace(root) {
  mkdirSync(join(root, 'rows'), { recursive: true });
  for (let i = 1; i <= 200; i++) writeFileSync(join(root, 'rows', `row-${String(i).padStart(3, '0')}.txt`), `row ${i}\n`);
  writeFileSync(join(root, 'b-big.txt'), Array.from({ length: 1500 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(root, 'a-notes.md'), '# Notes\n\n- [Item one](#one)\n\n## One\n\nQualification notes.\n');
  writeFileSync(join(root, 'a-scratch.txt'), '');
  return { root, scratch: join(root, 'a-scratch.txt'), notes: join(root, 'a-notes.md'), big: join(root, 'b-big.txt'), rows: join(root, 'rows') };
}

// ---- parsing the tools' text (formats from tools.mjs and epv3-contracts.md EPV3-4/EPV3-5)
export const tabsOf = text => [...String(text).matchAll(/^(t[A-Za-z0-9_-]{1,64})\s+(.*)$/gm)].map(([, tab, rest]) =>
  ({ tab, parked: /\bparked\b/.test(rest), window: Number(/window (\d+)/.exec(rest)?.[1]) || null }));
export function headerOf(text) {
  const m = /^# .+? window (\d+) epoch (\d+), join (\d+) (joined|parked: [^,\n]+)(, renderer hidden)?/m.exec(String(text));
  return m && { window: +m[1], windowEpoch: +m[2], joinNo: +m[3], status: m[4] === 'joined' ? 'joined' : 'parked',
    reason: m[4] === 'joined' ? null : m[4].slice(8), rendererHidden: !!m[5] };
}
export function refOf(text, pattern) {
  for (const line of String(text).split('\n')) if (pattern.test(line)) { const m = /\[ref=((?:f\d+)?[es]\d+)\]/.exec(line); if (m) return m[1]; }
  return null;
}
const first = text => String(text).split('\n')[0].slice(0, 240);
const fail = code => { throw new Error(code); };

// ---- measurements
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)] : null;
}
export const timingSummary = values => ({ n: values.length, p50: percentile(values, 50), p90: percentile(values, 90) });

// Frontmost-app and pointer samples every 50 ms. A cell is covered when samples reach both ends and no gap passes 150 ms.
export function backgroundEvidence(samples, { startMs, endMs, fixturePid, intervalMs = SAMPLE_MS }) {
  const near = samples.filter(s => s.t >= startMs - 2 * intervalMs && s.t <= endMs + 2 * intervalMs).sort((a, b) => a.t - b.t);
  const inside = near.filter(s => s.t >= startMs && s.t <= endMs);
  let gap = 0;
  for (let i = 1; i < near.length; i++) gap = Math.max(gap, near[i].t - near[i - 1].t);
  const covered = near.length > 0 && near[0].t <= startMs + 2 * intervalMs && near.at(-1).t >= endMs - 2 * intervalMs && gap <= 3 * intervalMs;
  const origin = inside[0] ?? near[0];
  const moved = Math.max(0, ...inside.map(s => Math.round(Math.hypot(s.x - origin.x, s.y - origin.y))));
  return { samples: inside.length, covered, maxGapMs: gap, fixtureFront: inside.filter(s => s.front === fixturePid).length,
    frontPids: [...new Set(inside.map(s => s.front))].sort((a, b) => a - b), pointerMovedPx: moved };
}

// ---- cells. input: true gates on background proof; 'record' records it. editor: Cursor runs it only after its overlay clears.
const KEYS_REFUSED = ['Meta+Q', 'Meta+W', 'Meta+H', 'Meta+M'];
export const CELLS = Object.freeze([
  { id: 'consent-card', async run(c) {
    // The debugger card is sleight's own native window. Only the user's click answers it; the harness waits and records.
    const r = c.state.connected = await c.driver.connect({ consentWaitMs: c.options.consentWaitMs });
    c.consent(r.card, 'consent-card');
    if (!r.card.shown && !r.card.existing) fail('CONSENT_CARD_NOT_SHOWN');
    if (r.card.status !== 'granted') { c.state.noConnection = true; fail(r.card.status === 'timeout' ? 'CONSENT_NEEDS_OWNER: no click on the debugger card within '
      + Math.round(c.options.consentWaitMs / 1000) + ' s; the harness never clicks it' : 'CONSENT_' + String(r.card.status).toUpperCase()); }
    return { number: r.card.ms, unit: 'ms', detail: { by: r.card.by, scope: r.card.scope } };
  } },
  { id: 'connect', async run(c) {
    const r = c.state.connected ?? fail('NOT_CONNECTED'), id = c.driver.identity();
    if (!id || id.pid !== r.launch.pid || id.pidBirth !== r.launch.pidBirth) fail('CONNECT_IDENTITY_MISMATCH');
    if (r.connect.tcpListeners !== 0) fail(`TCP_LISTENER: ${r.connect.tcpListeners}`);
    return { number: r.connect.ms, unit: 'ms', detail: { launchMs: r.launch.ms, tcpListeners: 0 } };
  } },
  { id: 'cursor-overlay', apps: ['cursor'], async run(c) {
    const trials = c.options.overlayTrials ?? 3; let present = 0, cleared = 0;
    for (let i = 0; i < trials; i++) {
      if (i) await c.driver.restart({ consentWaitMs: c.options.consentWaitMs });
      const tab = (await c.list())[0]?.tab ?? fail('NO_APP_TAB');
      if (!SELECTORS.overlay.test((await c.read(tab)).text)) continue;
      present++;
      await c.act(tab, [{ do: 'press', key: 'Escape' }]);
      if (!SELECTORS.overlay.test((await c.read(tab)).text)) cleared++;
    }
    if (cleared < present) { c.state.skipEditor = true; fail(`OVERLAY_NOT_CLEARED: Escape cleared ${cleared}/${present}`); }
    return { number: cleared, unit: `of ${present} overlays`, detail: { trials, present, cleared } };
  } },
  { id: 'list', editor: true, async run(c) {
    const rows = await c.list(), joined = rows.filter(row => !row.parked);
    if (!joined.length) fail('NO_JOINED_APP_TAB');
    c.state.tab = joined[0].tab;
    return { number: rows.length, unit: 'tabs' };
  } },
  { id: 'read', editor: true, async run(c) {
    const r = await c.read(c.tab()), h = headerOf(r.text) ?? fail('APP_HEADER_MISSING');
    return { number: Buffer.byteLength(r.text), unit: 'bytes', detail: { status: h.status, rendererHidden: h.rendererHidden,
      coverage: /^# Coverage \(untrusted page content\)/m.test(r.text), ms: r.ms } };
  } },
  { id: 'click', editor: true, input: true, async run(c) {
    const ref = refOf((await c.read(c.tab())).text, SELECTORS.scratch) ?? fail('SCRATCH_ROW_NOT_FOUND');
    const r = await c.act(c.tab(), [{ do: 'click', ref }]);
    if (!SELECTORS.scratchTab.test((await c.read(c.tab())).text)) fail('CLICK_EFFECT_MISSING');
    return { number: r.ms, unit: 'ms' };
  } },
  { id: 'key', editor: true, input: true, async run(c) {
    await c.read(c.tab());
    await c.act(c.tab(), [{ do: 'press', key: 'Meta+P' }]);
    if (!SELECTORS.quickOpen.test((await c.read(c.tab())).text)) fail('QUICK_OPEN_MISSING');
    await c.act(c.tab(), [{ do: 'press', key: 'Escape' }]);
    if (SELECTORS.quickOpen.test((await c.read(c.tab())).text)) fail('ESCAPE_EFFECT_MISSING');
    return {};
  } },
  { id: 'background-type', editor: true, input: true, async run(c) {
    // The review's first live cell: typing lands while another app stays frontmost the whole time.
    const front = await c.driver.frontApp(), trials = c.options.trials;
    let present = 0;
    for (let i = 0; i < trials; i++) {
      const marker = `eq${i}k${Math.random().toString(36).slice(2, 8)}`;
      const steps = ref => [{ do: 'type', ref, text: marker + '\n' }, { do: 'press', key: 'Meta+S' }];
      let ref = refOf((await c.read(c.tab())).text, SELECTORS.editor) ?? fail('EDITOR_NOT_FOUND');
      let r = await c.tool('browser_act', { tab: c.tab(), steps: steps(ref), observe: 'none' });
      if (r.isError && /ELECTRON_STALE_READ/.test(r.text)) {
        ref = refOf((await c.read(c.tab())).text, SELECTORS.editor) ?? fail('EDITOR_NOT_FOUND');
        r = await c.tool('browser_act', { tab: c.tab(), steps: steps(ref), observe: 'none' });
      }
      if (r.isError) fail(first(r.text));
      if (await c.until(() => c.driver.readFile('a-scratch.txt').includes(marker), 3000)) present++;
    }
    if (present !== trials) fail(`TYPED_TEXT_MISSING: ${present}/${trials} on disk`);
    return { number: present, unit: `of ${trials}`, expectFront: front.pid, detail: { frontBundle: front.bundle } };
  } },
  { id: 'webview', apps: ['vscode'], editor: true, input: true, async run(c) {
    const ref = refOf((await c.read(c.tab())).text, SELECTORS.notes) ?? fail('NOTES_ROW_NOT_FOUND');
    await c.act(c.tab(), [{ do: 'click', ref }, { do: 'press', key: 'Meta+Shift+V' }]);
    let frame;
    await c.until(async () => (frame = SELECTORS.frameRef.exec((await c.read(c.tab())).text)?.[1]), 5000);
    if (!frame) fail('WEBVIEW_NOT_READ');
    await c.act(c.tab(), [{ do: 'click', ref: frame }]);
    return { detail: { frameRef: true } };
  } },
  { id: 'navigation', apps: ['vscode'], editor: true, async run(c) {
    const before = c.driver.identity();
    const open = await c.tool('browser_open', { url: 'https://example.com/' });
    const refused = {};
    for (const step of ['reload', 'back']) {
      const r = await c.tool('browser_act', { tab: c.tab(), steps: [{ do: step }] });
      refused[step] = r.isError && /ELECTRON_NATIVE_HANDOFF/.test(r.text);
    }
    const after = c.driver.identity();
    if (!open.isError || !refused.reload || !refused.back) fail('NAVIGATION_NOT_REFUSED');
    if (after.pid !== before.pid || after.pidBirth !== before.pidBirth) fail('IDENTITY_CHANGED');
    return { detail: { openRefused: true, ...refused } };
  } },
  { id: 'new-window', apps: ['vscode'], editor: true, input: 'record', async run(c) {
    // A second window of this instance, with the owner's own VS Code possibly running beside it (a test input, never read).
    const owners = await c.driver.ownerInstances();
    await c.read(c.tab());
    await c.act(c.tab(), [{ do: 'press', key: 'Meta+Shift+N' }]);
    let rows = [];
    await c.until(async () => (rows = (await c.list()).filter(row => !row.parked)).length >= 2, 10000);
    if (rows.length < 2) fail(`SECOND_WINDOW_NOT_JOINED: ${rows.length}`);
    const ids = rows.map(row => row.window), mine = c.driver.identity().pid, map = await c.driver.windowOwners(ids);
    const falseJoins = ids.filter(id => map[id] !== mine).length;
    if (new Set(ids).size !== ids.length) fail('WINDOW_JOINED_TWICE');
    if (falseJoins) fail(`FALSE_JOINS: ${falseJoins}`);
    return { number: rows.length, unit: 'windows', detail: { joined: rows.length, falseJoins, ownerInstances: owners } };
  } },
  { id: 'title-bar-delta', apps: ['vscode'], editor: true, async run(c) {
    const g = await c.driver.geometry(c.tab());
    if (![g.delta?.width, g.delta?.height].every(Number.isFinite)) fail('DELTA_UNMEASURED');
    c.state.geometry = g;
    return { number: g.delta.height, unit: 'px', detail: { width: g.delta.width, height: g.delta.height } };
  } },
  { id: 'zoom-scale', apps: ['vscode'], editor: true, async run(c) {
    const g = c.state.geometry ?? await c.driver.geometry(c.tab());
    if (g.zoomLevel !== 0 || g.scaleMatch !== true) fail(`SCALE_MISMATCH: zoom ${g.zoomLevel}`);
    return { detail: { zoomLevel: 0, scaleMatch: true } };
  } },
  { id: 'terminal-refusal', apps: ['vscode'], editor: true, input: true, async run(c) {
    await c.read(c.tab());
    await c.act(c.tab(), [{ do: 'press', key: 'Control+`' }]);
    let ref;
    await c.until(async () => (ref = refOf((await c.read(c.tab())).text, SELECTORS.terminal)), 5000);
    if (!ref) fail('TERMINAL_NOT_FOUND');
    const r = await c.tool('browser_act', { tab: c.tab(), steps: [{ do: 'type', ref, text: 'echo refused' }] });
    await c.read(c.tab());
    await c.tool('browser_act', { tab: c.tab(), steps: [{ do: 'press', key: 'Control+`' }] }); // hides the panel; its result is not the cell's
    if (!r.isError || !/ELECTRON_TERMINAL_REFUSED/.test(r.text)) fail('TERMINAL_INPUT_NOT_REFUSED');
    return { detail: { refused: true } };
  } },
  { id: 'app-key-refusal', editor: true, input: true, async run(c) {
    await c.read(c.tab());
    let refused = 0;
    for (const key of KEYS_REFUSED) {
      const r = await c.tool('browser_act', { tab: c.tab(), steps: [{ do: 'press', key }] });
      if (r.isError && /ELECTRON_APP_KEY_REFUSED/.test(r.text)) refused++;
    }
    if (!await c.driver.appAlive()) fail('APP_EXITED');
    if (refused !== KEYS_REFUSED.length) fail(`APP_KEY_NOT_REFUSED: ${refused}/${KEYS_REFUSED.length}`);
    return { number: refused, unit: 'keys' };
  } },
  { id: 'sheet-parking', apps: ['vscode'], editor: true, input: true, async run(c) {
    const before = headerOf((await c.read(c.tab())).text) ?? fail('APP_HEADER_MISSING');
    await c.act(c.tab(), [{ do: 'press', key: 'Meta+Shift+S' }], { allowPark: true });
    let row;
    await c.until(async () => (row = (await c.list()).find(r => r.tab === c.tab()))?.parked, 5000);
    if (!row?.parked) fail('SHEET_NOT_PARKED');
    const parked = await c.tool('browser_act', { tab: c.tab(), steps: [{ do: 'press', key: 'Escape' }] });
    if (!parked.isError || !/ELECTRON_PARKED/.test(parked.text)) fail('PARKED_INPUT_SENT');
    if (!(await c.driver.nativeSheetCancel()).pressed) fail('SHEET_CANCEL_UNPRESSED');
    await c.until(async () => !(await c.list()).find(r => r.tab === c.tab())?.parked, 5000);
    const stale = await c.tool('browser_act', { tab: c.tab(), steps: [{ do: 'press', key: 'Escape' }] });
    const staleRefusals = stale.isError && /ELECTRON_STALE_READ/.test(stale.text) ? 1 : 0;
    const after = headerOf((await c.read(c.tab())).text) ?? fail('APP_HEADER_MISSING');
    await c.act(c.tab(), [{ do: 'press', key: 'Escape' }]);
    if (!staleRefusals) fail('STALE_READ_NOT_REFUSED');
    if (after.joinNo !== before.joinNo + 1) fail(`JOIN_NOT_ADVANCED: ${before.joinNo} to ${after.joinNo}`);
    return { detail: { joinBefore: before.joinNo, joinAfter: after.joinNo, staleRefusals } };
  } },
  { id: 'revoke', apps: ['vscode'], editor: true, input: true, async run(c) {
    // Pause mid-batch: the revocation parks the batch, and no step is sent twice.
    const ref = refOf((await c.read(c.tab())).text, SELECTORS.editor) ?? fail('EDITOR_NOT_FOUND');
    const tag = Math.random().toString(36).slice(2, 6), markers = Array.from({ length: 6 }, (_, i) => `rv${tag}${i}`);
    const pending = c.tool('browser_act', { tab: c.tab(), steps: markers.flatMap(text => [{ do: 'type', ref, text: text + ' ' }, { do: 'wait', ms: 250 }]), observe: 'none' });
    await c.sleep(300);
    await c.driver.revoke();
    const r = await pending;
    await c.driver.resume();
    const text = (await c.read(c.tab())).text;
    const replays = markers.filter(m => text.split(m).length > 2).length;
    if (!/ELECTRON_PARKED|parked|revoked/i.test(r.text)) fail('REVOKE_NOT_REPORTED');
    if (replays) fail(`REPLAYED: ${replays}`);
    return { detail: { replays, present: markers.filter(m => text.includes(m)).length } };
  } },
  { id: 'disconnect', apps: ['vscode'], editor: true, async run(c) {
    const r = await c.driver.disconnect();
    const refused = await c.tool('browser_tabs', { do: 'list' });
    await c.driver.reconnect({ consentWaitMs: c.options.consentWaitMs }).then(card => c.consent(card, 'disconnect'));
    const rows = await c.list();
    if (!r.appAlive || !r.pipeRetained) fail('DISCONNECT_CLOSED_APP');
    if (!refused.isError) fail('DISCONNECTED_CALL_ANSWERED');
    if (!rows.length) fail('RECONNECT_FAILED');
    c.state.tab = rows.find(row => !row.parked)?.tab ?? c.state.tab;
    return { detail: { appAlive: true, pipeRetained: true } };
  } },
  { id: 'worker-kill', apps: ['vscode'], editor: true, async run(c) {
    const before = c.driver.identity();
    await c.driver.killWorker();
    await c.sleep(c.options.aliveWaitMs);
    if (!await c.driver.appAlive()) fail('APP_EXITED_AFTER_WORKER_LOSS');
    c.consent(await c.driver.reconnect({ consentWaitMs: c.options.consentWaitMs }), 'worker-kill');
    const rows = await c.list(), after = c.driver.identity();
    if (!rows.length || after.pid !== before.pid || after.pidBirth !== before.pidBirth) fail('RECONNECT_IDENTITY_CHANGED');
    c.state.tab = rows.find(row => !row.parked)?.tab ?? c.state.tab;
    return { number: Math.round(c.options.aliveWaitMs / 1000), unit: 's alive' };
  } },
  { id: 'timings', apps: ['vscode'], editor: true, async run(c) {
    // Workflow time at the tool-call boundary, never component time. Cold is the first call on a fresh connection.
    const kinds = { list: { cold: [], warm: [] }, read: { cold: [], warm: [] }, act: { cold: [], warm: [] } };
    const op = async (kind, tab) => {
      const r = kind === 'list' ? await c.tool('browser_tabs', { do: 'list' }) : kind === 'read' ? await c.tool('browser_read', { tab, max_chars: 8000 })
        : await c.tool('browser_act', { tab, steps: [{ do: 'press', key: 'Escape' }], observe: 'none' });
      if (r.isError) fail(`${kind.toUpperCase()}_FAILED: ${first(r.text)}`);
      return r.ms;
    };
    for (const kind of Object.keys(kinds)) {
      for (let i = 0; i < c.options.samples; i++) {
        c.consent(await c.driver.reconnect({ consentWaitMs: c.options.consentWaitMs }), 'timings');
        const tab = kind === 'list' ? undefined : (await c.list()).find(row => !row.parked)?.tab ?? fail('NO_JOINED_APP_TAB');
        if (kind === 'act') await c.read(tab);
        kinds[kind].cold.push(await op(kind, tab));
      }
      const tab = (await c.list()).find(row => !row.parked)?.tab;
      if (kind === 'act') await c.read(tab);
      for (let i = 0; i < c.options.samples; i++) kinds[kind].warm.push(await op(kind, tab));
      c.state.tab = tab ?? c.state.tab;
    }
    for (const [kind, v] of Object.entries(kinds)) c.timings[kind] = { scope: 'tool-call', cold: timingSummary(v.cold), warm: timingSummary(v.warm) };
    return { number: c.timings.read.warm.p50, unit: 'ms warm read p50' };
  } },
  { id: 'contention', apps: ['vscode'], editor: true, async run(c) {
    const rows = [];
    for (const workers of [1, 4, 13]) rows.push({ workers, ...await c.driver.contention(workers, { consentWaitMs: c.options.consentWaitMs }) });
    const bad = rows.find(row => row.ok !== 1 || row.busy !== row.workers - 1 || row.other !== 0);
    if (bad) fail(`CONTENTION: ${bad.workers} workers gave ${bad.ok} ok, ${bad.busy} busy, ${bad.other} other`);
    return { number: rows.reduce((sum, row) => sum + row.busy, 0), unit: 'busy refusals', detail: rows };
  } },
  { id: 'quit', async run(c) {
    if (c.state.noConnection) fail('NOTHING_LAUNCHED');
    const r = await c.driver.quit();
    if (!r.exited) fail('APP_QUIT_UNCONFIRMED');
    if (r.censusLeft) fail(`CENSUS_LEFT: ${r.censusLeft}`);
    if (!r.profileRemoved) fail('PROFILE_NOT_REMOVED');
    return { number: r.ms, unit: 'ms', detail: { censusLeft: 0, profileRemoved: true } };
  } },
  { id: 'host-kill', apps: ['vscode'], async run(c) {
    if (c.state.noConnection) fail('NOTHING_LAUNCHED');
    // A second instance, so Quit above ran with a live host. Recorded either way: whether the app survives its host.
    const launched = await c.driver.connect({ consentWaitMs: c.options.consentWaitMs });
    c.consent(launched.card, 'host-kill');
    if (launched.card.status !== 'granted') fail('CONSENT_NEEDS_OWNER');
    const killed = await c.driver.killHost();
    const refusal = await c.driver.reconcile();
    if (!/OWNERSHIP_UNRESOLVED/.test(refusal.code ?? '')) fail(`SECOND_LAUNCH_NOT_REFUSED: ${refusal.code}`);
    if (killed.appAlive) await c.driver.quitByPid();
    if (!(await c.driver.collect()).absent) fail('COLLECT_ABSENCE_UNPROVED');
    const after = await c.driver.reconcile();
    if (after.code) fail(`RECONCILE_AFTER_COLLECT: ${after.code}`);
    return { detail: { appSurvived: killed.appAlive, refusal: refusal.code, coldLaunchMs: launched.launch.ms } };
  } },
].map(cell => Object.freeze(cell)));

export const cellsFor = app => CELLS.filter(cell => !cell.apps || cell.apps.includes(app.key));
export const requiredCells = app => cellsFor(app).map(cell => cell.id);
const appFor = bundleId => Object.values(APPS).find(app => app.bundleId === bundleId);

export async function waitForHold(io, clock, intervalMs = 30000) {
  let held = 0;
  while (io.exists(HOLD)) { await clock.sleep(intervalMs); held += intervalMs; }
  return held;
}

function context({ app, driver, clock, options, state, timings, consentLog }) {
  const c = {
    app, driver, options, state, timings, windows: [], now: clock.now, sleep: ms => clock.sleep(ms),
    tab: () => state.tab ?? fail('NO_APP_TAB'),
    consent(card, cell) { if (card) consentLog.push({ cell, shown: !!card.shown, by: card.by ?? null, status: card.status ?? null, scope: card.scope ?? null, ms: card.ms ?? null }); },
    async tool(name, args) {
      if (!TOOLS.has(name)) fail('NOT_A_TURBO_TOOL');
      const r = await driver.tool(name, args), id = driver.identity();
      for (const row of name === 'browser_tabs' && !r.isError ? tabsOf(r.text) : []) if (row.window) c.window(row.window, null, id);
      const h = name === 'browser_read' && !r.isError ? headerOf(r.text) : null;
      if (h) c.window(h.window, h.windowEpoch, id);
      return r;
    },
    window(window, epoch, id = driver.identity()) {
      if (!c.windows.some(w => w.id === window && w.pid === id?.pid)) c.windows.push({ id: window, epoch, pid: id?.pid, pidBirth: id?.pidBirth });
    },
    async list() { const r = await c.tool('browser_tabs', { do: 'list' }); if (r.isError) fail(first(r.text)); return tabsOf(r.text); },
    async read(tab, extra = {}) { const r = await c.tool('browser_read', { tab, ...extra }); if (r.isError) fail(first(r.text)); return r; },
    async act(tab, steps, { allowPark = false } = {}) {
      const r = await c.tool('browser_act', { tab, steps, observe: 'none' });
      if (r.isError && !(allowPark && /ELECTRON_PARKED/.test(r.text))) fail(first(r.text));
      return r;
    },
    async until(test, timeoutMs) {
      for (const started = clock.now(); ; await clock.sleep(100)) { if (await test()) return true; if (clock.now() - started >= timeoutMs) return false; }
    },
  };
  return c;
}

async function runCell(cell, c, { driver, observer, clock }) {
  const record = { id: cell.id, status: 'fail' };
  if (cell.input) {
    const id = driver.identity();
    if (id && await observer.frontPid?.() === id.pid) { await driver.frontApp(); record.refocused = true; } // before the cell's window
  }
  const start = clock.now();
  let out = {};
  try {
    out = await cell.run(c) ?? {};
    record.status = 'pass';
  } catch (error) { record.error = String(error?.message ?? error).slice(0, 300); }
  const end = clock.now();
  record.ms = end - start;
  if (out.number !== undefined) { record.number = out.number; record.unit = out.unit; }
  if (out.detail !== undefined) record.detail = out.detail;
  const id = driver.identity();
  if (id) record.identity = { pid: id.pid, pidBirth: id.pidBirth, instance: id.instance, epoch: id.epoch };
  record.windows = c.windows;
  const evidence = backgroundEvidence(await observer.samples(start, end), { startMs: start, endMs: end, fixturePid: id?.pid });
  record.background = evidence;
  if (cell.input === 'record') record.detail = { ...record.detail, focusTaken: evidence.fixtureFront > 0 };
  if (cell.input === true && record.status === 'pass') {
    const problem = !evidence.covered ? `BACKGROUND_UNPROVED: sampler gap ${evidence.maxGapMs} ms`
      : evidence.fixtureFront ? `BACKGROUND_FOCUS_TAKEN: ${evidence.fixtureFront} samples`
      : evidence.pointerMovedPx ? `BACKGROUND_POINTER_MOVED: ${evidence.pointerMovedPx} px`
      : out.expectFront !== undefined && evidence.frontPids.some(pid => pid !== out.expectFront) ? 'BACKGROUND_FRONT_CHANGED' : null;
    if (out.expectFront !== undefined) record.detail = { ...record.detail, otherFront: !problem };
    if (problem) Object.assign(record, { status: 'fail', error: problem });
  }
  return record;
}

export async function runQualification({ app, driver, observer, io, clock, cells = cellsFor(app), options = {} }) {
  const opts = { trials: 10, samples: 20, aliveWaitMs: 60000, consentWaitMs: 120000, mode: 'live', ...options };
  const receipt = { version: 1, kind: 'electron-qualification', mode: opts.mode, at: new Date(clock.now()).toISOString(),
    app: { name: app.name, bundleId: app.bundleId }, profile: { temporary: true }, cells: [], timings: {}, heldMs: 0,
    // LAWS: only the user's click answers sleight's debugger card. The harness waits for it and never presses it.
    consent: { harnessClicks: false, cards: [] }, sampling: { intervalMs: SAMPLE_MS }, options: { trials: opts.trials, samples: opts.samples, aliveWaitMs: opts.aliveWaitMs } };
  const state = {}, c = context({ app, driver, clock, options: opts, state, timings: receipt.timings, consentLog: receipt.consent.cards });
  let stopped;
  const stop = async before => { const prompt = await io.permission(); if (prompt) stopped = { reason: 'permission-prompt', process: prompt.process, title: prompt.title, before }; return !!prompt; };
  await observer.start?.();
  try {
    for (const cell of cells) {
      if (!stopped) receipt.heldMs += await waitForHold(io, clock);
      if (stopped || await stop(cell.id)) { receipt.cells.push({ id: cell.id, status: 'stopped' }); continue; }
      if (state.noConnection) { receipt.cells.push({ id: cell.id, status: 'skipped', reason: 'NO_CONNECTION' }); continue; }
      if (cell.editor && state.skipEditor) { receipt.cells.push({ id: cell.id, status: 'skipped', reason: 'OVERLAY_NOT_CLEARED' }); continue; }
      c.windows = [];
      receipt.cells.push(await runCell(cell, c, { driver, observer, clock }));
    }
    if (!stopped) await stop('cleanup');
  } finally {
    // Cleanup quits and removes only what this run launched; the owner's instances are never addressed.
    try { receipt.cleanup = await driver.cleanup(); } catch (error) { receipt.cleanup = { confirmed: false, error: String(error?.message ?? error) }; }
    await observer.stop?.();
  }
  if (stopped) receipt.stopped = stopped;
  Object.assign(receipt.app, driver.build?.() ?? {});
  receipt.profile.removed = receipt.cleanup?.profileRemoved === true;
  receipt.qualified = false;
  receipt.validation = validateReceipt(receipt);
  receipt.qualified = receipt.validation.qualified;
  return receipt;
}

// ---- receipt checks (contracts, EPV3-8 item 4). errors reject the receipt; unqualified only withholds qualification.
const SECRET_KEYS = new Set(['secret', 'adminSecret', 'ticket', 'token', 'socket', 'handle']);
function hasSecretKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => SECRET_KEYS.has(key) || hasSecretKey(item));
}
export function validateReceipt(receipt, { required = requiredCells(appFor(receipt?.app?.bundleId) ?? APPS.vscode) } = {}) {
  const errors = [], unqualified = [], owners = new Map();
  const cells = Array.isArray(receipt?.cells) ? receipt.cells : (errors.push('CELLS_MISSING'), []);
  const seen = new Set();
  for (const cell of cells) {
    if (seen.has(cell.id)) errors.push('CELL_DUPLICATE:' + cell.id);
    seen.add(cell.id);
    if (cell.status === 'pass' || cell.status === 'fail') {
      const id = cell.identity;
      if (!(Number.isSafeInteger(id?.pid) && id.pid > 0 && typeof id.pidBirth === 'string' && id.pidBirth && typeof id.instance === 'string' && id.instance &&
        Number.isSafeInteger(id.epoch))) errors.push('CELL_IDENTITY_MISSING:' + cell.id);
    }
    if (cell.status === 'skipped') unqualified.push('CELL_SKIPPED:' + cell.id);
    else if (cell.status === 'stopped') unqualified.push('CELL_STOPPED:' + cell.id);
    else if (cell.status === 'fail') unqualified.push('CELL_FAILED:' + cell.id);
    else if (cell.status !== 'pass') errors.push('CELL_STATUS_INVALID:' + cell.id);
    for (const w of cell.windows ?? []) {
      const owner = `${w.pid}/${w.pidBirth}`;
      if (owners.has(w.id) && owners.get(w.id) !== owner && !errors.includes('WINDOW_REUSED:' + w.id)) errors.push('WINDOW_REUSED:' + w.id);
      if (!owners.has(w.id)) owners.set(w.id, owner);
    }
  }
  for (const id of required) if (!seen.has(id)) unqualified.push('REQUIRED_CELL_MISSING:' + id);
  if (/\/Users\/[^/\s"']+/.test(JSON.stringify(receipt ?? {})) || hasSecretKey(receipt)) errors.push('SECRET_OUTPUT');
  for (const [kind, value] of Object.entries(receipt?.timings ?? {})) if (value?.scope !== 'tool-call') errors.push('COMPONENT_TIME:' + kind);
  if (receipt?.cleanup?.confirmed !== true) errors.push('CLEANUP_UNCONFIRMED');
  if (receipt?.profile?.temporary !== true) errors.push('ISOLATION_FAILED');
  if (receipt?.consent?.harnessClicks !== undefined && receipt.consent.harnessClicks !== false) errors.push('HARNESS_CLICKED_CONSENT');
  if (receipt?.mode === 'dry-run') unqualified.push('DRY_RUN');
  if (receipt?.app?.fake === true) unqualified.push('FAKE_DRIVER');
  if (receipt?.stopped) unqualified.push('STOPPED:' + receipt.stopped.reason);
  let qualified = errors.length === 0 && unqualified.length === 0;
  if (receipt?.qualified === true && !qualified) { errors.push('QUALIFIED_CLAIM_UNSUPPORTED'); qualified = false; }
  return { qualified, errors, unqualified };
}

export function scrubReceipt(value, { home = homedir(), user = userInfo().username } = {}) {
  if (typeof value === 'string') {
    let out = value.replaceAll(home, '~').replace(/\/Users\/[^/\s"']+/g, '~');
    if (user && user.length >= 3) out = out.replaceAll(user, '[user]');
    return out;
  }
  if (Array.isArray(value)) return value.map(item => scrubReceipt(item, { home, user }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubReceipt(v, { home, user })]));
  return value;
}

export function parseArgs(argv) {
  const out = { apps: ['vscode'], samples: 20, trials: 10, aliveWaitMs: 60000, consentWaitMs: 120000, out: undefined, mode: undefined };
  const numbers = { '--samples': 'samples', '--trials': 'trials', '--alive-wait-ms': 'aliveWaitMs', '--consent-wait-ms': 'consentWaitMs' };
  let dry = false, away = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = argv[i + 1];
    if (arg === '--dry-run') { dry = true; continue; }
    if (arg === '--owner-away') { away = true; continue; }
    if (!(arg in numbers) && arg !== '--apps' && arg !== '--out' || value === undefined || value.startsWith('--')) throw Error('INVALID_OPTIONS');
    i++;
    if (arg === '--apps') {
      out.apps = value.split(',');
      if (out.apps.some(key => !APPS[key])) throw Error('UNKNOWN_APP');
    } else if (arg === '--out') out.out = value;
    else { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw Error('INVALID_OPTIONS'); out[numbers[arg]] = n; }
  }
  if (dry && away) throw Error('CONFLICTING_MODE');
  if (!dry && !away) throw Error('OWNER_AWAY_REQUIRED: live cells show windows and may take focus; pass --owner-away in the away window, or --dry-run');
  out.mode = dry ? 'dry-run' : 'live';
  return out;
}

function writeReceipt(dir, receipt, app) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${app.key}-${receipt.mode}-${receipt.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(scrubReceipt(receipt), null, 2) + '\n');
  return path;
}
const summaryLine = (app, r) => `${app.key}: ${r.cells.filter(c => c.status === 'pass').length}/${r.cells.length} cells passed, qualified ${r.qualified}` +
  (r.validation.errors.length ? `, receipt errors ${r.validation.errors.join(' ')}` : '') + (r.stopped ? `, stopped: ${r.stopped.reason}` : '');

export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv), log = deps.log ?? console.log, write = deps.write ?? writeReceipt;
  const clock = deps.clock ?? { now: Date.now, sleep: ms => delay(ms) };
  const out = options.out ?? fileURLToPath(new URL(`./results/electron/${new Date(clock.now()).toISOString().slice(0, 10)}/`, import.meta.url));
  const runOptions = { trials: options.trials, samples: options.samples, aliveWaitMs: options.aliveWaitMs, consentWaitMs: options.consentWaitMs, mode: options.mode };
  if (options.mode === 'dry-run') {
    const { fakeDriver, fakeObserver } = await import('./electron-qualification-fakes.mjs');
    let clean = true;
    for (const key of options.apps) {
      // A virtual clock: the dry run's 60 s worker-loss wait and polling cost nothing.
      let virtual = clock.now();
      const app = APPS[key], t = { now: () => virtual, sleep: async ms => { virtual += ms; } };
      const driver = fakeDriver({ now: t.now, app });
      const receipt = await runQualification({ app, driver, observer: fakeObserver({ now: t.now, fixturePid: () => driver.identity()?.pid }),
        io: { exists: () => false, permission: async () => false }, clock: t, options: runOptions });
      log(summaryLine(app, receipt) + ` (${write(out, receipt, app) ?? 'not written'})`);
      clean &&= receipt.validation.errors.length === 0 && receipt.cells.every(cell => cell.status === 'pass' || cell.status === 'skipped');
    }
    return clean ? 0 : 1;
  }
  const io = { exists: existsSync, ...deps.io };
  if (!io.permission || !io.acquireLock) {
    const [{ observePermission }, { acquireLiveLock }] = await Promise.all([import('./real-permission.mjs'), import('./live-lock.mjs')]);
    io.permission ??= () => observePermission({ stopOnLiveHold: false });
    io.acquireLock ??= () => acquireLiveLock(LOCK, { wait: true, interval: 15000 });
  }
  await waitForHold(io, clock);
  const release = await io.acquireLock();
  let runtime, keep = false, qualified = true;
  try {
    // Preflight inside liveRuntime refuses before any launch when an EPV3 module, the app or the permission observer is missing.
    runtime = await (deps.liveRuntime ?? (async (...args) => (await import('./electron-qualification-live.mjs')).liveRuntime(...args)))(options, { io, clock });
    for (const key of options.apps) {
      const app = APPS[key];
      const receipt = await runQualification({ app, driver: runtime.driverFor(app), observer: runtime.observer, io, clock, options: runOptions });
      log(summaryLine(app, receipt) + ` (${write(out, receipt, app) ?? 'not written'})`);
      qualified &&= receipt.qualified;
      if (receipt.cleanup?.confirmed !== true) { keep = true; break; }
      if (receipt.stopped) break;
    }
  } finally {
    try { await runtime?.close(); } catch (error) { keep = true; log(`runtime close failed: ${error.message}`); }
    if (keep) log(`cleanup unconfirmed: live lock kept at ${LOCK}; leftovers are named in the receipt`);
    else await release();
  }
  return qualified && !keep ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
