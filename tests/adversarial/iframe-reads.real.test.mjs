import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, readOnly, skip } from './fixtures/bank.mjs';

// browser_read on pages that embed iframes in other processes (every real site has some: ads, payment fields, video, chat). The
// snapshot opens a CDP session per frame, and the filter used to refuse every iframe target, so the read failed on all of them.
// The filter now attaches a private read session to an iframe it received from an owned page's own auto-attach chain, and to
// nothing else. These tests read pages with 1, 2 and 5 cross-site iframes, compare a cross-site frame with a same-origin one, and
// try to use the attach path on other tabs, workers and the browser target.
const N = Number(process.env.N ?? 4);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const X = port => 'http://localhost:' + port; // another site than the page (127.0.0.1)
const secrets = ['hunter2-secret', '4111 1111 1111 1111', 'cvc-0042-secret'];
// Each frame has visible text, a labelled password, a card number field, a neutrally named password, and a card number in text.
const frameBody = k => `<!doctype html><title>frame ${k}</title><h2>Frame ${k} headline</h2><p>Visible copy of frame ${k}</p>
<label>Password <input type=password value="${secrets[0]}"></label>
<label>Card number <input autocomplete="cc-number" value="${secrets[1]}"></label>
<input type=password aria-label="Reference ${k}" value="${secrets[2]}">
<p>Saved card ${secrets[1]}</p><button>Pay in frame ${k}</button>`;
const frames = (count, host) => Object.fromEntries(Array.from({ length: count }, (_, i) => ['/frame' + (i + 1), frameBody(i + 1)]));
const page = (port, count) => `<h1>Top of page</h1><input id="a" aria-label="Search">${Array.from({ length: count },
  (_, i) => `<iframe src="${X(port)}/frame${i + 1}" title="embed ${i + 1}" width=300 height=200></iframe>`).join('')}`;
const totals = { ok: 0, all: 0 };

for (const count of [1, 2, 5]) test(`browser_read on a page with ${count} cross-site iframe(s): ${N} reads, frame text in, secrets out`, { skip, timeout: 300000 }, async t => {
  const b = await bank(t), port = new URL(b.origin).port;
  const f = await b.start(doc(page(port, count)), readOnly, { route: '/p-' + count, routes: frames(count) });
  await sleep(600);
  assert.equal(f.page.frames().length, count + 1, 'Playwright knows every frame');
  const failures = [];
  for (let n = 0; n < N; n++) {
    let text;
    totals.all++;
    try { text = await f.read(); } catch (e) { failures.push('read ' + n + ': ' + e.message.split('\n')[0]); continue; }
    const missing = [];
    for (let k = 1; k <= count; k++) for (const want of [`Frame ${k} headline`, `Visible copy of frame ${k}`, `Pay in frame ${k}`])
      if (!text.includes(want)) missing.push(want);
    if (missing.length) { failures.push('read ' + n + ' lacks ' + missing.join(', ')); continue; }
    for (const secret of secrets) if (text.includes(secret)) { failures.push('read ' + n + ' leaked ' + secret); }
    // Every password and card field of every frame is a redacted row.
    const redacted = text.split('\n').filter(line => /textbox/.test(line) && /: "\[redacted\]"/.test(line)).length;
    if (redacted < count * 3) failures.push('read ' + n + ': ' + redacted + ' redacted fields, wanted ' + count * 3);
    if (!failures.some(x => x.startsWith('read ' + n))) totals.ok++;
  }
  t.diagnostic(JSON.stringify({ count, failures }));
  assert.deepEqual(failures, []);
  for (const secret of secrets) assert.ok(!b.transcript().includes(secret), 'a secret reached tool output: ' + secret);
  assert.equal(f.page.frames().length, count + 1, 'the read sessions did not change the page\'s frames');
  await f.safe();
});

test('a cross-site iframe is read and redacted exactly like a same-origin one', { skip, timeout: 120000 }, async t => {
  const b = await bank(t), port = new URL(b.origin).port;
  const body = `<h1>Top</h1><iframe src="/same" title="same"></iframe><iframe src="${X(port)}/cross" title="cross"></iframe>`;
  const f = await b.start(doc(body), readOnly, { route: '/parity', routes: { '/same': frameBody(1), '/cross': frameBody(1) } });
  await sleep(600);
  const text = await f.read();
  // The two iframe subtrees (each starts at "- iframe", children are indented deeper), with refs removed.
  const lines = text.split('\n'), subtrees = [];
  lines.forEach((line, i) => {
    if (!/^\s*- iframe/.test(line)) return;
    const indent = /^\s*/.exec(line)[0].length, rows = [];
    for (let j = i + 1; j < lines.length && /^\s*/.exec(lines[j])[0].length > indent; j++) rows.push(lines[j].replace(/\s*\[ref=[^\]]+\]/, '').trim());
    subtrees.push(rows);
  });
  assert.equal(subtrees.length, 2, text);
  assert.ok(subtrees[0].length >= 8, 'same-origin frame rows: ' + subtrees[0].join(' | '));
  assert.deepEqual(subtrees[1], subtrees[0], 'cross-site rows differ from same-origin rows');
  for (const secret of secrets) assert.ok(!text.includes(secret), secret);
  assert.equal(text.split('\n').filter(line => /textbox/.test(line) && /\[redacted\]/.test(line)).length, 6);
  await f.safe();
});

// Opaque-origin sandboxed iframes (no allow-same-origin) and script-less ones: Playwright knows them as frames and the snapshot
// opens a session for each, so they take the same scoped attach. A sandboxed frame with a password field is scanned and redacted.
for (const [name, attr, host] of [['sandbox (opaque origin, same-site src)', 'sandbox', ''], ['sandbox="allow-same-origin" without scripts', 'sandbox="allow-same-origin"', ''],
  ['sandbox="allow-scripts" (opaque origin)', 'sandbox="allow-scripts"', ''], ['sandbox="allow-scripts allow-same-origin"', 'sandbox="allow-scripts allow-same-origin"', ''],
  ['sandbox on a cross-site src', 'sandbox', 'X']]) test('browser_read on a page with a sandboxed iframe: ' + name, { skip, timeout: 120000 }, async t => {
  const b = await bank(t), port = new URL(b.origin).port, src = (host ? X(port) : '') + '/sbx';
  const f = await b.start(doc(`<h1>Top</h1><iframe ${attr} src="${src}" title="sandboxed"></iframe>`), readOnly, { route: '/sbx-page', routes: { '/sbx': frameBody(1) } });
  await sleep(600);
  const failures = [];
  for (let n = 0; n < N; n++) {
    let text;
    try { text = await f.read(); } catch (e) { failures.push('read ' + n + ': ' + e.message.split('\n')[0]); continue; }
    if (!text.includes('Frame 1 headline') || !text.includes('Pay in frame 1')) failures.push('read ' + n + ' lacks the frame text');
    for (const secret of secrets) if (text.includes(secret)) failures.push('read ' + n + ' leaked ' + secret);
    if (text.split('\n').filter(line => /textbox/.test(line) && /: "\[redacted\]"/.test(line)).length < 3) failures.push('read ' + n + ' did not redact all three fields');
  }
  t.diagnostic(JSON.stringify({ name, failures }));
  assert.deepEqual(failures, []);
  await f.safe();
});

test('the read path cannot attach to other tabs, workers, service workers, the browser, or a frame of another tab', { skip, timeout: 120000 }, async t => {
  const b = await bank(t), port = new URL(b.origin).port;
  const routes = { '/frame1': frameBody(1), '/foreign-ad': '<!doctype html><p>foreign frame</p>', '/worker.js': 'self.onmessage=()=>{}; setInterval(()=>{},1000)',
    '/sw.js': 'self.addEventListener("fetch",()=>{})',
    '/foreign': `<!doctype html><title>foreign</title><iframe src="${X(port)}/foreign-ad"></iframe><script>navigator.serviceWorker.register('/sw.js').catch(()=>{})</script>`,
    '/popup': '<!doctype html><title>popup</title><p>unadopted popup</p>' };
  const body = `<h1>Top</h1><iframe src="${X(port)}/frame1" title="embed"></iframe>
<script>window.w=new Worker('/worker.js')</script>`;
  const f = await b.start(doc(body), readOnly, { route: '/attach', routes });
  // Another tab of the harness browser, with its own cross-site iframe and a service worker, and a popup nobody adopted.
  const other = await b.host.newPage();
  await other.goto(b.origin + '/foreign');
  await other.waitForFunction(() => navigator.serviceWorker.ready.then(() => true), null, { timeout: 8000 });
  await f.page.evaluate(url => { window.open(url, '_blank'); }, `${X(port)}/popup`).catch(() => {});
  await sleep(700);
  const all = (await b.raw.send('Target.getTargets')).targetInfos;
  const ownedPage = f.page.url();
  const byUrl = suffix => all.filter(info => info.url.endsWith(suffix));
  const ours = byUrl('/frame1')[0], foreignFrame = byUrl('/foreign-ad')[0], worker = all.find(info => info.type === 'worker' && info.url.endsWith('/worker.js')),
    serviceWorker = all.find(info => info.type === 'service_worker'), foreignTab = all.find(info => info.url === b.origin + '/foreign'),
    popup = all.find(info => info.url.endsWith('/popup'));
  assert.ok(ours && foreignFrame && worker && serviceWorker && foreignTab, JSON.stringify(all.map(i => [i.type, i.url])));
  assert.equal(ours.type, 'iframe');
  const refused = [];
  const attempt = async (name, info) => {
    const before = b.wire.length;
    let result;
    try { result = await b.session.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }); } catch (e) { result = { error: e.message }; }
    const sent = b.wire.slice(before).filter(call => call.method === 'Target.attachToTarget' && call.params.targetId === info.targetId).length;
    refused.push({ name, error: result.error, upstream: sent });
    return result;
  };
  // Every target of the browser except the owned page and its one cross-site iframe, whatever its type.
  const targets = all.filter(info => info.targetId !== ours.targetId && info.url !== ownedPage);
  assert.ok(targets.length >= 4, JSON.stringify(targets.map(i => [i.type, i.url])));
  for (const info of [...targets, { type: 'made-up', url: '', targetId: 'A'.repeat(32) }, { type: 'browser', url: '', targetId: 'browser' }]) {
    const result = await attempt(info.type + ' ' + info.url, info);
    assert.ok(result.error && /CDP_TARGET_NOT_OWNED|CDP_ATTACHMENT_INVALID|CDP_COMMAND_REFUSED/.test(result.error), info.type + ': ' + JSON.stringify(result));
  }
  t.diagnostic(JSON.stringify(refused));
  assert.deepEqual(refused.filter(row => row.upstream !== 0), [], 'the filter sent an attach upstream for a target it must refuse');
  // The owned page's iframe is the one target that works, and the session it returns is read-only.
  const frame = f.page.frames().find(x => x.url().endsWith('/frame1'));
  const cdp = await f.page.context().newCDPSession(frame);
  const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
  assert.ok(snapshot.strings.some(s => s.includes('Frame 1 headline')));
  for (const [method, params] of [['Target.attachToTarget', { targetId: foreignTab.targetId, flatten: true }], ['Target.attachToTarget', { targetId: worker.targetId, flatten: true }],
    ['Target.createTarget', { url: 'about:blank' }], ['Target.setAutoAttach', { autoAttach: true, flatten: true }], ['Target.getTargets', {}],
    ['Target.attachToBrowserTarget', {}], ['Network.getAllCookies', {}], ['Page.bringToFront', {}]]) {
    await assert.rejects(cdp.send(method, params), /CDP_|Protocol error/, method);
  }
  assert.equal(b.wire.filter(call => call.method === 'Target.attachToTarget' && [foreignTab.targetId, worker.targetId].includes(call.params.targetId)).length, 0);
  await cdp.detach();
  await assert.rejects(cdp.send('DOMSnapshot.captureSnapshot', {}), /closed|detached/i);
  // The page still reads, and the other tab was not touched.
  assert.match(await f.read(), /Frame 1 headline/);
  assert.equal(await other.title(), 'foreign');
  assert.ok(ownedPage.includes('/attach'));
  await other.close();
  await f.safe();
});

test('iframe reads: 12 of 12 reads succeed (1, 2 and 5 cross-site iframes, four reads each)', { skip }, () => {
  console.log('RESULT iframe reads ' + totals.ok + '/' + totals.all);
  assert.equal(totals.ok, totals.all);
  assert.equal(totals.all, 3 * N);
});
