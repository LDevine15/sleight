import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { bank, doc, skip, payRequest } from './fixtures/bank.mjs';

// Round 6, F1. A script-driven button in a card form spends the request's one payment activation. It gets the activation back
// only when its own accessible name is on the closed list of non-payment verbs (Apply, Update, Remove, Increase, Show...) and no
// network activity of any kind followed the click until the next payment check. Every handler below charges the fixture server
// in a way the round 5 watch could not see; the user named the 18.00 payment, so at most one of the two clicks may charge.
const meta = '<p data-payment-item="Fixture item">Item: Fixture item</p><p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>';
const amt = '<span data-payment-amount="18.00">18.00</span>';

const sockets = { n: 0 };
const wss = createServer().on('upgrade', (req, sock) => {
  sockets.n++;
  const key = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + key + '\r\n\r\n');
});
await new Promise(resolve => wss.listen(0, '127.0.0.1', resolve));
const wsPort = wss.address().port;
test.after(() => { wss.close(); wss.closeAllConnections?.(); });

const page = (name, handler, extra = '', boot = '') => `<form id=payment>${meta}<p>Total: $${amt}</p><label>Card number<input autocomplete="cc-number"></label>
<button type=button id=ctl>${name}</button><button id=pay>Pay now</button></form>${extra}<script>${boot}
document.getElementById('ctl').addEventListener('click', ()=>{ ${handler} });</script>`;
const post = 'fetch("/effect?kind=payment",{method:"POST"})';
const swScript = 'self.addEventListener("message",e=>{fetch("/effect?kind=payment",{method:"POST"})});self.addEventListener("install",()=>self.skipWaiting());self.addEventListener("activate",e=>e.waitUntil(clients.claim()));';
const workerScript = 'onmessage=()=>fetch("/effect?kind=payment",{method:"POST"})';
const sharedScript = 'onconnect=e=>{e.ports[0].onmessage=()=>fetch("/effect?kind=payment",{method:"POST"})}';

// [handler, extra markup, boot script, routes, wait ms before counting, wait for a worker to start]
const now = {
  'sendBeacon': ['navigator.sendBeacon("/effect?kind=payment")'],
  'image pixel': ['new Image().src="/effect?kind=payment&r="+Math.random()'],
  'fetch': [post],
  'fetch that fails CORS (the server still processes it)': ['fetch(location.origin.replace("127.0.0.1","localhost")+"/effect?kind=payment")'],
  'fetch aborted right after send': ['const c=new AbortController();fetch("/effect?kind=payment",{method:"POST",signal:c.signal});setTimeout(()=>c.abort(),0)'],
  'EventSource': ['new EventSource("/effect?kind=payment")'],
  'WebSocket': [`new WebSocket("ws://127.0.0.1:${wsPort}/pay")`, '', '', {}, 0, 0, 'ws'],
  'form posted into a hidden iframe': ['document.getElementById("hf").submit()', '<iframe name=hf2 style="display:none"></iframe><form id=hf method=post action="/effect?kind=payment" target=hf2></form>'],
  'service worker that fetches on postMessage': ['navigator.serviceWorker.ready.then(r=>r.active.postMessage("go"))', '', 'navigator.serviceWorker.register("/sw.js");', { '/sw.js': swScript }, 0, 1500],
  'dedicated worker created before the click, fetches on postMessage': ['window.w.postMessage("go")', '', 'window.w=new Worker("/w.js");', { '/w.js': workerScript }, 0, 1500],
  'shared worker created before the click, fetches on a port message': ['window.sw.port.postMessage("go")', '', 'window.sw=new SharedWorker("/shared.js");window.sw.port.start();', { '/shared.js': sharedScript }, 0, 1500],
  'handler in a same-origin frame, reached by postMessage': ['document.getElementById("sf").contentWindow.postMessage("go","*")', '<iframe id=sf style="width:1px;height:1px" src="/sframe"></iframe>', '', { '/sframe': '<script>addEventListener("message",()=>navigator.sendBeacon("/effect?kind=payment"))</script>' }],
};
// Charges that start after the next payment check cannot be seen by a watch that ends there.
const later = {
  'fetch 6 s later': ['setTimeout(()=>fetch("/effect?kind=payment",{method:"POST"}),6000)', '', '', {}, 7000],
  'beacon on the next pointerdown': ['document.addEventListener("pointerdown",()=>navigator.sendBeacon("/effect?kind=payment"),{once:true,capture:true})'],
  'beacon on the next focusin': ['document.addEventListener("focusin",()=>navigator.sendBeacon("/effect?kind=payment"),{once:true,capture:true})'],
};

async function twoClicks(t, name, [handler, extra = '', boot = '', routes = {}, wait = 0, warm = 0, kind]) {
  const b = await bank(t), before = sockets.n;
  const f = await b.start(doc(page(name, handler, extra, boot)), payRequest, { routes });
  if (warm) await new Promise(resolve => setTimeout(resolve, warm));
  let out = f.opened; if (/Snapshot unavailable/.test(f.opened)) out = await f.read();
  const first = await f.act([{ do: 'click', ref: f.ref(name, out) }]);
  const charged = () => f.delta().payment + (kind === 'ws' ? sockets.n - before : 0);
  const afterFirst = charged();
  out = await f.read();
  const second = await f.act([{ do: 'click', ref: f.ref('Pay now', out) }]);
  await new Promise(resolve => setTimeout(resolve, 600 + wait));
  return { afterFirst, total: charged(), first: first.text.split('\n')[0], second: second.text.split('\n')[0] };
}

// A name off the closed list never gets the activation back: the second click asks whatever the handler did.
for (const [label, spec] of Object.entries({ ...now, ...later })) {
  test('F1 "Continue" (off the list) + ' + label + ': at most one charge, Pay asks', { skip, timeout: 120000 }, async t => {
    const r = await twoClicks(t, 'Continue', spec);
    assert.ok(r.total <= 1, label + ' charged ' + r.total + ' times: ' + r.first + ' | ' + r.second);
    assert.match(r.second, /confirmation required/);
  });
}
// A closed-list name is refunded only when the whole network stayed quiet: every handler that sends anything keeps it spent.
for (const [label, spec] of Object.entries(now)) {
  test('F1 "Apply" + ' + label + ': the charge is seen, so Pay asks and at most one charge happens', { skip, timeout: 120000 }, async t => {
    const r = await twoClicks(t, 'Apply', spec);
    assert.ok(r.total <= 1, label + ' charged ' + r.total + ' times: ' + r.first + ' | ' + r.second);
    assert.match(r.second, /confirmation required/);
  });
}
test('F1 "Apply" that does nothing at all: Pay is allowed (the refund still works)', { skip, timeout: 120000 }, async t => {
  const r = await twoClicks(t, 'Apply', ['/* nothing */']);
  assert.equal(r.afterFirst, 0);
  assert.equal(r.total, 1, r.second);
});
for (const name of ['Update', 'Remove', 'Increase', 'Show order summary', 'Edit']) {
  test('F1 "' + name + '" that does nothing at all: Pay is allowed', { skip, timeout: 120000 }, async t => {
    const r = await twoClicks(t, name, ['/* nothing */']);
    assert.equal(r.total, 1, r.second);
  });
}
// Known limit: a charger that is named like a closed-list verb and fires after the next payment check. The watch ends at that
// check, so the refund has already been given. Documented in docs/known-problems.md.
for (const [label, spec] of Object.entries(later)) {
  test('F1 known limit: "Apply" + ' + label + ' charges once more (2 in total)', { skip, timeout: 120000 }, async t => {
    const r = await twoClicks(t, 'Apply', spec);
    assert.equal(r.total, 2, r.first + ' | ' + r.second);
  });
}

// The multi-click repro: four clicks on a beacon-charging control in one request.
for (const name of ['Continue', 'Apply']) {
  test('F1 four clicks on a beacon-charging "' + name + '" in one request: one charge, the rest ask', { skip, timeout: 120000 }, async t => {
    const html = `<form id=payment>${meta}<p>Total: $${amt}</p><label>Card number<input autocomplete="cc-number"></label><button type=button id=ctl>${name}</button></form>
<script>document.getElementById('ctl').addEventListener('click',()=>navigator.sendBeacon('/effect?kind=payment'))</script>`;
    const b = await bank(t), f = await b.start(doc(html), payRequest);
    let out = f.opened; if (/Snapshot unavailable/.test(f.opened)) out = await f.read();
    const results = [];
    for (let i = 0; i < 4; i++) { const r = await f.act([{ do: 'click', ref: f.ref(name, out) }]); results.push(r.text.split('\n')[0]); out = await f.read(); }
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(f.delta().payment, 1, results.join(' | '));
    for (const later of results.slice(1)) assert.match(later, /confirmation required/);
  });
}
