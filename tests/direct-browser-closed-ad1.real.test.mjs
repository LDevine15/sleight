// Controls inside CLOSED shadow roots go through the same AD1 safety layer as other refs, on real pages and the real v3 worker:
// the click seal (a form or label changed while the click is in flight is cancelled), the popup hook (a link that flips to a new
// tab is opened in the background), the payment rules (a figure above the amount asked for, a script button in a card form) and
// the key shield (Enter in a closed field is sent through it, and a swap on the key cancels it). Every attack has a control that
// is the same page without the attack. The light-DOM twin of the click swap is run beside the closed one.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSession } from '../bench/turbo/v3-session.mjs';
import { SEAL_HTML, FLIP_HTML, EXTRA_HTML, KEYS_HTML, COVER_HTML } from './fixtures/closed-ad1-page.mjs';

const skip = process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'real-page qualification runs with SLEIGHT_LIVE_DOM_TEST=1';
const PAY = 'Pay {"item":"Fixture mug","amount":"18.00","payee":"Fixture shop","method":"Fixture card","currency":"USD"}';
const pages = { '/seal': SEAL_HTML, '/flip': FLIP_HTML, '/extra': EXTRA_HTML, '/keys': KEYS_HTML, '/cover': COVER_HTML, '/popped': '<!doctype html><title>Popped</title><p>Popped</p>' };

const closers = [];
after(async () => { for (const close of closers.splice(0).reverse()) await close().catch(() => {}); });

async function harness(taskMessage) {
  const logs = [], hits = [], sockets = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    if (request.method === 'POST' && path === '/log') { let body = ''; request.on('data', part => { body += part; }); request.on('end', () => { logs.push(body); response.end('ok'); }); return; }
    if (path === '/charge' || path === '/ok') hits.push(request.method + ' ' + path);
    response.setHeader('Content-Type', 'text/html');
    response.end(pages[path] ?? '<!doctype html><title>Done</title><p>Done</p>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const session = await createSession({ origins: [origin], taskMessage });
  closers.push(() => session.close());
  const call = async (name, args) => { const request = { name, arguments: args }, result = await session.call(request); session.delivered?.(result, request); return result; };
  const settle = () => new Promise(resolve => setTimeout(resolve, 250));
  return {
    logs, hits, call,
    async open(path) {
      const result = await call('browser_open', { url: origin + path });
      assert.equal(result.isError, false, result.text);
      const tab = /\bt[0-9a-f]{32}\b/.exec(result.text)?.[0];
      assert.ok(tab, result.text);
      return tab;
    },
    async ref(tab, name, role = '') {
      const read = await call('browser_read', { tab }), pattern = new RegExp(role + '[^\\n]*"' + name + '"[^\\n]*\\[ref=((?:f\\d+)?[es]\\d+)\\]');
      const found = pattern.exec(read.text)?.[1];
      assert.ok(found, 'no ref for ' + name + ' in:\n' + read.text);
      return found;
    },
    async act(tab, steps) { const result = await call('browser_act', { tab, steps }); await settle(); return result; },
    clear() { logs.length = 0; hits.length = 0; },
  };
}
const worlds = new Map();
const world = message => { if (!worlds.has(message)) worlds.set(message, harness(message)); return worlds.get(message); };
const plain = () => world('Adjust the account controls.');
const charged = w => w.hits.filter(hit => hit.endsWith('/charge'));

test('a closed-root submit button on a form that changes its action on pointerdown is cancelled, like the light-DOM twin', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/seal');
  const outcomes = {};
  for (const name of ['action', 'light-action']) {
    w.clear();
    const ref = await w.ref(tab, 'Save ' + name, 'button'), result = await w.act(tab, [{ do: 'click', ref }]);
    outcomes[name] = { line: result.text.split('\n')[0], logs: [...w.logs], charged: charged(w).length };
    assert.equal(charged(w).length, 0, name + ': ' + JSON.stringify(outcomes[name]));
    assert.equal(w.logs.some(line => /action=\/charge/.test(line)), false, name + ': ' + JSON.stringify(outcomes[name]));
    assert.match(result.text, /not run|unconfirmed|page changed during the click/, name + ': ' + result.text);
  }
});

test('a closed-root Save with no attack on the page submits once to the form\'s own action', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/seal');
  const ref = await w.ref(tab, 'Save plain', 'button');
  w.clear();
  const result = await w.act(tab, [{ do: 'click', ref }]);
  assert.doesNotMatch(result.text, /not run|page changed during the click/, result.text);
  assert.deepEqual(w.logs, ['submit plain action=/ok']);
  assert.deepEqual(charged(w), []);
});

test('a closed-root button whose words change into a payment word on pointerdown is not clicked', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/seal');
  const ref = await w.ref(tab, 'Save label', 'button');
  w.clear();
  const result = await w.act(tab, [{ do: 'click', ref }]);
  assert.match(result.text, /not run|unconfirmed|page changed during the click/, result.text);
  assert.deepEqual(w.logs, [], 'the form must not submit after its button changed into "Pay now": ' + result.text);
});

test('a closed-root link that turns into a new-tab link in its click handler is handled like its light-DOM twin, and opens no foreground tab', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/flip');
  const children = async () => (await w.call('browser_tabs', { do: 'list' })).text.split('\n').filter(line => line.includes('(opener ' + tab + ')')).length;
  const lines = {};
  for (const [index, name] of ['Open flipped light', 'Open flipped closed'].entries()) {
    const ref = await w.ref(tab, name, 'link'), result = await w.act(tab, [{ do: 'click', ref }]);
    lines[name] = result.text.split('\n')[0].replace(/ref=\w+/, '');
    assert.equal(await children(), index + 1, name + ': ' + result.text);
  }
  const shape = line => line.replace(/^\d+ click \w+: /, '').replace(/\bt[0-9a-f]{32}\b/g, 'TAB').replace(/https?:\/\/\S+/g, 'URL');
  assert.equal(shape(lines['Open flipped closed']), shape(lines['Open flipped light']), JSON.stringify(lines));
  // The opener stays where it was: the flipped link did not navigate it.
  assert.match((await w.call('browser_read', { tab })).text, /Open flipped closed/);
});

test('a closed-root form that turns into a new-tab form in its button\'s click handler is cancelled like its light-DOM twin', { skip, timeout: 120000 }, async () => {
  const w = await plain();
  const outcomes = {};
  for (const name of ['Send flipped light form', 'Send flipped closed form']) {
    const tab = await w.open('/flip');
    w.clear();
    const result = await w.act(tab, [{ do: 'click', ref: await w.ref(tab, name, 'button') }]);
    outcomes[name] = result.text.split('\n')[0].replace(/^\d+ click \w+: /, '').replace(/\bt[0-9a-f]{32}\b/g, 'TAB');
    assert.deepEqual(charged(w), [], name + ': ' + outcomes[name]);
  }
  assert.equal(outcomes['Send flipped closed form'], outcomes['Send flipped light form'], JSON.stringify(outcomes));
});

test('a closed-root card form with a figure above the requested amount asks even when the message names the exact payment', { skip, timeout: 120000 }, async () => {
  const w = await world(PAY), tab = await w.open('/extra');
  const extra = await w.ref(tab, 'Pay \\$18.00 extra', 'button');
  let result = await w.act(tab, [{ do: 'click', ref: extra }]);
  assert.match(result.text, /not run:.*confirmation required/, result.text);
  assert.deepEqual(w.logs.filter(line => line.startsWith('pay')), []);
  // The same form without the extra figure pays once on the exact request.
  const ok = await w.ref(tab, 'Pay \\$18.00 ok', 'button');
  result = await w.act(tab, [{ do: 'click', ref: ok }]);
  assert.doesNotMatch(result.text, /not run|confirmation/, result.text);
  assert.deepEqual(w.logs.filter(line => line.startsWith('pay')), ['pay card-ok']);
});

test('a closed-root script button (a div) in a card form asks for a click and for Enter', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/extra');
  const button = await w.ref(tab, 'Continue to review', 'button');
  for (const steps of [[{ do: 'click', ref: button }], [{ do: 'press', ref: button, key: 'Enter' }], [{ do: 'press', ref: button, key: 'Space' }]]) {
    const result = await w.act(tab, steps);
    assert.match(result.text, /not run:/, JSON.stringify(steps) + ' ' + result.text);
  }
  assert.deepEqual(w.logs.filter(line => line.startsWith('pay')), []);
  // The user's exact payment request covers it once, as it covers a closed Continue button.
  const exact = await world(PAY + '  '), exactTab = await exact.open('/extra');
  const result = await exact.act(exactTab, [{ do: 'click', ref: await exact.ref(exactTab, 'Continue to review', 'button') }]);
  assert.doesNotMatch(result.text, /not run|confirmation/, result.text);
  assert.deepEqual(exact.logs.filter(line => line.startsWith('pay')), ['pay div']);
});

test('Enter in a closed-root field submits its form once through the key shield', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/keys');
  const field = await w.ref(tab, 'Field plain', 'textbox');
  w.clear();
  const result = await w.act(tab, [{ do: 'press', ref: field, key: 'Enter' }]);
  assert.doesNotMatch(result.text, /not run|key may have activated/, result.text);
  assert.deepEqual(w.logs, ['submit plain action=/ok']);
});

test('Enter in a closed-root field is cancelled when the page changes the form\'s action on keydown', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/keys');
  const field = await w.ref(tab, 'Field swap', 'textbox');
  w.clear();
  const result = await w.act(tab, [{ do: 'press', ref: field, key: 'Enter' }]);
  assert.deepEqual(charged(w), [], result.text);
  assert.equal(w.logs.some(line => /action=\/charge/.test(line)), false, w.logs.join(' | ') + ' / ' + result.text);
  assert.match(result.text, /not run|key may have activated|changed/, result.text);
});

test('Enter in a closed-root field whose keydown handler moves focus elsewhere is not sent to the other field', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/keys');
  const field = await w.ref(tab, 'Field focus', 'textbox');
  w.clear();
  const result = await w.act(tab, [{ do: 'press', ref: field, key: 'Enter' }]);
  assert.equal(w.logs.some(line => /^elsewhere (keydown|keypress) Enter$/.test(line)), false, w.logs.join(' | ') + ' / ' + result.text);
});

// The window-level guard sees only the closed host in an event's path, so the hook also listens on each closed root above the checked
// element (page.mjs rootGuard). Without that, the trap below gets the release (pointerup, mouseup) and a sibling gets the key.
test('a trap button slid over a closed-root button in the same root receives no event, like the light-DOM twin', { skip, timeout: 120000 }, async () => {
  const w = await plain(), seen = {};
  for (const where of ['light', 'closed', 'nested']) {
    const tab = await w.open('/cover');
    w.clear();
    const result = await w.act(tab, [{ do: 'click', ref: await w.ref(tab, 'Toggle details ' + where, 'button') }]);
    seen[where] = { line: result.text.split('\n')[0].replace(/^\d+ click \w+: /, ''), logs: w.logs.map(line => line.replace(where, '*')) };
  }
  // The light-DOM twin: the shield cancels the release and click that land on the trap. The closed root is guarded from inside
  // (the hook listens on each closed root above the checked element), so the trap gets no event there either.
  assert.deepEqual(seen.light.logs, [], JSON.stringify(seen.light));
  assert.deepEqual(seen.closed, seen.light, JSON.stringify(seen));
  assert.deepEqual(seen.nested, seen.light, 'a closed root inside a closed root: ' + JSON.stringify(seen));
});

test('Enter in a closed-root field whose keydown handler moves focus to a sibling in the same root does not reach the sibling', { skip, timeout: 120000 }, async () => {
  const w = await plain(), tab = await w.open('/keys');
  const field = await w.ref(tab, 'Field sibling', 'textbox');
  w.clear();
  const result = await w.act(tab, [{ do: 'press', ref: field, key: 'Enter' }]);
  assert.equal(w.logs.some(line => /^sibling keypress /.test(line)), false, w.logs.join(' | ') + ' / ' + result.text);
  assert.equal(w.logs.some(line => /^submit /.test(line)), false, w.logs.join(' | ') + ' / ' + result.text);
});
