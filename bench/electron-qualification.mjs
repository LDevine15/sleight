// EPV3-8 live qualification of turbo on Electron apps (epv3-contracts.md, "EPV3-8 integration checklist").
// sleight-arch runs it in the owner's away window: node bench/electron-qualification.mjs --owner-away [--apps vscode,cursor].
// --dry-run --relaunch runs the relaunch cells (the owner's own app and profile, 1.3.1) against fakes; they have no live run here.
// --dry-run runs every cell against fakes and touches nothing live. Cells drive only the five turbo tools; the live driver
// (electron-qualification-live.mjs) launches its own instance with a temporary profile, never the owner's, sends no Apple
// events, and never clicks a consent card or a macOS permission prompt. Importing this file starts nothing.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancellableDriver, checkRunSignal, interruptibleWait } from './electron-run-cancellation.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { parkedReceipt } from '../plugins/sleight/lib/direct-browser/electron-host-reasons.mjs';

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
  mkdirSync(join(root, '.vscode'), { recursive: true });
  writeFileSync(join(root, '.vscode', 'settings.json'), JSON.stringify({ 'editor.accessibilitySupport': 'on' }, null, 2) + '\n');
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
  for (const line of String(text).split('\n')) if (pattern.test(line)) { const m = /\[ref=((?:f\d+)?e\d+|[sx]\d+)\]/.exec(line); if (m) return m[1]; }
  return null;
}
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function editorRefOf(text, name) {
  const tab = new RegExp('tab "' + escaped(name) + '(?:"|,)');
  const lines = String(text).split('\n');
  if (!lines.some(line => tab.test(line) && /\[selected\]/.test(line))) return null;
  const editors = lines.filter(line => /textbox/.test(line) && (line.includes(name) || /Editor content/i.test(line)));
  const named = editors.filter(line => line.includes(name));
  if (named.length === 1) return refOf(named[0], /textbox/);
  // The ordinary tree may describe the same zero-area editor without an actionable ref.
  // Only the separately proved active keyboard capability can resolve that case; two actionable editors still refuse.
  const actionable = named.filter(line => refOf(line, /textbox/));
  if (actionable.length === 1 && /\[active\]/.test(actionable[0]) && /\[keyboard-only\]/.test(actionable[0]) &&
      /^x\d+$/.test(refOf(actionable[0], /textbox/))) return refOf(actionable[0], /textbox/);
  return editors.length === 1 && /textbox "Editor content(?:"|[,;])/i.test(editors[0]) ? refOf(editors[0], /textbox/) : null;
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
export function backgroundEvidence(samples, { startMs, endMs, fixturePid, fixturePids = [], intervalMs = SAMPLE_MS }) {
  const near = samples.filter(s => s.t >= startMs - 2 * intervalMs && s.t <= endMs + 2 * intervalMs).sort((a, b) => a.t - b.t);
  const inside = near.filter(s => s.t >= startMs && s.t <= endMs);
  let gap = 0;
  for (let i = 1; i < near.length; i++) gap = Math.max(gap, near[i].t - near[i - 1].t);
  const covered = near.length > 0 && near[0].t <= startMs + 2 * intervalMs && near.at(-1).t >= endMs - 2 * intervalMs && gap <= 3 * intervalMs;
  const origin = inside[0] ?? near[0];
  const moved = Math.max(0, ...inside.map(s => Math.round(Math.hypot(s.x - origin.x, s.y - origin.y))));
  return { samples: inside.length, covered, maxGapMs: gap, fixtureFront: inside.filter(s => s.front === fixturePid || fixturePids.includes(s.front)).length,
    frontPids: [...new Set(inside.map(s => s.front))].sort((a, b) => a - b), pointerMovedPx: moved };
}

// ---- cells. input: true gates on background proof; 'record' records it. editor: Cursor runs it only after its overlay clears.
const KEYS_REFUSED = ['Meta+Q', 'Meta+W', 'Meta+H', 'Meta+M'];
export const CELLS = Object.freeze([
  { id: 'consent-card', async run(c) {
    // The debugger card is sleight's own native window. Only the user's click answers it; the harness waits and records.
    const r = c.state.connected = await c.driver.connect({ consentWaitMs: c.options.consentWaitMs });
    c.consent(r.card, 'consent-card');
    if (r.error) throw Object.assign(Error(r.error), { stage: r.stage });
    if (r.card.error && !r.card.requested && !r.card.shown && !r.card.existing) fail(r.card.error);
    if (!r.card.requested && !r.card.shown && !r.card.existing) fail('CONSENT_CARD_NOT_REQUESTED');
    if (r.card.status !== 'granted') { c.state.noConnection = true; fail(r.card.status === 'timeout' ? 'CONSENT_NEEDS_OWNER: no click on the debugger card within '
      + Math.round(c.options.consentWaitMs / 1000) + ' s; the harness never clicks it' : 'CONSENT_' + String(r.card.status).toUpperCase()); }
    return { number: r.card.ms, unit: 'ms', detail: { by: r.card.by, scope: r.card.scope, qualification: r.qualification ?? null } };
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
    c.state.workspaceWindow = joined[0].window;
    return { number: rows.length, unit: 'tabs', detail: { tabs: rows } };
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
    const ref = await c.openScratch();
    try {
      await c.act(c.tab(), [{ do: 'press', ref, key: 'Meta+P' }]);
      if (!await c.until(async () => SELECTORS.quickOpen.test((await c.read(c.tab(), { find: 'Search files by name|Quick open|type the name' })).text), 5000)) fail('QUICK_OPEN_MISSING');
    } finally {
      await c.read(c.tab(), { find: 'Search files by name|Quick open|type the name' });
      await c.act(c.tab(), [{ do: 'press', key: 'Escape' }]);
    }
    if (SELECTORS.quickOpen.test((await c.read(c.tab(), { find: 'Search files by name|Quick open|type the name' })).text)) fail('ESCAPE_EFFECT_MISSING');
    return {};
  } },
  { id: 'background-type', editor: true, input: true,
    prepare: c => c.driver.frontApp({ bundle: 'com.apple.Terminal' }), async run(c) {
    // The review's first live cell: typing lands while another app stays frontmost the whole time.
    const front = await c.driver.frontApp(), trials = c.options.trials;
    if (front.bundle !== 'com.apple.Terminal') fail('BACKGROUND_TERMINAL_REQUIRED');
    await c.openScratch();
    let present = 0;
    for (let i = 0; i < trials; i++) {
      const marker = `eq${i}k${Math.random().toString(36).slice(2, 8)}`;
      const steps = ref => [{ do: 'type', ref, text: marker + '\n' }, { do: 'press', key: 'Meta+S' }];
      let ref = editorRefOf((await c.read(c.tab(), { find: 'Editor content|a-scratch.txt' })).text, 'a-scratch.txt') ?? fail('EDITOR_NOT_FOUND');
      let r = await c.tool('browser_act', { tab: c.tab(), steps: steps(ref), observe: 'none' });
      if (r.isError && /ELECTRON_STALE_READ/.test(r.text)) {
        ref = editorRefOf((await c.read(c.tab(), { find: 'Editor content|a-scratch.txt' })).text, 'a-scratch.txt') ?? fail('EDITOR_NOT_FOUND');
        r = await c.tool('browser_act', { tab: c.tab(), steps: steps(ref), observe: 'none' });
      }
      if (r.isError) fail(first(r.text));
      if (await c.until(() => c.driver.readFile('a-scratch.txt').includes(marker), 3000)) present++;
    }
    if (present !== trials) fail(`TYPED_TEXT_MISSING: ${present}/${trials} on disk`);
    return { number: present, unit: `of ${trials}`, expectFront: front.pid, detail: { frontBundle: front.bundle } };
  } },
  { id: 'webview', apps: ['vscode'], editor: true, input: true, async run(c) {
    const ref = await c.openFile('a-notes.md');
    await c.act(c.tab(), [{ do: 'press', ref, key: 'Meta+Shift+V' }]);
    let frame;
    await c.until(async () => (frame = SELECTORS.frameRef.exec((await c.read(c.tab(), { find: 'Item one|Qualification notes' })).text)?.[1]), 5000);
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
  { id: 'new-window', apps: ['vscode'], editor: true, input: 'record',
    async prepare(c) {
      const setup = await c.driver.nativeSecondWindow(), expected = setup?.windows;
      if (!Array.isArray(expected) || expected.length !== 2 || new Set(expected).size !== 2) fail('MULTI_WINDOW_UNMEASURED');
      const joined = await c.until(async () => {
        const rows = (await c.list()).filter(row => !row.parked);
        return rows.length === 2 && new Set(rows.map(row => row.window)).size === 2 && rows.every(row => expected.includes(row.window));
      }, 10000);
      if (!joined) fail('MULTI_WINDOW_UNMEASURED');
      return { created: setup.created, windows: expected };
    }, async run(c) {
    // Creating a native window can activate the app. Turbo must hand that key back to the native path.
    // Joining multiple already-open fixture windows is a separate requirement, never satisfied by a refusal alone.
    const owners = await c.driver.ownerInstances(), before = (await c.list()).filter(row => !row.parked);
    await c.read(c.tab());
    const result = await c.tool('browser_act', { tab: c.tab(), steps: [{ do: 'press', key: 'Meta+Shift+N' }], observe: 'none' });
    if (!result.isError || !/ELECTRON_APP_KEY_REFUSED/.test(result.text)) fail('WINDOW_CREATION_NOT_REFUSED');
    const rows = (await c.list()).filter(row => !row.parked);
    if (rows.length !== before.length) fail('WINDOW_CHANGED_AFTER_REFUSAL');
    const ids = rows.map(row => row.window), mine = c.driver.identity().pid, map = await c.driver.windowOwners(ids);
    const falseJoins = ids.filter(id => map[id] !== mine).length;
    if (new Set(ids).size !== ids.length) fail('WINDOW_JOINED_TWICE');
    if (falseJoins) fail(`FALSE_JOINS: ${falseJoins}`);
    return { number: rows.length, unit: 'windows', detail: { joined: rows.length, falseJoins, ownerInstances: owners, windowCreationRefused: true } };
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
    const editor = await c.openScratch();
    try {
      await c.act(c.tab(), [{ do: 'press', ref: editor, key: 'Control+`' }]);
      let ref;
      await c.until(async () => (ref = refOf((await c.read(c.tab(), { find: 'Terminal' })).text, SELECTORS.terminal)), 5000);
      if (!ref) fail('TERMINAL_NOT_FOUND');
      const r = await c.tool('browser_act', { tab: c.tab(), steps: [{ do: 'type', ref, text: 'echo refused' }] });
      if (!r.isError || !/ELECTRON_TERMINAL_REFUSED/.test(r.text)) fail('TERMINAL_INPUT_NOT_REFUSED');
    } finally {
      // A key in the terminal is correctly refused. Select the editor again; later input carries its exact ref.
      await c.openScratch();
    }
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
    await c.openScratch();
    const read = await c.read(c.tab(), { find: 'Editor content|a-scratch.txt' });
    const before = headerOf(read.text) ?? fail('APP_HEADER_MISSING');
    const ref = editorRefOf(read.text, 'a-scratch.txt') ?? fail('EDITOR_NOT_FOUND');
    await c.act(c.tab(), [{ do: 'press', ref, key: 'Meta+Shift+S' }], { allowPark: true });
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
    const ref = await c.openScratch();
    const before = { ...c.driver.identity() };
    if (!Number.isSafeInteger(before.pid) || before.pid <= 0 || typeof before.pidBirth !== 'string' || !before.pidBirth ||
        typeof before.instance !== 'string' || !before.instance) fail('REVOKE_IDENTITY_MISSING');
    const rows = await c.list(), original = rows.filter(row => row.tab === c.tab());
    if (original.length !== 1 || original[0].parked || !Number.isSafeInteger(original[0].window) || original[0].window <= 0 ||
        rows.filter(row => row.window === original[0].window).length !== 1) fail('REVOKE_WINDOW_NOT_UNIQUE');
    const window = original[0].window;
    const tag = Math.random().toString(36).slice(2, 6), markers = Array.from({ length: 6 }, (_, i) => `rv${tag}${i}`);
    const pending = c.tool('browser_act', { tab: c.tab(), steps: markers.flatMap(text => [{ do: 'type', ref, text: text + ' ' }, { do: 'wait', ms: 250 }]), observe: 'none' });
    await c.sleep(300);
    await c.driver.revoke();
    const r = await pending;
    // The product reports a batch the host stopped as an error naming the park (electron-handoff.mjs parkedSummary).
    const parkedReported = r.isError === true && /ELECTRON_PARKED: revoked\b/.test(r.text);
    if (!parkedReported) throw Object.assign(Error('REVOKE_NOT_REPORTED'), { detail: {
      isError: !!r.isError, parkedReported, unavailableReported: /unavailable/i.test(r.text),
    } });
    const refused = await c.tool('browser_tabs', { do: 'list' });
    if (!refused.isError) fail('REVOKED_CALL_ANSWERED');
    // Resume cannot revive the revoked provider channel. A new turn reuses the session grant and mints new tab refs.
    const card = await c.driver.reconnect({ consentWaitMs: c.options.consentWaitMs });
    c.consent(card, 'revoke');
    if (card?.status !== 'granted') fail('REVOKE_RECONNECT_CONSENT_REQUIRED');
    const after = c.driver.identity();
    if (after?.pid !== before.pid || after?.pidBirth !== before.pidBirth || after?.instance !== before.instance) fail('REVOKE_RECONNECT_IDENTITY_CHANGED');
    const joined = (await c.list()).filter(row => row.window === window);
    if (joined.length !== 1 || joined[0].parked) fail('REVOKE_RECONNECT_WINDOW_NOT_UNIQUE');
    c.state.tab = joined[0].tab;
    const text = (await c.read(c.tab(), { find: 'rv|Editor content' })).text;
    const replays = markers.filter(m => text.split(m).length > 2).length;
    if (replays) fail(`REPLAYED: ${replays}`);
    return { detail: { replays, present: markers.filter(m => text.includes(m)).length } };
  } },
  { id: 'disconnect', apps: ['vscode'], editor: true, async run(c) {
    const r = await c.driver.disconnect();
    c.state.disconnectParked = parkedReceipt(r.parked);
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
    const op = async (kind, tab, ref) => {
      const r = kind === 'list' ? await c.tool('browser_tabs', { do: 'list' }) : kind === 'read' ? await c.tool('browser_read', { tab, max_chars: 8000 })
        : await c.tool('browser_act', { tab, steps: [{ do: 'press', ref, key: 'Escape' }], observe: 'none' });
      if (r.isError) throw Object.assign(Error(`${kind.toUpperCase()}_FAILED: ${first(r.text)}`), { detail: { snapshotFailure: r.snapshotFailure ?? null } });
      return r.ms;
    };
    // Each cold sample is a new turn in the live worker: release and select again on the session grant, so no card.
    for (const kind of Object.keys(kinds)) {
      for (let i = 0; i < Math.min(c.options.samples, c.options.coldSamples); i++) {
        if (kind === 'act') await c.openScratch();
        c.consent(await c.driver.reconnect({ consentWaitMs: c.options.consentWaitMs }), 'timings');
        const rows = kind === 'list' ? [] : await c.list();
        const tab = kind === 'list' ? undefined : (rows.find(row => !row.parked && row.window === c.state.workspaceWindow)
          ?? rows.find(row => !row.parked))?.tab ?? fail('NO_JOINED_APP_TAB');
        const ref = kind === 'act' ? editorRefOf((await c.read(tab, { find: 'Editor content|a-scratch.txt' })).text, 'a-scratch.txt') ?? fail('EDITOR_NOT_FOUND') : undefined;
        kinds[kind].cold.push(await op(kind, tab, ref));
      }
      const ref = kind === 'act' ? await c.openScratch() : undefined;
      const tab = kind === 'act' ? c.tab() : (await c.list()).find(row => !row.parked)?.tab;
      for (let i = 0; i < c.options.samples; i++) kinds[kind].warm.push(await op(kind, tab, ref));
      c.state.tab = tab ?? c.state.tab;
    }
    for (const [kind, v] of Object.entries(kinds)) c.timings[kind] = { scope: 'tool-call', cold: timingSummary(v.cold), warm: timingSummary(v.warm) };
    return { number: c.timings.read.warm.p50, unit: 'ms warm read p50' };
  } },
  { id: 'contention', apps: ['vscode'], editor: true, async run(c) {
    // Sessions over one host: this one keeps acting, the others refuse busy before their card asks the owner anything.
    const rows = [];
    for (const workers of [1, 4]) rows.push({ workers, ...await c.driver.contention(workers) });
    const bad = rows.find(row => row.ok !== 1 || row.busy !== row.workers - 1 || row.other !== 0 || row.cards);
    if (bad) fail(`CONTENTION: ${bad.workers} sessions gave ${bad.ok} ok, ${bad.busy} busy, ${bad.other} other, ${bad.cards} cards`);
    return { number: rows.reduce((sum, row) => sum + row.busy, 0), unit: 'busy refusals', detail: rows };
  } },
  { id: 'quit', async run(c) {
    if (c.state.noConnection) fail('NOTHING_LAUNCHED');
    c.state.quitConfirmed = false;
    const r = await c.driver.quit();
    c.state.quitConfirmed = r.exited && !r.censusLeft && r.profileRemoved;
    if (!r.exited) throw Object.assign(Error('APP_QUIT_UNCONFIRMED'), { detail: r });
    if (r.censusLeft) fail(`CENSUS_LEFT: ${r.censusLeft}`);
    if (!r.profileRemoved) fail('PROFILE_NOT_REMOVED');
    return { number: r.ms, unit: 'ms', detail: { censusLeft: 0, profileRemoved: true } };
  } },
  { id: 'host-kill', apps: ['vscode'], async run(c) {
    if (c.state.noConnection) fail('NOTHING_LAUNCHED');
    if (c.state.quitConfirmed === false) fail('PREVIOUS_QUIT_UNCONFIRMED');
    // A second instance, so Quit above ran with a live host. Recorded either way: whether the app survives its host.
    const launched = await c.driver.connect({ consentWaitMs: c.options.consentWaitMs });
    c.consent(launched.card, 'host-kill');
    if (launched.card.status !== 'granted') fail('CONSENT_NEEDS_OWNER');
    const killed = await c.driver.killHost();
    let refusal, secondLaunchProbed = false;
    if (killed.appAlive) {
      refusal = await c.driver.secondLaunch();
      secondLaunchProbed = true;
      if (!/OWNERSHIP_UNRESOLVED/.test(refusal.code ?? '') && !(refusal.code === 'ELECTRON_OWNERSHIP_FREE' && refusal.appExited === true))
        fail(`SECOND_LAUNCH_NOT_REFUSED: ${refusal.code}`);
      if (await c.driver.appAlive()) await c.driver.quitByPid();
    } else if (killed.appExited !== true) fail('HOST_LOSS_APP_EXIT_UNCONFIRMED');
    if (!(await c.driver.collect()).absent) fail('COLLECT_ABSENCE_UNPROVED');
    const after = await c.driver.reconcile();
    if (after.code) fail(`RECONCILE_AFTER_COLLECT: ${after.code}`);
    return { detail: { appSurvived: killed.appAlive, secondLaunchProbed, refusal: refusal?.code ?? null, coldLaunchMs: launched.launch.ms } };
  } },
].map(cell => Object.freeze(cell)));

// ---- the relaunch flow (1.3.1): turbo on the owner's own app and profile. Each cell is a behaviour that depends on the app,
// so each build qualifies it separately. They run dry here; live, only in a run the owner watches, since they quit and
// reopen the owner's own app (no live driver yet). The harness never answers a card or the app's own prompts.
export const RELAUNCH_CELLS = Object.freeze([
  { id: 'relaunch-card', measures: 'the debugger card, then the relaunch card naming the running process; only the owner clicks', async run(c) {
    const r = c.state.relaunched = await c.driver.relaunch({ consentWaitMs: c.options.consentWaitMs });
    c.consent(r.card.debugger, 'relaunch-card'); c.consent(r.card.relaunch, 'relaunch-card');
    if (r.error) fail(r.error);
    if (r.card.relaunch.status !== 'granted') { c.state.noConnection = true; fail(r.card.relaunch.status === 'timeout' ? 'CONSENT_NEEDS_OWNER: no click on the relaunch card' : 'RELAUNCH_' + String(r.card.relaunch.status).toUpperCase()); }
    if (r.before.pid === r.pid) fail('SAME_PROCESS: the app was not reopened');
    return { number: r.ms, unit: 'ms', detail: { before: { windows: r.before.windows } } };
  } },
  { id: 'relaunch-quit', measures: 'how the app quits: NSRunningApplication terminate accepted, exit time, and whether macOS asked for a permission', async run(c) {
    const q = (c.state.relaunched ?? fail('NOT_RELAUNCHED')).quit;
    if (q.outcome !== 'exited') fail('QUIT_' + String(q.outcome).toUpperCase());
    return { number: q.ms, unit: 'ms', detail: { outcome: q.outcome, permissionPrompt: q.prompt === true } };
  } },
  { id: 'relaunch-unsaved', measures: 'what the app does with unsaved work at its own Quit: asks (sleight waits), keeps it across the reopen, or loses it', async run(c) {
    const outcome = (c.state.relaunched ?? fail('NOT_RELAUNCHED')).unsaved;
    if (!['prompt', 'kept', 'none'].includes(outcome)) fail('UNSAVED_WORK_' + String(outcome).toUpperCase());
    return { detail: { outcome } };
  } },
  { id: 'relaunch-pipe', measures: 'the reopened app takes the debugger pipe on its normal profile instead of handing off to another copy', async run(c) {
    const r = c.state.relaunched ?? fail('NOT_RELAUNCHED'), id = c.driver.identity();
    if (!r.pipe) fail('NO_PIPE: the app came back without the debugger connection');
    if (r.profile?.temporary !== false) fail('NOT_THE_OWN_PROFILE');
    if (r.tcpListeners !== 0) fail(`TCP_LISTENER: ${r.tcpListeners}`);
    if (!id || id.pid !== r.pid || id.pidBirth !== r.pidBirth) fail('CONNECT_IDENTITY_MISMATCH');
    return { detail: { tcpListeners: 0, profile: 'own' } };
  } },
  { id: 'relaunch-background', input: 'record', measures: 'whether macOS or the app activates the reopened app; recorded, never undone', async run(c) {
    const r = c.state.relaunched ?? fail('NOT_RELAUNCHED');
    return { number: r.activated ? 1 : 0, unit: 'activations', detail: { activated: r.activated === true, wasFront: r.wasFront === true } };
  } },
  { id: 'relaunch-restore', measures: 'the windows the app restores on its own, joined within restoreWaitMs', async run(c) {
    const r = c.state.relaunched ?? fail('NOT_RELAUNCHED');
    if (!(r.joinedAfter >= 1)) fail('NO_WINDOW_RESTORED');
    const rows = await c.list(), joined = rows.filter(row => !row.parked);
    if (!joined.length) fail('NO_JOINED_APP_TAB');
    c.state.tab = joined[0].tab;
    return { number: r.joinedAfter, unit: 'windows', detail: { before: r.before.windows, after: r.joinedAfter } };
  } },
  { id: 'relaunch-reuse', measures: 'the next turn reaches the same process with no card and no launch', async run(c) {
    const before = c.driver.identity(), next = await c.driver.nextTurn();
    c.consent(next.card, 'relaunch-reuse');
    const after = c.driver.identity();
    if (next.launched || next.card?.requested || next.card?.shown) fail('REUSE_ASKED_OR_LAUNCHED');
    if (after.pid !== before.pid || after.pidBirth !== before.pidBirth) fail('RECONNECT_IDENTITY_CHANGED');
    return { detail: { card: false, launched: false } };
  } },
  { id: 'relaunch-user-quit', measures: 'the owner\'s own Quit later: the app exits with the pipe attached, the host collects, the profile stays as it was', async run(c) {
    const r = await c.driver.userQuit({ waitMs: c.options.consentWaitMs });
    if (!r.exited) fail('APP_QUIT_UNCONFIRMED');
    if (!r.collected || !r.recordRemoved) fail('LAUNCH_RECORD_LEFT');
    if (!r.profileUntouched) fail('PROFILE_CHANGED');
    return { number: r.ms, unit: 'ms', detail: { collected: true, recordRemoved: true, profileUntouched: true } };
  } },
  { id: 'relaunch-host-loss', measures: 'when sleight\'s host dies, the owner\'s app keeps running with its unsaved work, and the restarted host reattaches or releases it', async run(c) {
    // Reopens the app once more (the owner clicks both cards again), then the driver kills the host and the next turn restarts
    // it. The pipe keeper holds the pipe meanwhile. Run with nothing unsaved that matters, in case it does not.
    // restarted: 'reattached' (the next turn reaches the same process) or 'released' (another server's secret: the app stays
    // the user's until they quit it, and ownership is then freed).
    const r = await c.driver.hostLoss({ consentWaitMs: c.options.consentWaitMs });
    c.consent(r.card?.debugger, 'relaunch-host-loss'); c.consent(r.card?.relaunch, 'relaunch-host-loss');
    if (typeof r.appSurvived !== 'boolean' || !['kept', 'lost', 'none'].includes(r.unsaved) || typeof r.prompt !== 'boolean' || typeof r.restarted !== 'string') fail('HOST_LOSS_UNMEASURED');
    if (!r.appSurvived) fail('APP_QUIT_ON_HOST_LOSS');
    if (r.unsaved === 'lost') fail('UNSAVED_WORK_LOST');
    if (!['reattached', 'released'].includes(r.restarted)) fail('HOST_LOSS_NOT_RECOVERED');
    return { number: 1, unit: 'app survived', detail: { appSurvived: true, unsaved: r.unsaved, prompt: r.prompt, restarted: r.restarted } };
  } },
].map(cell => Object.freeze(cell)));

export const cellsFor = app => CELLS.filter(cell => !cell.apps || cell.apps.includes(app.key));
export const relaunchCellsFor = app => RELAUNCH_CELLS.filter(cell => !cell.apps || cell.apps.includes(app.key));
export const requiredCells = (app, { relaunch = false } = {}) => (relaunch ? relaunchCellsFor(app) : cellsFor(app)).map(cell => cell.id);
const appFor = bundleId => Object.values(APPS).find(app => app.bundleId === bundleId);

export async function waitForHold(io, clock, intervalMs = 30000, signal) {
  let held = 0;
  checkRunSignal(signal);
  while (io.exists(HOLD)) { await interruptibleWait(clock.sleep(intervalMs), signal); checkRunSignal(signal); held += intervalMs; }
  return held;
}

function context({ app, driver, clock, options, state, timings, consentLog }) {
  const c = {
    app, driver, options, state, timings, windows: [], now: clock.now, sleep: ms => clock.sleep(ms),
    tab: () => state.tab ?? fail('NO_APP_TAB'),
    consent(card, cell) { if (card) consentLog.push({ cell, requested: card.requested === true || card.shown === true,
      shown: card.shown ?? null, requestedAt: card.requestedAt ?? null, by: card.by ?? null, status: card.status ?? null, scope: card.scope ?? null, ms: card.ms ?? null }); },
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
    async read(tab, extra = {}) {
      const r = await c.tool('browser_read', { tab, ...extra });
      c.reads ??= [];
      c.reads.push({ at: clock.now(), tab, ...extra, isError: !!r.isError, chars: r.text.length,
        cut: /^# Cut:/m.test(r.text), text: r.text.slice(0, 6000) });
      if (c.reads.length > 12) c.reads.shift();
      if (r.isError) throw Object.assign(Error(first(r.text)), { detail: { tab, snapshotFailure: r.snapshotFailure ?? null } });
      return r;
    },
    openScratch: () => c.openFile('a-scratch.txt'),
    async openFile(name) {
      const rows = await c.list(), row = rows.find(row => row.window === state.workspaceWindow && !row.parked)
        ?? rows.find(row => row.tab === state.tab && !row.parked) ?? fail('WORKSPACE_WINDOW_NOT_FOUND');
      state.tab = row.tab;
      const text = (await c.read(c.tab(), { find: name })).text;
      const ref = refOf(text, new RegExp('tab "' + escaped(name) + '(?:"|,)'))
        ?? refOf(text, new RegExp('treeitem "' + escaped(name) + '"')) ?? fail('FILE_ROW_NOT_FOUND: ' + name);
      await c.act(c.tab(), [{ do: 'click', ref }]);
      let editor;
      await c.until(async () => (editor = editorRefOf((await c.read(c.tab(), { find: 'Editor content|' + name })).text, name)), 5000);
      if (!editor) {
        // The normal editor query omits this VS Code prerequisite warning. Diagnose only after its unchanged deadline.
        const text = (await c.read(c.tab(), { find: 'The editor is not accessible at this time|' + name })).text;
        const tab = new RegExp('tab "' + escaped(name) + '(?:"|,)');
        if (text.split('\n').some(line => tab.test(line) && /\[selected\]/.test(line)) &&
            /^\s*- textbox "The editor is not accessible at this time\. To enable screen reader optimized mode, use Shift\+Option\+F1"(?:\s|$)/m.test(text))
          fail('EDITOR_ACCESSIBILITY_REQUIRED');
        fail('EDITOR_NOT_FOUND');
      }
      return editor;
    },
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
  c.reads = [];
  let preparationError;
  if (cell.prepare) {
    const started = clock.now();
    let detail;
    try { detail = await cell.prepare(c); }
    catch (error) { preparationError = error; }
    record.setup = { ms: clock.now() - started, ...(detail ? { detail } : {}), ...(preparationError ? { error: preparationError.message,
      ...(preparationError.detail ? { detail: preparationError.detail } : {}) } : {}) };
  }
  if (cell.input) {
    const id = driver.identity();
    if (id && await observer.frontPid?.() === id.pid) { await driver.frontApp(); record.refocused = true; } // before the cell's window
  }
  const start = clock.now();
  let out = {};
  try {
    if (preparationError) throw preparationError;
    out = await cell.run(c) ?? {};
    record.status = 'pass';
  } catch (error) {
    record.error = String(error?.message ?? error).slice(0, 300);
    if (error.stage) record.stage = error.stage;
    if (error.detail) record.detail = error.detail;
  }
  const end = clock.now();
  record.startMs = start;
  record.endMs = end;
  record.reads = c.reads;
  record.ms = end - start;
  if (out.number !== undefined) { record.number = out.number; record.unit = out.unit; }
  if (out.detail !== undefined) record.detail = out.detail;
  const id = driver.identity();
  if (id) record.identity = { pid: id.pid, pidBirth: id.pidBirth, instance: id.instance, epoch: id.epoch };
  record.windows = c.windows;
  const samples = await observer.samples(start, end);
  const fixturePids = driver.fixturePids?.() ?? [];
  const evidence = backgroundEvidence(samples, { startMs: start, endMs: end, fixturePid: id?.pid, fixturePids });
  // The owner permits these benchmark direct launches, bounded by the measured first window plus two seconds.
  const launches = !c.options.relaunch && c.app.key === 'vscode' && ['consent-card', 'host-kill'].includes(cell.id) && !cell.input
    ? (driver.launchWindows?.() ?? []).filter(w => Number.isFinite(w.execMs) && Number.isFinite(w.firstWindowMs) &&
      w.execMs >= start && w.firstWindowMs >= w.execMs && w.endMs === w.firstWindowMs + 2000 &&
      w.endMs <= end && (w.pid === id?.pid || fixturePids.includes(w.pid)) &&
      backgroundEvidence(samples, { startMs: w.execMs, endMs: w.endMs, fixturePid: w.pid }).covered) : [];
  const allowed = s => launches.some(w => s.front === w.pid && s.t >= w.execMs && s.t <= w.endMs);
  evidence.unexpectedFixtureFront = samples.filter(s => s.t >= start && s.t <= end &&
    (s.front === id?.pid || fixturePids.includes(s.front)) && !allowed(s)).length;
  for (const w of launches) {
    const frontmostSamples = samples.filter(s => s.t >= w.execMs && s.t <= Math.min(end, w.endMs));
    c.state.launchFindings.push({ kind: 'benchmark-direct-launch', ...w, frontmostSamples,
      background: backgroundEvidence(samples, { startMs: w.execMs, endMs: Math.min(end, w.endMs), fixturePid: w.pid }) });
  }
  record.background = evidence;
  if (!c.options.relaunch && evidence.unexpectedFixtureFront > 0) {
    record.detail = { ...record.detail, ...(record.error ? { startupError: record.error } : {}), focusTaken: true };
    Object.assign(record, { status: 'fail', error: `BACKGROUND_FOCUS_TAKEN: ${evidence.unexpectedFixtureFront} samples` });
  }
  if (cell.input === 'record') record.detail = { ...record.detail, focusTaken: evidence.fixtureFront > 0 };
  if (cell.input === true && record.status === 'pass') {
    const problem = !evidence.covered ? `BACKGROUND_UNPROVED: sampler gap ${evidence.maxGapMs} ms`
      : evidence.fixtureFront ? `BACKGROUND_FOCUS_TAKEN: ${evidence.fixtureFront} samples`
      : evidence.pointerMovedPx ? `BACKGROUND_POINTER_MOVED: ${evidence.pointerMovedPx} px`
      : out.expectFront !== undefined && evidence.frontPids.some(pid => pid !== out.expectFront) ? 'BACKGROUND_FRONT_CHANGED' : null;
    if (out.expectFront !== undefined) record.detail = { ...record.detail, otherFront: !problem };
    if (problem) Object.assign(record, { status: 'fail', error: problem });
  }
  // Include failures decided by the background gate, as well as startup failures and unexpected fixture focus.
  if (record.status === 'fail' || evidence.unexpectedFixtureFront > 0)
    evidence.frontmostSamples = samples.filter(s => s.t >= start && s.t <= end);
  if (record.status === 'fail') {
    try { record.broker = await driver.status?.() ?? null; }
    catch { record.broker = null; }
  }
  if (cell.id === 'disconnect' && c.state.disconnectParked) record.parked = c.state.disconnectParked;
  return record;
}

export async function runQualification({ app, driver, observer, io, clock, cells, options = {} }) {
  const opts = { trials: 10, samples: 20, coldSamples: 5, aliveWaitMs: 60000, consentWaitMs: 120000, mode: 'live', relaunch: false, ...options };
  const signal = opts.signal, originalClock = clock;
  driver = cancellableDriver(driver, signal);
  clock = { ...clock, sleep: ms => interruptibleWait(originalClock.sleep(ms), signal) };
  cells ??= opts.relaunch ? relaunchCellsFor(app) : cellsFor(app);
  // A relaunch run is on the owner's own profile by design; every other run is the benchmark's temporary one (LAWS).
  const receipt = { version: 1, kind: opts.relaunch ? 'electron-relaunch' : 'electron-qualification', mode: opts.mode, at: new Date(clock.now()).toISOString(),
    app: { name: app.name, bundleId: app.bundleId }, profile: { temporary: !opts.relaunch }, cells: [], timings: {}, heldMs: 0,
    // LAWS: only the user's click answers sleight's debugger card. The harness waits for it and never presses it.
    consent: { harnessClicks: false, cards: [] }, launchFindings: [], sampling: { intervalMs: SAMPLE_MS }, options: { trials: opts.trials, samples: opts.samples, coldSamples: opts.coldSamples, aliveWaitMs: opts.aliveWaitMs } };
  const state = { launchFindings: receipt.launchFindings }, c = context({ app, driver, clock, options: opts, state, timings: receipt.timings, consentLog: receipt.consent.cards });
  let stopped;
  const stop = async before => { const prompt = await io.permission(); if (prompt) stopped = { reason: 'permission-prompt', process: prompt.process, title: prompt.title, before }; return !!prompt; };
  try {
    checkRunSignal(signal); await observer.start?.(); checkRunSignal(signal);
    for (const cell of cells) {
      checkRunSignal(signal);
      if (!stopped) receipt.heldMs += await waitForHold(io, clock, 30000, signal);
      if (stopped?.reason === 'startup-failed') { receipt.cells.push({ id: cell.id, status: 'skipped', reason: 'STARTUP_FAILED' }); continue; }
      if (stopped || await stop(cell.id)) { receipt.cells.push({ id: cell.id, status: 'stopped' }); continue; }
      if (state.noConnection) { receipt.cells.push({ id: cell.id, status: 'skipped', reason: 'NO_CONNECTION' }); continue; }
      if (cell.editor && state.skipEditor) { receipt.cells.push({ id: cell.id, status: 'skipped', reason: 'OVERLAY_NOT_CLEARED' }); continue; }
      c.windows = [];
      const record = await runCell(cell, c, { driver, observer, clock });
      receipt.cells.push(record);
      checkRunSignal(signal);
      if (['consent-card', 'connect', 'relaunch-card'].includes(cell.id) && record.status === 'fail')
        stopped = { reason: 'startup-failed', before: cell.id, error: record.error, ...(record.stage ? { stage: record.stage } : {}) };
    }
    if (!stopped) await stop('cleanup');
  } catch (error) {
    if (!signal?.aborted) throw error;
    receipt.interrupted = true; stopped = { reason: 'interrupted' };
  } finally {
    // Cleanup quits and removes only what this run launched; the owner's instances are never addressed.
    if (opts.lifecycle?.cleanupAllowed === false) receipt.cleanup = { confirmed: false, error: 'RUN_CANCELLATION_UNSETTLED' };
    else {
      try { receipt.cleanup = await driver.cleanup(); } catch (error) { receipt.cleanup = { confirmed: false, error: String(error?.message ?? error) }; }
      if (opts.lifecycle?.cleanupAllowed !== false) await observer.stop?.();
    }
  }
  if (stopped) receipt.stopped = stopped;
  Object.assign(receipt.app, driver.build?.() ?? {});
  receipt.fixtureLaunches = driver.launchWindows?.() ?? [];
  receipt.profile.removed = receipt.cleanup?.profileRemoved === true;
  receipt.qualified = false;
  // The check reads what writeReceipt writes: the scrubbed receipt, so a home path in error text is not a leak.
  receipt.validation = validateReceipt(scrubReceipt(receipt));
  receipt.qualified = receipt.validation.qualified;
  return receipt;
}

// ---- receipt checks (contracts, EPV3-8 item 4). errors reject the receipt; unqualified only withholds qualification.
const SECRET_KEYS = new Set(['secret', 'adminSecret', 'ticket', 'token', 'socket', 'handle']);
function hasSecretKey(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => SECRET_KEYS.has(key) || hasSecretKey(item));
}
export function validateReceipt(receipt, { required = requiredCells(appFor(receipt?.app?.bundleId) ?? APPS.vscode, { relaunch: receipt?.kind === 'electron-relaunch' }) } = {}) {
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
    if (cell.id === 'new-window' && cell.status === 'pass' &&
        (cell.detail?.joined !== 2 || cell.detail?.falseJoins !== 0 || new Set((cell.windows ?? []).map(w => w.id)).size !== 2))
      unqualified.push('MULTI_WINDOW_UNMEASURED');
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
  if (receipt?.profile?.temporary !== (receipt?.kind !== 'electron-relaunch')) errors.push('ISOLATION_FAILED');
  if (receipt?.consent?.harnessClicks !== undefined && receipt.consent.harnessClicks !== false) errors.push('HARNESS_CLICKED_CONSENT');
  if (receipt?.mode === 'dry-run') unqualified.push('DRY_RUN');
  if (receipt?.interrupted === true) unqualified.push('RUN_INTERRUPTED');
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
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
    [k, k === 'parked' ? parkedReceipt(v) : scrubReceipt(v, { home, user })]));
  return value;
}

export function parseArgs(argv) {
  const out = { apps: ['vscode'], samples: 20, trials: 10, aliveWaitMs: 60000, consentWaitMs: 120000, out: undefined, mode: undefined };
  const numbers = { '--samples': 'samples', '--trials': 'trials', '--alive-wait-ms': 'aliveWaitMs', '--consent-wait-ms': 'consentWaitMs' };
  let dry = false, away = false, relaunch = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = argv[i + 1];
    if (arg === '--dry-run') { dry = true; continue; }
    if (arg === '--owner-away') { away = true; continue; }
    if (arg === '--relaunch') { relaunch = true; continue; }
    if (!(arg in numbers) && arg !== '--apps' && arg !== '--out' || value === undefined || value.startsWith('--')) throw Error('INVALID_OPTIONS');
    i++;
    if (arg === '--apps') {
      out.apps = value.split(',');
      if (out.apps.some(key => !APPS[key])) throw Error('UNKNOWN_APP');
    } else if (arg === '--out') out.out = value;
    else { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw Error('INVALID_OPTIONS'); out[numbers[arg]] = n; }
  }
  if (dry && away) throw Error('CONFLICTING_MODE');
  if (relaunch && !dry) throw Error('RELAUNCH_NEEDS_OWNER: the relaunch cells quit and reopen the owner\'s own app and profile; they run with --dry-run here, and live only in a run the owner watches');
  if (!dry && !away) throw Error('OWNER_AWAY_REQUIRED: live cells show windows and may take focus; pass --owner-away in the away window, or --dry-run');
  out.mode = dry ? 'dry-run' : 'live';
  out.relaunch = relaunch;
  return out;
}

function writeReceipt(dir, receipt, app) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${app.key}-${receipt.kind === 'electron-relaunch' ? 'relaunch-' : ''}${receipt.mode}-${receipt.at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(scrubReceipt(receipt), null, 2) + '\n');
  return path;
}
const summaryLine = (app, r) => `${app.key}: ${r.cells.filter(c => c.status === 'pass').length}/${r.cells.length} cells passed, qualified ${r.qualified}` +
  (r.validation.errors.length ? `, receipt errors ${r.validation.errors.join(' ')}` : '') + (r.stopped ? `, stopped: ${r.stopped.reason}` : '');

async function runMain(argv, deps, qualificationDiagnosticPath) {
  const options = parseArgs(argv), log = deps.log ?? console.log, write = deps.write ?? writeReceipt;
  const clock = deps.clock ?? { now: Date.now, sleep: ms => delay(ms) };
  const out = options.out ?? fileURLToPath(new URL(`./results/electron/${new Date(clock.now()).toISOString().slice(0, 10)}/`, import.meta.url));
  const runOptions = { trials: options.trials, samples: options.samples, aliveWaitMs: options.aliveWaitMs, consentWaitMs: options.consentWaitMs, mode: options.mode,
    relaunch: options.relaunch === true };
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
    runtime = await (deps.liveRuntime ?? (async (...args) => (await import('./electron-qualification-live.mjs')).liveRuntime(...args)))(options, { io, clock, qualificationDiagnosticPath });
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

export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  if (options.mode === 'dry-run') return runMain(argv, deps);
  const { withQualificationDiagnostics } = await import('./electron-diagnostics.mjs');
  const clock = deps.clock ?? { now: Date.now };
  const out = options.out ?? fileURLToPath(new URL(`./results/electron/${new Date(clock.now()).toISOString().slice(0, 10)}/`, import.meta.url));
  return withQualificationDiagnostics(out, path => runMain(argv, deps, path));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
