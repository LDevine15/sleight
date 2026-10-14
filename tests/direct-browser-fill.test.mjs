import test from 'node:test';
import assert from 'node:assert/strict';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';

function element(tag = 'INPUT', attrs = {}, value = '') {
  return { tagName: tag, type: attrs.type ?? 'text', value, checked: false, isConnected: true,
    disabled: false, readOnly: false, isContentEditable: false, options: [], children: [],
    labels: [], validity: { valid: true },
    getAttribute: key => attrs[key] ?? null,
    closest: () => null,
    matches: selector => selector === ':disabled' && false };
}
function harness(nodes, { check = () => 'allow', mutate, submit, event, sleep, now } = {}) {
  const listeners = new Map(), input = [], resolve = [];
  const emit = name => { for (const fn of listeners.get(name) ?? []) fn(event ?? page); };
  const locator = node => ({
    async evaluate(fn, arg) { return fn(node, arg); },
    async count() { return node ? 1 : 0; },
    async fill(value) { assert.ok(['INPUT', 'TEXTAREA'].includes(node.tagName) || node.isContentEditable, 'Playwright fill needs an editable field'); input.push(['fill', node, value]); node.value = value; await mutate?.(node, 'fill', emit); },
    async setChecked(value) { input.push(['check', node, value]); node.checked = value; await mutate?.(node, 'check', emit); },
    async click() { input.push(['click', node]); node.checked = !node.checked; await mutate?.(node, 'click', emit); },
    async press(key) { input.push(['press', node, key]); await mutate?.(node, 'press', emit); },
    async selectOption(options) { input.push(['select', node, options]);
      node.options.forEach(o => { o.selected = options.some(w => w.value === o.value); });
      node.value = node.options.find(o => o.selected)?.value ?? ''; },
    async waitFor() { if (!node?.isConnected) throw Error('detached'); },
    async dragTo(target) { input.push(['drag', node, target.node]); await mutate?.(node, 'drag', emit, target.node); },
    node,
  });
  const page = {
    locator(selector) { assert.match(selector, /^aria-ref=(?:f\d+)?e\d+$/); resolve.push(selector); return locator(nodes[selector.slice(9)]); },
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    off(name, fn) { listeners.get(name)?.delete(fn); },
    mainFrame() { return page; },
    url() { return 'http://fixture.invalid/form'; },
  };
  const tab = { page, state: { snapshotNo: 1, submitUnconfirmed: false } };
  const fill = createFillFields({ check, sleep, now, runSteps: submit ?? (async () => { throw Error('unexpected submit'); }) });
  return { fill: (fields, options = {}) => fill(tab, fields, options, { userMessage: 'fill this form', consent: null, files: [] }),
    input, resolve, listeners, tab, locator, emit };
}

test('whole-form fill sets text, numbers, dates, checkbox and multi-select with one row per field', async () => {
  const nodes = { e1: element(), e2: element('INPUT', { type: 'number' }), e3: element('INPUT', { type: 'date' }),
    e4: element('INPUT', { type: 'checkbox' }), e5: element('SELECT', { multiple: '' }) };
  nodes.e5.multiple = true;
  nodes.e5.options = [{ value: 'ja', label: 'Japanese', selected: false, disabled: false }, { value: 'ko', label: 'Korean', selected: false, disabled: false }];
  const h = harness(nodes), r = await h.fill([{ ref: 'e1', value: 'Name' }, { ref: 'e2', value: 3 },
    { ref: 'e3', value: '2026-11-19' }, { ref: 'e4', value: true }, { ref: 'e5', value: ['Japanese', 'ko'] }]);
  assert.deepEqual(r.rows.map(row => row.status), ['set', 'set', 'set', 'set', 'set']);
  assert.equal(nodes.e1.value, 'Name'); assert.equal(nodes.e2.value, '3'); assert.equal(nodes.e3.value, '2026-11-19');
  assert.equal(nodes.e4.checked, true); assert.deepEqual(nodes.e5.options.map(o => o.selected), [true, true]);
  assert.equal(r.submitted.status, 'not requested');
});
test('field failure preserves prior results and leaves later fields and submit not reached', async () => {
  const a = element(), b = element(), c = element(); b.readOnly = true;
  const h = harness({ e1: a, e2: b, e3: c });
  const r = await h.fill([{ ref: 'e1', value: 'a' }, { ref: 'e2', value: 'b' }, { ref: 'e3', value: 'c' }], { submit: 'e4' });
  assert.deepEqual(r.rows.map(row => row.status), ['set', 'failed', 'not reached']);
  assert.match(r.rows[1].reason, /readonly/i); assert.equal(c.value, ''); assert.equal(r.submitted.status, 'not reached');
});
test('rules refuse a field before physical input', async () => {
  const a = element(); const h = harness({ e1: a }, { check: (ctx, kind, target) => {
    assert.equal(kind, 'type'); assert.equal(target.ref, 'e1'); assert.equal(target.tab.state.snapshotNo, 1);
    return { status: 'refuse', message: 'user approval required' };
  } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(h.input.length, 0); assert.equal(a.value, '');
});
test('protected fill and action errors never print field values or Playwright call logs', async () => {
  const secret = '4242424242424242', node = element('INPUT', { id: 'cardNumber' });
  const h = harness({ f2e1: node }, { mutate() { throw Error('fill("' + secret + '") timed out'); } });
  const r = await h.fill([{ ref: 'f2e1', value: secret }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(h.input.length, 1);
  assert.doesNotMatch(JSON.stringify(r), /4242424242424242/); assert.match(r.rows[0].reason, /may have changed/i);
});
test('frame-prefixed refs use Playwright frame routing and child fields cannot fall back to a parent ref', async () => {
  const child = element(), parent = element(); const h = harness({ f7e2: child, e2: parent });
  const r = await h.fill([{ ref: 'f7e2', value: 'child' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(child.value, 'child'); assert.equal(parent.value, '');
  assert.deepEqual(h.resolve, ['aria-ref=f7e2']);
});
test('submit delegates exactly once to the guarded action layer after fields succeed', async () => {
  const seen = [], h = harness({ e1: element() }, { submit: async (tab, steps, ctx) => {
    seen.push(steps); assert.equal(ctx.userMessage, 'fill this form');
    return { lines: ['1 click e9: done'], stoppedAt: null, observe: 'diff' };
  } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }], { submit: 'e9' });
  assert.deepEqual(seen, [[{ do: 'click', ref: 'e9' }]]); assert.equal(r.submitted.status, 'done');
});
test('a submit refusal is reported without turning already set fields into failures', async () => {
  const h = harness({ e1: element() }, { submit: async () => { throw Error('SUBMIT_UNCONFIRMED'); } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }], { submit: 'e9' });
  assert.equal(r.rows[0].status, 'set'); assert.equal(r.submitted.status, 'failed');
  assert.match(r.submitted.reason, /SUBMIT_UNCONFIRMED/);
});
test('navigation after a field stops the rest and removes event listeners', async () => {
  const h = harness({ e1: element(), e2: element() }, { mutate(node, kind, emit) { emit('framenavigated'); } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }, { ref: 'e2', value: 'y' }], { submit: 'e9' });
  assert.equal(r.rows[1].status, 'not reached'); assert.equal(r.submitted.status, 'not reached'); assert.equal(h.input.length, 1);
  assert.ok([...h.listeners.values()].every(v => v.size === 0));
});
test('a page dialog after input is an observation and stops remaining fields', async () => {
  const h = harness({ e1: element(), e2: element() }, { mutate(node, kind, emit) { emit('dialog'); } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }, { ref: 'e2', value: 'y' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(r.rows[1].status, 'not reached'); assert.match(r.stopped, /dialog/i);
});
test('formatted text is observed without a false failure or an input retry', async () => {
  const node = element('INPUT', { id: 'phone' }); const h = harness({ e1: node }, { mutate(n) { n.value = '(555) 555-1212'; } });
  const r = await h.fill([{ ref: 'e1', value: '5555551212' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(h.input.length, 1); assert.match(r.rows[0].note, /formatted/i);
});
for (const fields of [[], Array.from({ length: 61 }, () => ({ ref: 'e1', value: 'x' })), [{ ref: 'e1', value: {} }],
  [{ ref: 'e1', value: Infinity }], [{ ref: '#anything', value: 'x' }], [{ ref: 'e1', value: ['a', 2] }]]) {
  test('invalid whole-form input is rejected before any physical action: ' + JSON.stringify(fields).slice(0, 70), async () => {
    const h = harness({ e1: element() });
    await assert.rejects(h.fill(fields), /fields|value|ref/i); assert.equal(h.input.length, 0);
  });
}
test('all 60 permitted fields are filled', async () => {
  const node = element(), h = harness({ e1: node });
  const r = await h.fill(Array.from({ length: 60 }, (_, i) => ({ ref: 'e1', value: String(i) })));
  assert.equal(r.rows.length, 60); assert.ok(r.rows.every(row => row.status === 'set')); assert.equal(node.value, '59');
});
test('a closed-shadow host checked getter uses a single click and verifies its state', async () => {
  const node = element('CUSTOM-SWITCH'), h = harness({ e1: node });
  const r = await h.fill([{ ref: 'e1', value: true }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.checked, true); assert.equal(h.input.length, 1);
});
test('unsupported file input requires the upload action and is never treated as text', async () => {
  const h = harness({ e1: element('INPUT', { type: 'file' }) });
  const r = await h.fill([{ ref: 'e1', value: '/tmp/page-supplied.txt' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.match(r.rows[0].reason, /upload/i); assert.equal(h.input.length, 0);
});

test('autocomplete waits for the exact suggestion and confirms it without submitting on Enter', async () => {
  const node = element('INPUT', { role: 'combobox', 'aria-controls': 'choices' }), option = element('LI');
  const h = harness({ e1: node }); let clicked = 0;
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => {
    const loc = base(selector);
    loc.elementHandle = async () => ({ ownerFrame: async () => ({ locator: selector => {
      assert.equal(selector, '[id="choices"]');
      return { getByRole(role, opts) { assert.equal(role, 'option'); assert.deepEqual(opts, { name: '123 Test Street', exact: true });
        return { async evaluate(fn, arg) { return fn(option, arg); }, async waitFor() {}, async count() { return 1; }, async click() { clicked++; node.value = '123 Test Street'; } }; } };
    } }), async dispose() {} });
    return loc;
  };
  const r = await h.fill([{ ref: 'e1', value: '123 Test Street' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(clicked, 1); assert.equal(node.value, '123 Test Street');
  assert.equal(h.input.filter(a => a[0] === 'press').length, 0);
});
test('ambiguous autocomplete refuses to pick either suggestion and does not retry text entry', async () => {
  const node = element('INPUT', { role: 'combobox', 'aria-controls': 'choices' }), h = harness({ e1: node });
  const base = h.tab.page.locator; let clicks = 0;
  h.tab.page.locator = selector => { const loc = base(selector);
    loc.elementHandle = async () => ({ ownerFrame: async () => ({ locator: () => ({ getByRole: () => ({
      async waitFor() {}, async count() { return 2; }, async click() { clicks++; }
    }) }) }), async dispose() {} }); return loc; };
  const r = await h.fill([{ ref: 'e1', value: 'duplicate' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(clicks, 0); assert.equal(h.input.filter(a => a[0] === 'fill').length, 1);
});
test('range is moved by bounded keyboard input and read back', async () => {
  const node = element('INPUT', { type: 'range' }, '0'); node.min = '0'; node.max = '100'; node.step = '1';
  const h = harness({ e1: node }, { mutate(n, kind) { if (kind === 'press') n.value = '72'; } });
  const r = await h.fill([{ ref: 'e1', value: 72 }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, '72');
});
test('range refuses a value outside its bounds before any action', async () => {
  const node = element('INPUT', { type: 'range' }, '0'), h = harness({ e1: node });
  const r = await h.fill([{ ref: 'e1', value: 101 }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(h.input.length, 0);
});
test('reorder validates a permutation, drags each misplaced row and observes the final order', async () => {
  const node = element('UL'), names = ['Alpha', 'Beta', 'Gamma'];
  node.children = names.map(name => ({ textContent: name, getAttribute(key) { return key === 'draggable' ? 'true' : key === 'aria-label' ? name : null; } }));
  const h = harness({ e1: node }, { mutate(n, kind, emit, target) {
    if (kind === 'drag') { const from = node.children.indexOf(n), to = node.children.indexOf(target); node.children.splice(from, 1); node.children.splice(to, 0, n); }
  } });
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector);
    loc.locator = selector => { assert.equal(selector, ':scope > li'); return { nth: i => h.locator(node.children[i]) }; };
    return loc; };
  const r = await h.fill([{ ref: 'e1', value: ['Gamma', 'Alpha', 'Beta'] }]);
  assert.equal(r.rows[0].status, 'set'); assert.deepEqual(node.children.map(n => n.textContent), ['Gamma', 'Alpha', 'Beta']);
});
test('an invalid reorder permutation never starts a drag', async () => {
  const node = element('UL'); node.children = [{ textContent: 'Alpha', getAttribute: key => key === 'draggable' ? 'true' : null }];
  const h = harness({ e1: node }); const r = await h.fill([{ ref: 'e1', value: ['Wrong'] }]);
  assert.equal(r.rows[0].status, 'failed'); assert.equal(h.input.length, 0);
});

test('field inspection errors cannot leak private values before input', async () => {
  const node = element(); Object.defineProperty(node, 'value', { get() { throw Error('private-field-123456'); } });
  const h = harness({ e1: node }); const r = await h.fill([{ ref: 'e1', value: 'private-field-123456' }]);
  assert.equal(r.rows[0].status, 'failed'); assert.doesNotMatch(JSON.stringify(r), /private-field-123456/);
});
test('an action-layer submit that did not run is not reported as done', async () => {
  const h = harness({ e1: element() }, { submit: async () => ({ lines: ['1 click e9: not run: payment confirmation required'], stoppedAt: 1, observe: undefined }) });
  const r = await h.fill([{ ref: 'e1', value: 'x' }], { submit: 'e9' });
  assert.equal(r.submitted.status, 'failed');
});
test('file fields delegate user-named paths to the guarded upload action', async () => {
  const seen = [], h = harness({ e1: element('INPUT', { type: 'file' }) }, { submit: async (tab, steps) => {
    seen.push(steps); return { lines: ['1 upload e1: input sent; observation below'], stoppedAt: null };
  } });
  const r = await h.fill([{ ref: 'e1', value: ['/tmp/user-fixture.txt'] }]);
  assert.equal(r.rows[0].status, 'set'); assert.deepEqual(seen, [[{ do: 'upload', ref: 'e1', paths: ['/tmp/user-fixture.txt'] }]]);
});

test('closed-root snapshot refs delegate to the action layer without guessing a parent selector', async () => {
  const seen = [], h = harness({}, { submit: async (tab, steps) => { seen.push(steps); return { lines: ['1 check s1: input sent; observation below'], stoppedAt: null }; } });
  const r = await h.fill([{ ref: 's1', value: true }]);
  assert.equal(r.rows[0].status, 'set'); assert.deepEqual(seen, [[{ do: 'check', ref: 's1' }]]); assert.equal(h.resolve.length, 0);
});
test('listbox selection uses bounded scroll-until before choosing the exact row', async () => {
  const node = element('DIV', { role: 'listbox' }), option = element('LI'), h = harness({ e1: node }, {
    submit: async (tab, steps) => { assert.deepEqual(steps, [{ do: 'scroll', ref: 'e1', until: 'Far option' }]); return { lines: ['1 scroll e1: found'], stoppedAt: null }; }
  });
  let clicks = 0; const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector); loc.getByRole = (role, opts) => {
    assert.equal(role, 'option'); assert.deepEqual(opts, { name: 'Far option', exact: true });
    return { async evaluate(fn, arg) { return fn(option, arg); }, async waitFor() {}, async count() { return 1; }, async click() { clicks++; } };
  }; return loc; };
  const r = await h.fill([{ ref: 'e1', value: 'Far option' }]); assert.equal(r.rows[0].status, 'set'); assert.equal(clicks, 1);
});

test('field input matches V6 operation-kind, element and verdict interface', async () => {
  const h = harness({ e1: element() }, { check(ctx, kind, target) {
    assert.equal(kind, 'type'); assert.equal(target.element.tag, 'input'); assert.equal(target.state.snapshotNo, 1);
    return { verdict: 'allow' };
  } });
  const r = await h.fill([{ ref: 'e1', value: 'x' }]); assert.equal(r.rows[0].status, 'set');
});

test('a custom toggle that is also a payment submit cannot bypass the trusted inspector', async () => {
  const node = element('CUSTOM-TOGGLE'); let clicks = 0;
  const page = { on() {}, off() {}, getByRef: () => ({ evaluate: async (fn, arg) => fn(node, arg), click: async () => { clicks++; } }) };
  const fill = createFillFields({ inspectElement: () => ({ tag: 'button', kind: 'button', connected: true, visible: true, enabled: true,
    submit: true, payment: true, formPayment: true, form: true }),
    check: (ctx, kind, target) => target.element.payment ? { verdict: 'confirm', terms: {} } : { verdict: 'allow' }, runSteps: async () => {} });
  const r = await fill({ page, state: { snapshotNo: 1, submitUnconfirmed: false } }, [{ ref: 'e1', value: true }], {}, {});
  assert.equal(r.rows[0].status, 'failed'); assert.equal(clicks, 0);
});

test('a native color field sets a validated color without opening the platform picker', async () => {
  const node = element('INPUT', { type: 'color' }, '#000000'), events = [];
  node.ownerDocument = { defaultView: { getComputedStyle: () => ({}), Event: class { constructor(type) { this.type = type; } } } };
  class Input {}
  Object.defineProperty(Input.prototype, 'value', { set(value) { Object.defineProperty(this, 'value', { value, writable: true, configurable: true }); } });
  node.ownerDocument.defaultView.HTMLInputElement = Input;
  node.dispatchEvent = event => { events.push(event.type); };
  const h = harness({ e1: node }); const r = await h.fill([{ ref: 'e1', value: '#123abc' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, '#123abc'); assert.deepEqual(events, ['input', 'change']);
  assert.equal(h.input.length, 0);
});

test('a noneditable combobox opens its option list and never attempts text fill', async () => {
  const node = element('BUTTON', { role: 'combobox', 'aria-controls': 'choices', type: 'button' }, 'Choose'), option = element('LI');
  const h = harness({ e1: node }); const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector);
    loc.elementHandle = async () => ({ ownerFrame: async () => ({ locator: () => ({ getByRole: () => ({
      async evaluate(fn, arg) { return fn(option, arg); }, async waitFor() {}, async count() { return 1; }, async click() { node.value = 'Exact'; }
    }) }) }), async dispose() {} }); return loc;
  };
  const r = await h.fill([{ ref: 'e1', value: 'Exact' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, 'Exact'); assert.deepEqual(h.input.map(row => row[0]), ['click']);
});

test('a dependent disabled select waits for its new options before any selection input', async () => {
  const node = element('SELECT'); node.disabled = true;
  node.options = [{ value: '', label: 'Loading', disabled: false, selected: true }];
  let waits = 0, time = 0;
  const h = harness({ e1: node }, { now: () => time, sleep: async ms => {
    time += ms; waits++; node.disabled = false;
    node.options = [{ value: 'Osaka', label: 'Osaka', disabled: false, selected: false }];
  } });
  const r = await h.fill([{ ref: 'e1', value: 'Osaka' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(waits, 1); assert.equal(node.value, 'Osaka');
  assert.equal(h.input.filter(a => a[0] === 'select').length, 1);
});
test('a clipped native radio uses its associated label without attempting or retrying setChecked', async () => {
  const node = element('INPUT', { type: 'radio' }), label = element('LABEL'); node.labels = [label];
  node.ownerDocument = { defaultView: { getComputedStyle: () => ({ clip: 'rect(0px, 0px, 0px, 0px)' }) } };
  let nativeAttempts = 0;
  const h = harness({ e1: node }, { mutate(n, kind) { if (n === label && kind === 'click') node.checked = true; } });
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector);
    loc.setChecked = async () => { nativeAttempts++; throw Error('clipped native radio'); };
    loc.evaluateHandle = async fn => ({ asElement: () => h.locator(fn(node)), async dispose() {} });
    return loc;
  };
  const r = await h.fill([{ ref: 'e1', value: true }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.checked, true); assert.equal(nativeAttempts, 0);
  assert.equal(h.input.filter(a => a[0] === 'click').length, 1);
});

test('submit-capable check fields delegate one physical click and retain the shared retry marker', async () => {
  const node = element('BUTTON', { role: 'checkbox', type: 'submit' }); node.closest = () => ({});
  let h, dispatches = 0, delegated = 0;
  h = harness({ e1: node }, { mutate(n) { n.checked = false; throw Error('dispatch timed out'); },
    submit: async (tab, steps) => {
      delegated++; assert.deepEqual(steps, [{ do: 'click', ref: 'e1' }]);
      if (tab.state.submitUnconfirmed) return { lines: ['1 click e1: not run: submit unconfirmed'], stoppedAt: 1 };
      tab.state.submitUnconfirmed = { startedAt: 1000, snapshotNo: 1, settledAt: 6000 };
      try { dispatches++; await tab.page.locator('aria-ref=e1').click(); } catch {}
      return { lines: ['1 click e1: effect unconfirmed; read before retrying'], stoppedAt: 1 };
    }
  });
  const first = await h.fill([{ ref: 'e1', value: true }]), second = await h.fill([{ ref: 'e1', value: true }]);
  assert.equal(first.rows[0].status, 'failed'); assert.equal(second.rows[0].status, 'failed');
  assert.equal(h.input.filter(row => row[0] === 'click').length, 1); assert.equal(dispatches, 1); assert.equal(delegated, 2);
  assert.ok(h.tab.state.submitUnconfirmed); assert.equal(h.tab.state.snapshotNo, 1);
});
test('an existing pending action fences the first field and keeps the suffix untouched', async () => {
  const h = harness({ e1: element(), e2: element() }); h.tab.state.actionPending = true;
  const result = await h.fill([{ ref: 'e1', value: 'x' }, { ref: 'e2', value: 'y' }], { submit: 'e9' });
  assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
  assert.match(result.rows[0].reason, /pending/i); assert.equal(h.input.length, 0); assert.equal(h.resolve.length, 0);
  assert.equal(result.submitted.status, 'not reached'); assert.equal(h.tab.state.actionPending, true);
});
test('input that becomes pending during the final read is fenced before checks consume consent', async () => {
  const h = harness({ e1: element() }); let inspections = 0, checks = 0;
  const base = h.tab.page.locator;
  h.tab.page.locator = selector => { const loc = base(selector), evaluate = loc.evaluate;
    loc.evaluate = async (fn, arg) => { const result = await evaluate(fn, arg); if (++inspections === 3) h.tab.state.actionPending = true; return result; }; return loc;
  };
  const fill = createFillFields({ check() { checks++; return { verdict: 'allow' }; }, runSteps: async () => { throw Error('unexpected delegation'); } });
  const result = await fill(h.tab, [{ ref: 'e1', value: 'x' }], {}, {});
  assert.equal(result.rows[0].status, 'failed'); assert.equal(checks, 0); assert.equal(h.input.length, 0);
});
test('ordinary nonsubmit fields remain usable while a submit only needs a delivered read', async () => {
  const node = element(), h = harness({ e1: node }); h.tab.state.submitUnconfirmed = { startedAt: 1000, snapshotNo: 1, settledAt: 6000 };
  const r = await h.fill([{ ref: 'e1', value: 'ordinary' }]);
  assert.equal(r.rows[0].status, 'set'); assert.equal(node.value, 'ordinary'); assert.ok(h.tab.state.submitUnconfirmed);
});
