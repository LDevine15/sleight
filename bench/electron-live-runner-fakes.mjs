// Fakes for electron-live-runner.mjs --dry-run and its tests: every phase runs against electron-qualification-fakes.mjs on a
// virtual clock, writes its cards to the run's card log the way the live worker does, and touches nothing outside memory
// and the receipt folder. Dry-run receipts are never qualified.
import { CARD_TTL_MS, cardLine } from './electron-cards.mjs';
import { fakeDriver, fakeObserver } from './electron-qualification-fakes.mjs';
import { runQualification } from './electron-qualification.mjs';
import { armPrompt, createCardWatcher, gradeArm, liveRelaunchCells, preflight, writeReceipt } from './electron-live-runner.mjs';

export function fakeIo(over = {}) {
  return { platform: 'darwin', exists: path => path !== '/tmp/sleight-hold', inspector: '/fake/inspect', armClaude: '/fake/claude', turboInstalled: async () => true,
    ownerCopies: async () => [], quarantined: async () => false, permission: async () => false, ...over };
}

// One card requested and answered at once, as the live worker logs it. temporary false offers Always allow.
export function logCard(cardLog, { kind = 'debugger', temporary = true, at = Date.now(), status = 'granted', scope = 'session' } = {}) {
  const id = `fake-${kind}-${at}-${Math.random().toString(36).slice(2, 6)}`;
  cardLine(cardLog, { event: 'requested', id, kind, at, requestedAt: at, deadlineAt: at + CARD_TTL_MS, temporary, app: 'Visual Studio Code' });
  cardLine(cardLog, { event: 'answered', id, kind, at: at + 40, status, scope: kind === 'relaunch' ? null : scope });
}

export function fakeRunnerDeps({ cardLog, out, write = true }) {
  let virtual = Date.now();
  const clock = { now: () => virtual, sleep: async ms => { virtual += ms; await new Promise(resolve => setImmediate(resolve)); } };
  const io = fakeIo();
  const save = (receipt, key) => write ? writeReceipt(out, receipt, key) : null;
  const options = { trials: 10, samples: 20, coldSamples: 5, aliveWaitMs: 60000, consentWaitMs: 120000, mode: 'dry-run' };
  // The live worker's cards: a new worker or process asks (connect, the reconnect after Disconnect or a killed worker); a
  // reconnect in the same worker reuses the session grant and asks nothing.
  const withCards = (driver, temporary) => {
    const { connect, reconnect, relaunch, disconnect, killWorker } = driver;
    let fresh = false;
    driver.connect = async (...args) => { logCard(cardLog, { temporary, at: clock.now() }); return connect(...args); };
    driver.disconnect = async (...args) => { fresh = true; return disconnect(...args); };
    driver.killWorker = async (...args) => { fresh = true; return killWorker(...args); };
    driver.reconnect = async (...args) => {
      const card = await reconnect(...args);
      if (fresh) { fresh = false; logCard(cardLog, { temporary, at: clock.now() }); return card; }
      return { shown: false, existing: true, status: 'granted', scope: 'session', by: 'existing' };
    };
    driver.relaunch = async (...args) => {
      logCard(cardLog, { temporary: false, scope: 'always', at: clock.now() });
      logCard(cardLog, { kind: 'relaunch', temporary: false, at: clock.now() + 50 });
      return relaunch(...args);
    };
    return driver;
  };
  const record = (receipt, key) => ({ status: receipt.validation.errors.length === 0 && receipt.cells.every(c => c.status === 'pass') ? 'pass' : 'fail',
    receipt: save(receipt, key), qualified: receipt.qualified, cells: `${receipt.cells.filter(c => c.status === 'pass').length}/${receipt.cells.length}`,
    failed: receipt.cells.filter(c => c.status === 'fail').map(c => `${c.id}: ${c.error}`), cleanup: receipt.cleanup });
  return {
    now: clock.now, sleep: clock.sleep, io, build: () => ({ commit: 'dry-run' }),
    watcher: createCardWatcher({ cardLog, outDir: out, log: () => {}, now: clock.now, write: () => {}, remove: () => {} }),
    preflight, lock: async () => async () => {},
    async qualify({ app }) {
      const driver = withCards(fakeDriver({ now: clock.now, app }), true);
      const receipt = await runQualification({ app, driver, observer: fakeObserver({ now: clock.now, fixturePid: () => driver.identity()?.pid }), io, clock, options });
      return record(receipt, app.key);
    },
    async arm() {
      logCard(cardLog, { temporary: true, at: clock.now() });
      const marker = 'armfake1', prompt = armPrompt({ marker });
      const grade = gradeArm({ text: 'RESULT1: line 1500\nRESULT2: done\nRESULT3: Notes', scratch: marker + '\n', marker });
      await clock.sleep(90000);
      return { status: grade.pass ? 'pass' : 'fail', model: 'dry-run', grade, prompt: prompt.length, cleanup: { confirmed: true } };
    },
    async relaunch({ app }) {
      const driver = withCards(fakeDriver({ now: clock.now, app }), false);
      const receipt = await runQualification({ app, driver, observer: fakeObserver({ now: clock.now, fixturePid: () => driver.identity()?.pid }), io, clock,
        cells: liveRelaunchCells(app), options: { ...options, relaunch: true } });
      return record(receipt, app.key);
    },
  };
}
