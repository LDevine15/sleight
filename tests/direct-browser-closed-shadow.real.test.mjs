// Real pages, the real v3 worker (bench/turbo/v3-session.mjs forks the installed worker over an owned headless Chromium):
// controls inside CLOSED shadow roots take click, check, fill, select and key presses through the five tools, with the
// same payment, focus and swap checks as light-DOM controls. The page reports what each control did to the fixture
// server, so every assertion reads the page's own behavior from outside the worker's browser.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSession } from '../bench/turbo/v3-session.mjs';
import { CLOSED_SHADOW_HTML, CLOSED_PAYMENT_HTML, SWAP_HTML } from './fixtures/closed-shadow-page.mjs';

const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'real-page qualification runs with SLEIGHT_LIVE_DOM_TEST=1';
const PAY = 'Pay {"item":"Fixture mug","amount":"18.00","payee":"Fixture shop","method":"Fixture card","currency":"USD"}';
const pages = { '/': CLOSED_SHADOW_HTML, '/pay': CLOSED_PAYMENT_HTML, '/swap': SWAP_HTML, '/popped': '<!doctype html><title>Popped</title><p>Popped</p>' };

const closers = [];
after(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => {}); });

// One fixture server plus one worker session per user message. Every test opens its own tab, so tests do not share page state.
async function harness(taskMessage) {
  const logs = [], sockets = new Set();
  const server = createServer((request, response) => {
    if (request.method === 'POST') { let body = ''; request.on('data', part => { body += part; }); request.on('end', () => { logs.push(body); response.end('ok'); }); return; }
    const path = new URL(request.url, 'http://x').pathname, port = server.address().port;
    // /framed embeds the controls from the same origin; /crossframe embeds them from localhost, another origin on the same server.
    const framed = src => '<!doctype html><title>Framed</title><h1>Outer page</h1><iframe src="' + src + '" width="700" height="600"></iframe>';
    response.setHeader('Content-Type', 'text/html');
    response.end(path === '/framed' ? framed('/') : path === '/crossframe' ? framed('http://localhost:' + port + '/') : pages[path] ?? pages['/']);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const session = await createSession({ origins: [origin], taskMessage });
  closers.push(() => session.close());
  const call = async (name, args) => {
    const request = { name, arguments: args }, result = await session.call(request);
    session.delivered?.(result, request); return result;
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 150));
  const api = {
    logs, origin, call,
    async open(path = '/') {
      const result = await call('browser_open', { url: origin + path });
      assert.equal(result.isError, false, result.text);
      const tab = /\bt[0-9a-f]{32}\b/.exec(result.text)?.[0];
      assert.ok(tab, result.text);
      return { tab, text: result.text };
    },
    // The ref of the first control whose line names it, from the newest read.
    async ref(tab, name, role = '') {
      const read = await call('browser_read', { tab }), pattern = new RegExp(role + '[^\\n]*"' + name + '"[^\\n]*\\[ref=((?:f\\d+)?[es]\\d+)\\]');
      const found = pattern.exec(read.text)?.[1];
      assert.ok(found, 'no ref for ' + name + ' in:\n' + read.text);
      return found;
    },
    async act(tab, steps) { const result = await call('browser_act', { tab, steps }); await settle(); return result; },
    async fill(tab, fields, submit) { const result = await call('browser_fill', { tab, fields, ...(submit ? { submit } : {}) }); await settle(); return result; },
    clear() { logs.length = 0; },
  };
  return api;
}
const sessions = new Map();
const world = message => { if (!sessions.has(message)) sessions.set(message, harness(message)); return sessions.get(message); };
const plain = () => world('Adjust the account controls.');

test('the read names closed-root controls whole, with s refs and no value garbling', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { text } = await w.open();
  for (const name of ['Two-factor authentication', 'Marketing emails', 'Display name', 'Region', 'Save preferences', 'Nested switch', 'Nested save', 'Account controls', 'Closed shadow controls'])
    assert.ok(text.includes(name), name + ' missing or redacted in:\n' + text);
  for (const [role, name] of [['switch', 'Two-factor authentication'], ['checkbox', 'Marketing emails'], ['textbox', 'Display name'], ['button', 'Save preferences']])
    assert.match(text, new RegExp('- ' + role + ' "' + name + '"[^\\n]*\\[ref=s\\d+\\]'));
});

test('a closed-root switch takes browser_fill, click and Space, and the page sees each toggle once', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open(), ref = await w.ref(tab, 'Two-factor authentication', 'switch');
  assert.match(ref, /^s\d+$/);
  let result = await w.fill(tab, [{ ref, value: true }]);
  assert.match(result.text, new RegExp(ref + ': set'), result.text);
  assert.deepEqual(w.logs.splice(0), ['switch sw true']);
  result = await w.fill(tab, [{ ref, value: false }]);
  assert.match(result.text, new RegExp(ref + ': set'), result.text);
  assert.deepEqual(w.logs.splice(0), ['switch sw false']);
  result = await w.act(tab, [{ do: 'click', ref }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['switch sw true']);
  // The switch is a focusable div, so the key goes only to a receiver the Node side proved is this node.
  result = await w.act(tab, [{ do: 'press', ref, key: 'Space' }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['switch sw false']);
  result = await w.fill(tab, [{ ref, value: false }]);
  assert.match(result.text, new RegExp(ref + ': set'), result.text);
  assert.deepEqual(w.logs, [], 'filling the state the switch already has must not toggle it');
});

test('a closed-root checkbox takes check, uncheck and fill', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open(), ref = await w.ref(tab, 'Marketing emails', 'checkbox');
  let result = await w.act(tab, [{ do: 'check', ref }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  result = await w.act(tab, [{ do: 'uncheck', ref }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  result = await w.fill(tab, [{ ref, value: true }]);
  assert.match(result.text, new RegExp(ref + ': set'), result.text);
  assert.deepEqual(w.logs.splice(0), ['check ck true', 'check ck false', 'check ck true']);
});

test('a closed-root text input takes type, fill and a key press', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open(), ref = await w.ref(tab, 'Display name', 'textbox');
  let result = await w.act(tab, [{ do: 'type', ref, text: 'Ada' }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  result = await w.fill(tab, [{ ref, value: 'Grace' }]);
  assert.match(result.text, new RegExp(ref + ': set'), result.text);
  result = await w.act(tab, [{ do: 'press', ref, key: 'ArrowDown' }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['text tx Ada', 'text tx Grace', 'key tx ArrowDown']);
  assert.doesNotMatch((await w.call('browser_read', { tab })).text, /Ada|Grace/, 'the typed value must stay redacted in reads');
});

test('a closed-root select takes an option label, a one-item list and the select step', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open(), ref = await w.ref(tab, 'Region');
  let result = await w.fill(tab, [{ ref, value: 'Asia' }]);
  assert.match(result.text, new RegExp(ref + ': set'), result.text);
  result = await w.fill(tab, [{ ref, value: ['Americas'] }]);
  assert.match(result.text, new RegExp(ref + ': set'), result.text);
  result = await w.act(tab, [{ do: 'select', ref, values: ['Europe'] }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['select sl ap', 'select sl us', 'select sl eu']);
});

test('a closed-root button is clicked once', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open(), ref = await w.ref(tab, 'Save preferences', 'button');
  const result = await w.act(tab, [{ do: 'click', ref }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['button bt']);
});

test('controls in nested closed roots take click, Space and a button click', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open();
  const inner = await w.ref(tab, 'Nested switch', 'switch'), save = await w.ref(tab, 'Nested save', 'button');
  const result = await w.act(tab, [{ do: 'click', ref: inner }, { do: 'press', ref: inner, key: 'Space' }, { do: 'click', ref: save }]);
  assert.equal(result.isError, false, result.text);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['switch inner true', 'switch inner false', 'button nested-save']);
});

test('a closed-root link opens an owned background tab like a light-DOM link', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open();
  const light = await w.ref(tab, 'Open help light', 'link'), closed = await w.ref(tab, 'Open help closed', 'link');
  // The tab list names origins only (output hygiene), so each click is judged by the one new tab that has this tab as its opener.
  const children = async () => (await w.call('browser_tabs', { do: 'list' })).text.split('\n').filter(line => line.includes('(opener ' + tab + ')')).length;
  for (const [index, ref] of [light, closed].entries()) {
    const result = await w.act(tab, [{ do: 'click', ref }]);
    assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
    assert.equal(await children(), index + 1, result.text);
  }
});

test('closed-root controls inside a same-origin iframe are acted on in that frame, including a key press', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open('/framed');
  const box = await w.ref(tab, 'Marketing emails', 'checkbox'), knob = await w.ref(tab, 'Two-factor authentication', 'switch');
  const result = await w.act(tab, [{ do: 'check', ref: box }, { do: 'press', ref: knob, key: 'Space' }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['check ck true', 'switch sw true']);
});

test('closed-root controls inside a cross-origin iframe take a click, and a key press is refused as in the light DOM', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open('/crossframe');
  const box = await w.ref(tab, 'Marketing emails', 'checkbox'), knob = await w.ref(tab, 'Two-factor authentication', 'switch');
  let result = await w.act(tab, [{ do: 'check', ref: box }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['check ck true']);
  result = await w.act(tab, [{ do: 'press', ref: knob, key: 'Space' }]);
  assert.match(result.text, /not run:/, result.text);
  // The light-DOM field in the same frame is refused the same way, so the closed root is no stricter than the page.
  const light = await w.ref(tab, 'Light note', 'textbox');
  result = await w.act(tab, [{ do: 'press', ref: light, key: 'ArrowDown' }]);
  assert.match(result.text, /not run:/, result.text);
  assert.deepEqual(w.logs, []);
});

test('a closed-root ref from before a reload is refused without sending input', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open(), ref = await w.ref(tab, 'Save preferences', 'button');
  let result = await w.act(tab, [{ do: 'reload' }]);
  assert.doesNotMatch(result.text, /unconfirmed/, result.text);
  result = await w.act(tab, [{ do: 'click', ref }]);
  assert.match(result.text, /not run:.*(stale|unavailable)/i, result.text);
  assert.deepEqual(w.logs, []);
  const fresh = await w.ref(tab, 'Save preferences', 'button');
  result = await w.act(tab, [{ do: 'click', ref: fresh }]);
  assert.doesNotMatch(result.text, /not run|unconfirmed/, result.text);
  assert.deepEqual(w.logs.splice(0), ['button bt']);
});

test('a disabled closed-root button is refused by the checked-target rule', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open();
  const read = await w.call('browser_read', { tab, find: 'Archive' });
  const ref = /\[disabled\][^\n]*\[ref=(s\d+)\]/.exec(read.text)?.[1];
  assert.ok(ref, read.text);
  const result = await w.act(tab, [{ do: 'click', ref }]);
  assert.match(result.text, /not run:/, result.text);
  assert.deepEqual(w.logs, []);
});

test('a closed-root Pay button in a card form asks for confirmation, and so does a closed Continue under a card form', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open('/pay');
  const pay = await w.ref(tab, 'Pay \\$18.00', 'button'), next = await w.ref(tab, 'Continue', 'button');
  for (const ref of [pay, next]) {
    const result = await w.act(tab, [{ do: 'click', ref }]);
    assert.match(result.text, /not run:.*confirmation required/, result.text);
  }
  // Keyboard activation of the same buttons is the same payment risk.
  const field = await w.ref(tab, 'Card number', 'textbox');
  const typed = await w.act(tab, [{ do: 'type', ref: field, text: '4242424242424242' }, { do: 'press', ref: field, key: 'Enter' }]);
  assert.doesNotMatch(typed.text, /4242424242424242/, 'a typed card number must never appear in a result');
  assert.deepEqual(w.logs.filter(line => line.startsWith('pay')), []);
});

test('the user\'s exact payment request lets the closed-root card form pay once', { skip, timeout: 90000 }, async () => {
  const w = await world(PAY), { tab } = await w.open('/pay');
  const pay = await w.ref(tab, 'Pay \\$18.00', 'button');
  const result = await w.act(tab, [{ do: 'click', ref: pay }]);
  assert.doesNotMatch(result.text, /not run|confirmation/, result.text);
  assert.deepEqual(w.logs.filter(line => line.startsWith('pay')), ['pay card-a']);
});

test('the exact payment request also covers a closed Continue whose terms sit in the page form', { skip, timeout: 90000 }, async () => {
  const w = await world(PAY + ' '), { tab } = await w.open('/pay');
  const next = await w.ref(tab, 'Continue', 'button');
  const result = await w.act(tab, [{ do: 'click', ref: next }]);
  assert.doesNotMatch(result.text, /not run|confirmation/, result.text);
  assert.deepEqual(w.logs.filter(line => line.startsWith('pay')), ['pay form-b']);
});

// Swap: the page replaces the control being clicked. A closed root must do no worse than the light DOM: whatever
// reaches the swapped-in control is the same, and nothing is clicked.
test('a control the page swaps out under the pointer is never clicked, closed or light', { skip, timeout: 90000 }, async () => {
  const w = await plain(), { tab } = await w.open('/swap');
  const seen = {};
  for (const kind of ['mouse', 'hover']) for (const where of ['closed', 'light']) {
    const name = 'Toggle details ' + where + '-' + kind, ref = await w.ref(tab, name, 'button');
    w.clear();
    const result = await w.act(tab, [{ do: 'click', ref }]);
    assert.equal(result.isError, false, result.text);
    seen[where + '-' + kind] = { events: w.logs.map(line => line.replace(where + '-' + kind, '*')), line: result.text.split('\n')[0] };
    assert.equal(w.logs.some(line => /^(swapped click|original)/.test(line)), false, name + ': ' + w.logs.join(' | '));
  }
  // Swapped on pointer arrival: the click never reaches the new control at all.
  for (const where of ['closed', 'light']) assert.deepEqual(seen[where + '-hover'].events, [], where + ' hover swap: ' + JSON.stringify(seen[where + '-hover']));
  // Swapped on mouse-down: the page may see the release on the new control, exactly as in the light DOM, and no more.
  assert.deepEqual(seen['closed-mouse'].events, seen['light-mouse'].events, JSON.stringify(seen));
});
