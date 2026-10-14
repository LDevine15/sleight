import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';

// Playwright boundary only. There is no engine object and no catch-all method fake.
function fixture({ effect = '', submit = false, fail, onClick, snapshotFail = false } = {}) {
  const page = new EventEmitter(), actions = [], states = new Map(); let time = 0, number = 1;
  const metadata = { name: 'Continue', submit, payment: false, form: submit, formSignature: 'before' };
  const loc = ref => ({
    async evaluate(fn, arg) {
      if (fn.name === 'inspectTarget') return { ...metadata, ...(states.get(ref) ?? {}) };
      if (fn.name === 'scrollPoint') return { x: 10, y: 20 };
      if (fn.name === 'coverDetails') return { name: 'Cookie notice', buttons: ['Accept cookies'] };
      throw Error('unexpected evaluate ' + fn.name);
    },
    async count() { return 1; },
    async click(options) { actions.push(['click', ref, options]); await onClick?.(page); if (fail) throw Error(fail); },
    async fill(text, options) { actions.push(['fill', ref, text, options]); },
    async press(key, options) { actions.push(['press', ref, key, options]); },
    async selectOption(values, options) { actions.push(['selectOption', ref, values, options]); },
    async check(options) { actions.push(['check', ref, options]); },
    async uncheck(options) { actions.push(['uncheck', ref, options]); },
    async hover(options) { actions.push(['hover', ref, options]); },
    async dragTo(to, options) { actions.push(['dragTo', ref, to, options]); },
    async scrollIntoViewIfNeeded(options) { actions.push(['scrollIntoView', ref, options]); },
    async setInputFiles(paths, options) { actions.push(['upload', ref, paths, options]); },
    async waitFor(options) { actions.push(['wait', ref, options]); },
  });
  page.getByRef = loc; page.url = () => 'https://example.invalid/';
  page.locator = selector => { assert.equal(selector, ':focus'); return loc('e1'); };
  page.mainFrame = () => page;
  page.keyboard = { async press(key) { actions.push(['key', key]); } };
  page.mouse = { async move(x, y) { actions.push(['move', x, y]); }, async wheel(dx, dy) { actions.push(['wheel', dx, dy]); } };
  for (const method of ['goBack', 'goForward', 'reload', 'setViewportSize']) page[method] = async options => { actions.push([method, options]); };
  const tab = { page, state: { snapshotNo: 1, submitUnconfirmed: false } }, checks = [];
  const check = async (ctx, kind, target) => {
    checks.push({ ctx, kind, target });
    if (target.submit && target.state.submitUnconfirmed) return { kind: 'refuse', message: 'Read before resubmitting' };
    return { kind: 'allow' };
  };
  const run = createActionRunner({ check, now: () => time, sleep: async ms => { time += ms; },
    snapshot: async (p, options) => { assert.equal(p, page); if (snapshotFail) throw Error('read unavailable');
      return { text: effect || 'No visible changes.', number: ++number, options }; } });
  return { page, tab, run, checks, actions, states, time: () => time };
}

test('v3 action reports an unproved click as an observation and returns a diff', async () => {
  const f = fixture(); const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /no visible change/i); assert.equal(result.stoppedAt, null);
  assert.equal(result.observe.text, 'No visible changes.'); assert.equal(result.observe.options.since, 1);
  assert.equal(f.actions.filter(a => a[0] === 'click').length, 1);
});

test('v3 validates the whole batch before input, including every required field', async () => {
  const f = fixture();
  for (const step of [{ do: 'click' }, { do: 'type', ref: 'e1' }, { do: 'press' }, { do: 'select', ref: 'e1' },
    { do: 'drag', ref: 'e1' }, { do: 'upload', ref: 'e1' }, { do: 'dialog' }, { do: 'viewport', width: 0, height: 800 },
    { do: 'evaluate', text: 'window.focus()' }, { do: 'scroll', dy: Infinity }]) {
    await assert.rejects(f.run(f.tab, [{ do: 'click', ref: 'e1' }, step], {}), /needs|unsupported|invalid/i);
  }
  await assert.rejects(f.run(f.tab, [], {}), /1 to 12/);
  await assert.rejects(f.run(f.tab, Array.from({ length: 13 }, () => ({ do: 'back' })), {}), /1 to 12/);
  assert.deepEqual(f.actions, []);
});

test('v3 runs text, keys, choice, toggle, hover and drag operations in order', async () => {
  const f = fixture({ effect: '+ textbox changed' });
  const steps = [{ do: 'type', ref: 'e1', text: 'hello' }, { do: 'press', ref: 'e1', key: 'Tab' },
    { do: 'select', ref: 'e2', values: ['A', 'B'] }, { do: 'check', ref: 'e3' }, { do: 'uncheck', ref: 'e3' },
    { do: 'hover', ref: 'e4' }, { do: 'drag', ref: 'e4', to: 'f2e5' }];
  const result = await f.run(f.tab, steps, { userMessage: 'Fill these fields' });
  assert.equal(result.lines.length, 7); assert.equal(result.stoppedAt, null);
  assert.deepEqual(f.actions.map(a => a[0]), ['fill', 'press', 'selectOption', 'check', 'uncheck', 'hover', 'dragTo']);
  assert.equal(f.checks.length, 7);
  assert.equal(f.actions[0][2], 'hello');
});

test('v3 reports viewport, navigation controls, keyboard and bounded wait', async () => {
  const f = fixture();
  const result = await f.run(f.tab, [{ do: 'viewport', width: 390, height: 844 }, { do: 'press', key: 'Escape' },
    { do: 'wait', ref: 'e1' }, { do: 'back' }, { do: 'forward' }, { do: 'reload' }], {});
  assert.equal(result.stoppedAt, null);
  assert.deepEqual(f.actions.map(a => a[0]), ['setViewportSize', 'key', 'wait', 'goBack', 'goForward', 'reload']);
  assert.deepEqual(f.actions[0][1], { width: 390, height: 844 });
});

for (const event of ['navigation', 'document', 'dialog', 'popup', 'close']) test(`v3 stops after ${event} and lists untouched steps`, async () => {
  const f = fixture({ onClick(page) {
    if (event === 'navigation') page.emit('framenavigated', page);
    if (event === 'document') page.emit('load');
    if (event === 'dialog') page.emit('dialog', { type: () => 'confirm', message: () => 'Leave?' });
    if (event === 'popup') page.emit('popup', { url: () => 'https://example.invalid/popup', isClosed: () => false });
    if (event === 'close') page.emit('close');
  } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'must not run' }], {});
  assert.equal(result.stoppedAt, 1); assert.match(result.lines[1], /not reached/);
  assert.equal(f.actions.length, 1);
  for (const name of ['request', 'requestfinished', 'requestfailed', 'framenavigated', 'load', 'dialog', 'popup', 'close'])
    assert.equal(f.page.listenerCount(name), 0, name);
});

test('v3 never retries a timed out dispatched input and names a cover with its buttons', async () => {
  const f = fixture({ fail: 'Timeout 1000ms exceeded: Cookie notice intercepts pointer events' });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }], {});
  assert.match(result.lines[0], /Cookie notice/); assert.match(result.lines[0], /Accept cookies/);
  assert.match(result.lines[1], /not reached/); assert.equal(f.actions.length, 1);
});

test('v3 unknown submit prevents a second submit before the delivered read', async () => {
  const f = fixture({ submit: true });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /unconfirmed/i); assert.match(result.lines[1], /Read before resubmitting/);
  assert.equal(f.tab.state.submitUnconfirmed.startedAt, 0); assert.ok(f.tab.state.submitUnconfirmed.settledAt >= 5000); assert.ok(f.time() >= 5000);
  assert.equal(f.actions.length, 1); assert.ok(result.observe.number > 1);
});

test('v3 Enter is checked as a submit and payment before dispatch', async () => {
  const f = fixture({ submit: true }); f.states.set('e1', { payment: true });
  await f.run(f.tab, [{ do: 'press', ref: 'e1', key: 'Enter' }], {});
  assert.equal(f.checks.some(c => c.kind === 'press' && c.target.element.payment === true), true);
});

test('v3 upload goes through the private file provider and releases staging after failure', async () => {
  const f = fixture(); let cleaned = 0;
  const event = {}, binding = { ref: 'e1' };
  const files = { event, binding, provider: {
    offer(e, paths, ref) { assert.equal(e, event); assert.deepEqual(paths, ['/tmp/owned.txt']); assert.equal(ref, 'e1'); return 'fhandle'; },
    async stage(handles, b) { assert.deepEqual(handles, ['fhandle']); assert.equal(b, binding);
      return { payloads: [{ name: 'owned.txt', mimeType: 'text/plain', buffer: Buffer.from('approved') }], cleanup() { cleaned++; } }; },
  } };
  await f.run(f.tab, [{ do: 'upload', ref: 'e1', paths: ['/tmp/owned.txt'] }], { files });
  assert.equal(f.actions[0][0], 'upload'); assert.equal(f.actions[0][2][0].buffer.toString(), 'approved'); assert.equal(cleaned, 1);
  const refused = await f.run(f.tab, [{ do: 'upload', ref: 'e1', paths: ['/tmp/page.txt'] }], {});
  assert.match(refused.lines[0], /file/i); assert.equal(f.actions.length, 1);
  const original = f.page.getByRef;
  f.page.getByRef = ref => ({ ...original(ref), async setInputFiles() { throw Error('raw private bytes must stay private'); } });
  const failed = await f.run(f.tab, [{ do: 'upload', ref: 'e1', paths: ['/tmp/owned.txt'] }], { files });
  assert.equal(cleaned, 2); assert.doesNotMatch(JSON.stringify(failed), /raw private bytes/);
});

test('v3 confirmation is returned without executing input', async () => {
  const f = fixture();
  const run = createActionRunner({ check: () => ({ kind: 'confirm', terms: { amount: '25' } }),
    snapshot: async () => ({ text: 'untrusted page', number: 2 }) });
  const result = await run(f.tab, [{ do: 'click', ref: 'e1' }], { userMessage: 'Read' });
  assert.match(result.lines[0], /confirm/i); assert.equal(f.actions.length, 0);
  assert.deepEqual(result.confirmation, { step: 1, terms: { amount: '25' } });
});

test('v3 read failure after input remains an observation, with no automatic resend', async () => {
  const f = fixture({ snapshotFail: true });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines.join('\n'), /read unavailable/i); assert.equal(f.actions.length, 1);
});

test('v3 a changed diff is described as changed rather than no visible change', async () => {
  const f = fixture({ effect: '+ button "Next" [ref=e2]\n- button "Previous" [ref=e1]' });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /2 lines changed/);
});

test('v3 bare Enter classifies the focused field and its payment form', async () => {
  const f = fixture({ submit: true }); f.states.set('e1', { payment: true });
  await f.run(f.tab, [{ do: 'press', key: 'Enter' }], {});
  assert.equal(f.checks.some(c => c.kind === 'press' && c.target.element.payment), true);
});

test('v3 page dialogs wait for an explicit answer and clear after acceptance', async () => {
  const f = fixture(); let accepted;
  f.tab.state.dialog = { type: () => 'prompt', message: () => 'Name?', accept: async text => { accepted = text; }, dismiss: async () => {} };
  const result = await f.run(f.tab, [{ do: 'dialog', accept: true, text: 'Example' }], {});
  assert.equal(accepted, 'Example'); assert.equal(f.tab.state.dialog, null); assert.equal(result.stoppedAt, null);
  assert.equal(f.checks.length, 1); assert.equal(f.checks[0].target.message, 'Name?');
});

test('v3 refuses to input behind a waiting dialog', async () => {
  const f = fixture(); f.tab.state.dialog = { type: () => 'confirm', message: () => 'Continue?' };
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.equal(f.actions.length, 0); assert.match(result.lines[0], /dialog/);
});

test('v3 action failure redacts echoed text and files', async () => {
  const f = fixture({ fail: 'failed while setting secret-card-value' });
  f.page.getByRef = () => ({ async evaluate() { return {}; }, async fill() { throw Error('failed while setting secret-card-value'); } });
  const result = await f.run(f.tab, [{ do: 'type', ref: 'e1', text: 'secret-card-value' }], {});
  assert.doesNotMatch(JSON.stringify(result), /secret-card-value/);
});

test('v3 uses V6 verdicts once per operation with the inspected element', async () => {
  const f = fixture(); let calls = 0;
  const run = createActionRunner({ now: () => 0, sleep: async () => {},
    check: (ctx, kind, target) => { calls++; assert.equal(kind, 'click'); assert.equal(target.element.name, 'Continue');
      return { verdict: 'refuse', message: 'owner consent needed' }; },
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  const result = await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /owner consent needed/); assert.equal(calls, 1); assert.equal(f.actions.length, 0);
});

test('v3 a still-pending timed out input blocks later input until it settles', async () => {
  let release; const f = fixture({ onClick: () => new Promise(resolve => { release = resolve; }) });
  const run = createActionRunner({ actionTimeoutMs: 10, check: () => 'allow',
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  const first = await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(first.lines[0], /unconfirmed/); assert.equal(f.tab.state.actionPending, true);
  const second = await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(second.lines[0], /pending/); assert.equal(f.actions.length, 1);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.tab.state.actionPending, false);
});

test('v3 settles a request started by input and records a finished-request observation', async () => {
  const request = { resourceType: () => 'fetch' };
  const f = fixture({ submit: true, onClick(page) { page.emit('request', request); queueMicrotask(() => page.emit('requestfinished', request)); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /request finished/); assert.equal(f.tab.state.submitUnconfirmed, false); assert.ok(f.time() < 5000);
});

test('v3 failed and preexisting requests cannot confirm a submit', async () => {
  const request = { resourceType: () => 'fetch' };
  const f = fixture({ submit: true, onClick(page) { page.emit('request', request); page.emit('requestfailed', request);
    page.emit('requestfinished', { resourceType: () => 'fetch' }); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /unconfirmed/); assert.ok(f.tab.state.submitUnconfirmed);
});

test('v3 form change confirms its submit without turning unrelated clicks into errors', async () => {
  let f; f = fixture({ submit: true, onClick() { f.states.set('e1', { formSignature: 'after' }); } });
  const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.match(result.lines[0], /form changed/); assert.equal(f.tab.state.submitUnconfirmed, false);
});

test('v3 passes the background-click disposition to the single Playwright click', async () => {
  const f = fixture(); let time = 0;
  const run = createActionRunner({ check: () => 'allow', now: () => time, sleep: async ms => { time += ms; },
    backgroundClick: (tab, loc, click) => { assert.equal(tab, f.tab); return click({ modifiers: ['ControlOrMeta'] }); },
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  await run(f.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.equal(f.actions.length, 1); assert.deepEqual(f.actions[0][2], { timeout: 1000, modifiers: ['ControlOrMeta'] });
});

test('v3 scroll until finds the text in a bounded search and returns its ref', async () => {
  const f = fixture(); let reads = 0, time = 0;
  const run = createActionRunner({ check: () => 'allow', now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: ++reads < 3 ? '- option "other" [ref=e7]' : '- option "Norcrest" [ref=e8]', number: reads + 1 }) });
  const result = await run(f.tab, [{ do: 'scroll', ref: 'e1', until: 'Norcrest' }], {});
  assert.match(result.lines[0], /e8/); assert.equal(f.actions.filter(a => a[0] === 'wheel').length, 2);
});

test('v3 scroll until stops after at most sixty wheels when text never appears', async () => {
  const f = fixture(); let time = 0;
  const run = createActionRunner({ check: () => 'allow', now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: '- option "other" [ref=e7]', number: 2 }) });
  const result = await run(f.tab, [{ do: 'scroll', ref: 'e1', until: 'missing' }], {});
  assert.match(result.lines[0], /not found/i); assert.equal(f.actions.filter(a => a[0] === 'wheel').length, 60);
});
