import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { fillForm, fillFormCode } from '../plugins/sleight/lib/fill-form.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture(specs) {
  const calls = [];
  const controls = Object.fromEntries(Object.entries(specs).map(([name, spec]) => {
    const el = { tagName: 'INPUT', type: 'text', value: '', checked: false,
      getAttribute: key => spec[key] ?? null, ...spec };
    const loc = {
      count: async () => spec.count ?? 1,
      evaluate: async (fn, arg) => fn(new Proxy(el, { set() { throw Error('page evaluation must only read'); } }), arg),
      fill: async value => { calls.push([name, 'fill', value]); if (spec.fillError) throw Error(spec.fillError); el.value = value; },
      type: async value => { calls.push([name, 'type', value]); el.value = value; },
      press: async key => {
        calls.push([name, 'press', key]);
        if (key === 'Home') el.value = spec.min ?? 0;
        if (key === 'ArrowRight') el.value = Number(el.value) + Number(spec.step ?? 1);
      },
      setChecked: async value => { calls.push([name, 'check', value]); if (spec.checkError) throw Error(spec.checkError); el.checked = value; },
      click: async () => { calls.push([name, 'click']); el.checked = !el.checked; },
      selectOption: async value => { calls.push([name, 'select', value]); if (spec.labelError && value.label) throw Error('no option label'); },
    };
    return [name, loc];
  }));
  const tab = { playwright: { getByLabel: name => controls[name], locator: name => controls[name] },
    getAXState: async () => 'Browser tab: 1, Title: "Form", URL: "https://example.com".\n0 AXWebArea Form\n\t1 text field Description: Name, ID: name\n\t2 checkbox Description: Terms' };
  return { tab, controls, calls };
}

test('fills text, checkbox, radio, select, slider and switch in field order', async () => {
  const h = fixture({ Name: {}, Terms: { type: 'checkbox' }, Choice: { type: 'radio' },
    Country: { tagName: 'SELECT' }, Amount: { type: 'range', min: '0', max: '10', step: '2' },
    Alerts: { role: 'switch' } });
  const out = await fillForm(h.tab, [
    { label: 'Name', value: 'Ada' }, { label: 'Terms', value: true }, { label: 'Choice', value: true },
    { label: 'Country', value: 'UK' }, { label: 'Amount', value: 4 }, { label: 'Alerts', value: false },
  ]);
  assert.match(out, /^Filled 6 of 6 fields\./);
  assert.deepEqual(h.calls, [['Name', 'fill', 'Ada'], ['Terms', 'check', true], ['Choice', 'check', true],
    ['Country', 'select', { label: 'UK' }], ['Amount', 'press', 'Home'], ['Amount', 'press', 'ArrowRight'],
    ['Amount', 'press', 'ArrowRight'], ['Alerts', 'check', false]]);
});

test('resolves indices by current IDs or labels and accepts locator strings and objects', async () => {
  const h = fixture({ '[id="name"]': {}, Terms: { type: 'checkbox' }, '#note': {}, extra: {} });
  const out = await fillForm(h.tab, [{ index: 1, value: 'Ada' }, { index: 2, value: true },
    { locator: '#note', value: 'text' }, { locator: h.controls.extra, value: 'more' }]);
  assert.match(out, /^Filled 4 of 4 fields\./);
  assert.deepEqual(h.calls.map(call => call[0]), ['[id="name"]', 'Terms', '#note', 'extra']);
});

test('fallbacks replace text, select by value and verify checkbox state before toggling', async () => {
  const h = fixture({ Name: { fillError: 'use typing' }, Country: { tagName: 'SELECT', labelError: true },
    Terms: { type: 'checkbox', checkError: 'custom check' } });
  const out = await fillForm(h.tab, [{ label: 'Name', value: 'Ada' }, { label: 'Country', value: 'uk' }, { label: 'Terms', value: true }]);
  assert.match(out, /^Filled 3 of 3 fields\./);
  assert.ok(h.calls.some(call => call[1] === 'type'));
  assert.ok(h.calls.some(call => call[1] === 'select' && call[2].value === 'uk'));
  assert.equal(h.calls.filter(call => call[1] === 'click').length, 1);
  assert.match(out, /fallback/);
});

test('reports individual failures and continues without submitting or mutating page JavaScript', async () => {
  const h = fixture({ Ambiguous: { count: 2 }, Bad: { type: 'range', min: '0', max: '10000' }, Name: {}, Terms: { type: 'checkbox' } });
  const out = await fillForm(h.tab, [{ label: 'Ambiguous', value: 'x' }, { label: 'Bad', value: 1000 },
    { label: 'Terms', value: 'maybe' }, { index: 99, value: 'x' }, { label: 'Name', value: 'Ada' }]);
  assert.match(out, /^Filled 1 of 5 fields\./);
  for (const field of ['Ambiguous', 'Bad', 'Terms', '99']) assert.ok(out.includes(field));
  assert.deepEqual(h.calls, [['Name', 'fill', 'Ada']]);
});

test('rejects buttons and invalid values, and never toggles an already-correct fallback checkbox', async () => {
  const h = fixture({ Submit: { type: 'submit' }, Name: {}, Terms: { type: 'checkbox', checked: true, checkError: 'already sent' } });
  const out = await fillForm(h.tab, [{ label: 'Submit', value: 'send' }, { label: 'Name', value: {} }, { label: 'Terms', value: true }]);
  assert.match(out, /^Filled 1 of 3 fields\./);
  assert.deepEqual(h.calls, [['Terms', 'check', true]]);
});

test('a custom combobox uses an exact option locator after the fill fallback', async () => {
  const h = fixture({ Country: { tagName: 'DIV', role: 'combobox', fillError: 'not editable' }, UK: {} });
  h.tab.playwright.getByRole = (role, options) => {
    assert.equal(role, 'option'); assert.deepEqual(options, { name: 'UK', exact: true });
    return h.controls.UK;
  };
  assert.match(await fillForm(h.tab, [{ label: 'Country', value: 'UK' }]), /^Filled 1 of 1 fields\./);
  assert.deepEqual(h.calls, [['Country', 'fill', 'UK'], ['Country', 'click'], ['UK', 'click']]);
});

test('the injected helper runs in a fresh realm and is hooked into browser calls', async t => {
  const h = fixture({ Name: {} });
  const context = createContext({ tab: h.tab });
  const value = await runInContext('(async () => {' + fillFormCode('return await sleight.fillForm(tab, [{ label: "Name", value: "Ada" }])') + '})()', context);
  assert.match(value, /^Filled 1 of 1 fields\./);
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => relay.close());
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'js', arguments: { code: 'nodeRepl.write(await sleight.fillForm(tab, [{label:"Name", value:"Ada"}]))' } } }) + '\n');
  assert.match(sent[0].params.arguments.code, /globalThis\.sleight/);
});
