// Real pages, the real v3 worker over an owned headless Chromium: browser_fill picks an option of an ARIA combobox (an
// input with a filtering popup) or of a virtualised listbox by its visible text, keys reach a focused div that is proved
// to host no closed root, and an oversized scroll says it did not run. The page reports each choice to the fixture
// server, so every assertion reads what the page did from outside the worker's browser.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSession } from '../bench/turbo/v3-session.mjs';
import { COMBOBOX_HTML, AIRPORTS } from './fixtures/combobox-page.mjs';

const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'real-page qualification runs with SLEIGHT_LIVE_DOM_TEST=1';
const closers = [];
after(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => {}); });
const label = airport => airport.name + ' (' + airport.code + ')';
const HOST_HTML = COMBOBOX_HTML.replace('</main>', `<div id="host" role="group" aria-label="Closed host" tabindex="0"></div></main>
<script>const host = document.getElementById('host'), root = host.attachShadow({ mode: 'closed' });
root.innerHTML = '<input aria-label="Hidden input">'; host.addEventListener('focus', () => root.querySelector('input').focus());
host.addEventListener('keydown', event => fetch('/log', { method: 'POST', body: 'host key ' + event.key }));
root.querySelector('input').addEventListener('keydown', event => fetch('/log', { method: 'POST', body: 'hidden key ' + event.key }));</script>`);

async function harness() {
  const logs = [], sockets = new Set();
  const server = createServer((request, response) => {
    if (request.method === 'POST') { let body = ''; request.on('data', part => { body += part; }); request.on('end', () => { logs.push(body); response.end('ok'); }); return; }
    response.setHeader('Content-Type', 'text/html'); response.end(new URL(request.url, 'http://x').pathname === '/host' ? HOST_HTML : COMBOBOX_HTML);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const session = await createSession({ origins: [origin], taskMessage: 'Fill the airport and the departure fields on the fixture page.' });
  closers.push(() => session.close());
  const call = async (name, args) => { const request = { name, arguments: args }, result = await session.call(request); session.delivered?.(result, request); return result; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 150));
  return { logs, call, async open(path = '/') {
      const result = await call('browser_open', { url: origin + path });
      assert.equal(result.isError, false, result.text);
      return { tab: /\bt[0-9a-f]{32}\b/.exec(result.text)?.[0], text: result.text };
    },
    async ref(tab, name, role) {
      const read = await call('browser_read', { tab }), found = new RegExp(role + '[^\\n]*"' + name + '"[^\\n]*\\[ref=((?:f\\d+)?[es]\\d+)\\]').exec(read.text)?.[1];
      assert.ok(found, 'no ref for ' + name + ' in:\n' + read.text); return found;
    },
    async act(tab, steps, observe) { const result = await call('browser_act', { tab, steps, ...(observe ? { observe } : {}) }); await settle(); return result; },
    async fill(tab, fields) { const result = await call('browser_fill', { tab, fields }); await settle(); return result; },
    async text(tab, selector) { const read = await call('browser_read', { tab, find: selector }); return read.text; } };
}
const AT = AIRPORTS[251], OTHER = AIRPORTS[17];

test('browser_fill picks a combobox option by its full label, types once and reads the input back', { skip, timeout: 60000 }, async t => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Airport', 'combobox');
  const started = Date.now(), result = await h.fill(tab, [{ ref, value: label(AT) }]);
  assert.match(result.text, new RegExp(ref + ': set \\(chose "' + label(AT).replace(/[()]/g, '\\$&') + '"\\)'), result.text);
  assert.deepEqual(h.logs, ['chose ' + AT.code]);
  assert.match(await h.text(tab, 'combobox'), new RegExp(label(AT).replace(/[()]/g, '\\$&')));
  t.diagnostic('combobox fill: ' + (Date.now() - started) + ' ms');
  assert.ok(Date.now() - started < 8000, 'took ' + (Date.now() - started) + ' ms');
});

test('browser_fill matches the name without brackets, the name and code without brackets, and a unique name alone', { skip, timeout: 90000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Airport', 'combobox');
  for (const [airport, value] of [[AT, AT.name + ' ' + AT.code], [OTHER, label(OTHER).toLowerCase()], [AIRPORTS[333], AIRPORTS[333].name]]) {
    h.logs.length = 0;
    const result = await h.fill(tab, [{ ref, value }]);
    assert.match(result.text, new RegExp(ref + ': set'), result.text);
    assert.deepEqual(h.logs, ['chose ' + airport.code], value);
  }
});

test('browser_fill names the closest options when nothing matches and picks nothing', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Airport', 'combobox');
  const near = AT.name.split(' ')[0], result = await h.fill(tab, [{ ref, value: near + ' Nowhere Airport (ZZZ)' }]);
  assert.match(result.text, new RegExp(ref + ': failed: no option matches.*; the field holds the text typed while searching'), result.text);
  assert.deepEqual(h.logs, []);
  assert.match(await h.text(tab, 'combobox'), new RegExp(near + ' Nowhere Airport \\(ZZZ\\)'), 'the field holds the asked text, not the last shorter query');
});

test('browser_fill lists the options when the text matches several', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Airport', 'combobox');
  const result = await h.fill(tab, [{ ref, value: AT.name.split(' ').at(-1) + ' ' + AT.name.split(' ')[0].slice(0, 3) }]);
  assert.match(result.text, new RegExp(ref + ': failed: (several options match|no option matches)'), result.text);
  assert.deepEqual(h.logs, []);
});

test('browser_fill chooses a row of a virtual listbox with 400 rows in one call', { skip, timeout: 60000 }, async t => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Departing from', 'listbox');
  for (const airport of [AIRPORTS[399], AIRPORTS[3], AIRPORTS[222]]) {
    h.logs.length = 0; const started = Date.now();
    const result = await h.fill(tab, [{ ref, value: label(airport) }]);
    assert.match(result.text, new RegExp(ref + ': set'), result.text);
    assert.deepEqual(h.logs, ['plain ' + airport.code]);
    assert.match(await h.text(tab, 'option'), new RegExp(label(airport).replace(/[()]/g, '\\$&') + '[^\\n]*selected|selected[^\\n]*' + airport.code), 'the chosen row is marked selected');
    t.diagnostic('listbox row ' + AIRPORTS.indexOf(airport) + ': ' + (Date.now() - started) + ' ms');
    assert.ok(Date.now() - started < 8000, 'took ' + (Date.now() - started) + ' ms');
  }
});

test('browser_fill on a virtual listbox refuses a missing option with the closest rows and clicks nothing', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Departing from', 'listbox');
  const result = await h.fill(tab, [{ ref, value: AT.name.split(' ')[0] + ' Nowhere Intl (QQQ)' }]);
  assert.match(result.text, new RegExp(ref + ': failed: no option matches "[^"]+"; closest: "'), result.text);
  assert.deepEqual(h.logs, []);
});

test('keys reach the combobox input while aria-activedescendant names the option, and Enter chooses it', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Airport', 'combobox');
  const result = await h.act(tab, [{ do: 'type', ref, text: OTHER.name }, { do: 'wait' }, { do: 'press', ref, key: 'ArrowDown' }, { do: 'press', ref, key: 'Enter' }]);
  assert.doesNotMatch(result.text, /CHECKED_FOCUS_REQUIRED|not run/, result.text);
  assert.deepEqual(h.logs, ['chose ' + OTHER.code]);
});

test('a click on a popup option chooses it', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Airport', 'combobox');
  await h.act(tab, [{ do: 'type', ref, text: AT.code }, { do: 'wait' }]);
  const optionRef = await h.ref(tab, label(AT).replace(/[()]/g, '\\$&'), 'option');
  const result = await h.act(tab, [{ do: 'click', ref: optionRef }]);
  assert.doesNotMatch(result.text, /not run/, result.text);
  assert.deepEqual(h.logs, ['chose ' + AT.code]);
});

test('a focused div with role combobox takes arrow keys because the DOM agent shows it hosts no shadow root', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Sort order', 'combobox');
  const result = await h.act(tab, [{ do: 'click', ref }, { do: 'press', ref, key: 'ArrowDown' }, { do: 'press', key: 'ArrowDown' }]);
  assert.doesNotMatch(result.text, /CHECKED_FOCUS_REQUIRED|not run/, result.text);
  assert.deepEqual(h.logs, ['sort Duration', 'sort Departure']);
});

test('a focused div that hosts a closed shadow root still refuses keys', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open('/host'), ref = await h.ref(tab, 'Closed host', 'group');
  const result = await h.act(tab, [{ do: 'press', ref, key: 'ArrowDown' }]);
  assert.match(result.text, /CHECKED_FOCUS_REQUIRED/, result.text);
  assert.deepEqual(h.logs, []);
});

test('a scroll step past the 10000 limit is refused as not run, and a long list is reached with until', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Departing from', 'listbox');
  const refused = await h.act(tab, [{ do: 'scroll', ref, dy: 20000 }]);
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /dy up to 10000 per step.*until.*Nothing was sent/s, refused.text);
  assert.doesNotMatch(refused.text, /unconfirmed/);
  // The row a scroll finds can be clicked at once, even when the call asked for no observation.
  const found = await h.act(tab, [{ do: 'scroll', ref, until: label(AIRPORTS[150]), dy: 300 }], 'none');
  const row = /found[^\n]*option "[^"]*"[^\n]*\[ref=(e\d+)\]/.exec(found.text);
  assert.ok(row, found.text);
  const clicked = await h.act(tab, [{ do: 'click', ref: row[1] }], 'none');
  assert.doesNotMatch(clicked.text, /not run|stale/, clicked.text);
  assert.deepEqual(h.logs, ['plain ' + AIRPORTS[150].code]);
});

test('a wait on a ref works through the pinned handle', { skip, timeout: 60000 }, async () => {
  const h = await harness(), { tab } = await h.open(), ref = await h.ref(tab, 'Airport', 'combobox');
  const result = await h.act(tab, [{ do: 'wait', ref }]);
  assert.doesNotMatch(result.text, /not a function|not run|unconfirmed/, result.text);
});
