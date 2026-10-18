// Fakes for --dry-run and the tests: a driver that answers the five tools the way epv3-contracts.md says the app path
// answers them, and a 50 ms frontmost/pointer sampler. Nothing here launches, reads or touches anything outside memory.
import { APPS } from './electron-qualification.mjs';

const REFUSED_KEYS = new Set(['Meta+Q', 'Meta+W', 'Meta+H', 'Meta+M', 'Meta+Shift+W', 'Meta+Alt+H', 'Control+Meta+F']);
const tick = () => new Promise(resolve => setImmediate(resolve));
const error = text => ({ text, isError: true, ms: 1 });

export function fakeDriver({ now = Date.now, app = APPS.vscode, overlay = { present: false, clears: true }, pid = 501, otherPid = 90 } = {}) {
  let instance = 0, connected = false, revoked = false, alive = false, ownership = 'free', current, last;
  let windows, joinNo, readJoin, parked, ui, editorText;
  const files = { 'a-scratch.txt': '' };
  const driver = { calls: [], quitByPidCalls: 0 };
  const hex = n => 't' + n.toString(16).padStart(32, '0');
  const tabs = () => windows.map((w, i) => ({ tab: hex(w.id), w, parked: i === 0 ? parked : null }));
  const launch = () => {
    instance++;
    const p = pid + instance - 1;
    current = last = { pid: p, pidBirth: `birth-${p}`, instance: `inst-${instance}`, epoch: 1 };
    windows = [{ id: 4000 + instance * 100, epoch: 1 }];
    joinNo = 1; readJoin = 0; parked = null; editorText = '';
    ui = { scratch: false, notes: false, quick: false, terminal: false, preview: false, overlay: overlay.present };
    alive = true; ownership = 'owned';
  };
  const card = () => ({ shown: true, by: 'user', status: 'granted', scope: 'session', ms: 40 });

  function read({ tab }) {
    const row = tabs().find(r => r.tab === tab);
    if (!row) return error('Unknown tab. Use browser_tabs list.');
    readJoin = joinNo;
    const lines = [`# ${app.name} 1.141.0 (pid ${current.pid}) window ${row.w.id} epoch ${row.w.epoch}, join ${joinNo} ${row.parked ? 'parked: ' + row.parked : 'joined'}`,
      '# Document: vscode-file://vscode-app (app document)',
      '- treeitem "a-notes.md" [ref=e1]', '- treeitem "a-scratch.txt" [ref=e2]'];
    if (ui.scratch) lines.push('- tab "a-scratch.txt" [ref=e8]', '- textbox "a-scratch.txt, Editor content" [ref=e3]', `- text: ${editorText.replaceAll('\n', ' ')}`);
    if (ui.quick) lines.push('- combobox "Search files by name" [ref=e4]');
    if (ui.terminal) lines.push('- textbox "Terminal 1, zsh" [ref=e5]');
    if (ui.preview) lines.push('- link "Item one" [ref=f1e6]');
    if (ui.overlay) lines.push('- dialog "Sign in to Cursor" [ref=e7]');
    return { text: lines.join('\n'), isError: false, ms: 3 };
  }
  async function act({ steps }) {
    if (parked) return error(`ELECTRON_PARKED: ${parked}. The app window needs native handling or a fresh read; nothing was sent`);
    if (readJoin !== joinNo) return error(`ELECTRON_STALE_READ: the app window changed since your last read (join ${joinNo}); read again before input`);
    const lines = [];
    for (const [i, step] of steps.entries()) {
      if (revoked) { lines.push(`${i + 1} ${step.do}: not sent. ELECTRON_PARKED: revoked`); break; }
      if (['reload', 'back', 'forward', 'navigate'].includes(step.do)) return error('ELECTRON_NATIVE_HANDOFF: reload, back, forward and navigate would reload the app window; nothing was sent');
      if (step.do === 'press' && REFUSED_KEYS.has(step.key)) return error('ELECTRON_APP_KEY_REFUSED: this key quits, closes, hides or resizes the app window; use the app itself');
      if (step.do === 'type' && step.ref === 'e5') return error('ELECTRON_TERMINAL_REFUSED: input to a terminal is refused on turbo, as the engine refuses it');
      if (step.do === 'click') { if (step.ref === 'e2') ui.scratch = true; if (step.ref === 'e1') ui.notes = true; }
      if (step.do === 'type' && step.ref === 'e3') editorText += step.text;
      if (step.do === 'press') {
        const key = step.key;
        if (key === 'Meta+P') ui.quick = true;
        if (key === 'Escape') { ui.quick = false; if (overlay.clears) ui.overlay = false; }
        if (key === 'Meta+S') files['a-scratch.txt'] = editorText;
        if (key === 'Meta+Shift+V' && ui.notes) ui.preview = true;
        if (key === 'Control+`') ui.terminal = !ui.terminal;
        if (key === 'Meta+Shift+N') windows.push({ id: windows.at(-1).id + 1, epoch: windows.length + 1 });
        if (key === 'Meta+Shift+S') { parked = 'native-modal'; lines.push(`${i + 1} press: sent. The app window then parked: native-modal. Read before continuing.`); break; }
      }
      lines.push(`${i + 1} ${step.do}: ok`);
      await tick();
    }
    return { text: lines.join('\n'), isError: false, ms: 5 };
  }

  return Object.assign(driver, {
    async connect() { launch(); connected = true; revoked = false;
      return { card: card(), launch: { pid: current.pid, pidBirth: current.pidBirth, ms: 900 }, connect: { ms: 120, tcpListeners: 0 } }; },
    async restart() { await driver.quit(); return driver.connect(); },
    identity: () => current ?? last ?? { pid, pidBirth: `birth-${pid}`, instance: 'inst-0', epoch: 1 },
    async tool(name, args) {
      driver.calls.push({ name, args });
      if (!connected) return error('Turbo is not connected. V3_WORKER_UNAVAILABLE');
      if (revoked && name !== 'browser_act') return error('ELECTRON_PARKED: revoked. Nothing was sent');
      if (name === 'browser_tabs') return { text: tabs().map(r => `${r.tab} ${app.name} window ${r.w.id} ${r.parked ? 'parked: ' + r.parked : 'joined'} join ${joinNo}`).join('\n'), isError: false, ms: 2 };
      if (name === 'browser_read') return read(args);
      if (name === 'browser_act') return act(args);
      if (name === 'browser_open') return error('ELECTRON_NATIVE_HANDOFF: an app window cannot open arbitrary URLs; nothing was sent');
      return error('unsupported in the fake');
    },
    async frontApp() { return { pid: otherPid, bundle: 'com.apple.Terminal' }; },
    async ownerInstances() { return 1; },
    async windowOwners(ids) { return Object.fromEntries(ids.map(id => [id, windows.some(w => w.id === id) ? current.pid : 0])); },
    async geometry() { return { delta: { width: 0, height: 28 }, zoomLevel: 0, scaleMatch: true }; },
    async nativeSheetCancel() { if (!parked) return { pressed: false }; parked = null; joinNo++; return { pressed: true }; },
    readFile: name => files[name] ?? '',
    async appAlive() { return alive; },
    async revoke() { revoked = true; },
    async resume() { revoked = false; },
    async disconnect() { connected = false; return { appAlive: alive, pipeRetained: ownership === 'owned' }; },
    async reconnect() { connected = true; readJoin = 0; return card(); },
    async killWorker() { connected = false; return { killed: true }; },
    async killHost() { connected = false; ownership = 'unresolved'; return { appAlive: alive }; },
    async reconcile() { return { code: ownership === 'unresolved' ? 'ELECTRON_OWNERSHIP_UNRESOLVED' : null }; },
    async quitByPid() { driver.quitByPidCalls++; alive = false; return { exited: true }; },
    async collect() { if (alive) return { absent: false }; ownership = 'free'; return { absent: true }; },
    async contention(n) { return { ok: 1, busy: n - 1, other: 0 }; },
    async quit() { alive = false; connected = false; ownership = 'free'; current = undefined; return { exited: true, ms: 800, censusLeft: 0, profileRemoved: true }; },
    async cleanup() { alive = false; connected = false; return { confirmed: true, appExited: true, profileRemoved: true, left: [] }; },
    build: () => ({ version: '1.141.0', sha256: 'f'.repeat(64), signer: 'fake signer', cdhash: '0'.repeat(40), fake: true }),
  });
}

// Synthetic 50 ms samples between any two times. front(t) and pointerAt(t) shape them.
export function fakeObserver({ now = Date.now, fixturePid = () => 501, front = () => 90, pointerAt = () => 0, intervalMs = 50 } = {}) {
  return {
    async start() {}, async stop() {},
    async frontPid() { return front(now()); },
    async samples(start, end) {
      const out = [];
      for (let t = start; t <= end; t += intervalMs) out.push({ t, front: front(t), x: 100 + pointerAt(t), y: 100 });
      if (!out.length || out.at(-1).t !== end) out.push({ t: end, front: front(end), x: 100 + pointerAt(end), y: 100 });
      return out;
    },
    fixturePid,
  };
}
