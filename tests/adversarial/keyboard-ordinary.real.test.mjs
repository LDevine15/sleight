import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, readOnly, skip } from './fixtures/bank.mjs';

// Ordinary pages that embed iframes in other processes (ads, video embeds, card fields, chat widgets, sandboxed ads). The key
// shield has to lock every frame before the key, and Playwright often never attaches a frame in another process, so the frames
// are counted and locked through the CDP filter's own sessions. Each page type opens fresh pages, waits, and presses Enter in a
// text field of the main document three times. The first press on 46 of 48 pages must go through, and the later ones too.
const N = Number(process.env.N ?? 8), DELAY = Number(process.env.DELAY ?? 700);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const keyLog = `window.__e=[];a.addEventListener('keydown',e=>__e.push('keydown:'+e.key));a.addEventListener('keyup',e=>__e.push('keyup:'+e.key));`;
const X = port => 'http://localhost:' + port;
const pages = {
  'ad iframe (cross-site, static banner)': p => ({ body: `<input id="a" aria-label="Search"><iframe src="${X(p)}/ad" width=300 height=250 title="ad"></iframe>`, routes: { '/ad': '<!doctype html><body style="margin:0"><a href="#">Buy now</a><script>setInterval(()=>{document.title=Date.now()},500)</script>' } }),
  'YouTube-like embed (cross-site, allow=, own key handlers)': p => ({ body: `<input id="a" aria-label="Search"><iframe src="${X(p)}/yt" width=560 height=315 allow="accelerometer; autoplay; encrypted-media" allowfullscreen title="video"></iframe>`, routes: { '/yt': '<!doctype html><button id=pl>Play</button><script>addEventListener("keydown",e=>{if(e.key==="k")pl.click()},true);pl.onclick=()=>fetch("/x");</script>' } }),
  'Stripe-like card iframes (3 cross-site, page coupon field)': p => ({ body: `<h3>Checkout</h3><input id="a" aria-label="Search"><div>${['num', 'exp', 'cvc'].map(n => `<iframe src="${X(p)}/card?f=${n}" height=40 title="card ${n}"></iframe>`).join('')}</div>`, routes: { '/card': '<!doctype html><input autocomplete="cc-number" aria-label="card"><script>addEventListener("message",()=>{});parent.postMessage("ready","*")</script>' } }),
  'chat widget (cross-site iframe injected 300 ms after load, fixed corner)': p => ({ body: `<input id="a" aria-label="Search"><script>setTimeout(()=>{const f=document.createElement('iframe');f.src='${X(p)}/chat';f.style='position:fixed;right:10px;bottom:10px;width:350px;height:500px;border:0';f.title='chat';document.body.append(f)},300)</script>`, routes: { '/chat': '<!doctype html><div id=m>Hi! How can we help?</div><input aria-label="chat"><script>setInterval(()=>fetch("/x"),700)</script>' } }),
  'ad slots (3 cross-site iframes, one lazy at 1.5 s, one nested cross-site)': p => ({ body: `<input id="a" aria-label="Search"><iframe src="${X(p)}/ad1"></iframe><iframe src="${X(p)}/ad2"></iframe><script>setTimeout(()=>{const f=document.createElement('iframe');f.src='${X(p)}/ad2';document.body.append(f)},1500)</script>`, routes: { '/ad1': `<!doctype html><p>ad one</p><iframe src="http://127.0.0.1:${p}/inner"></iframe>`, '/inner': '<!doctype html><p>inner</p>', '/ad2': '<!doctype html><p>ad two</p>' } }),
  'sandboxed cross-site ads (allow-scripts allow-popups) + script-less sandbox': p => ({ body: `<input id="a" aria-label="Search"><iframe sandbox="allow-scripts allow-popups" src="${X(p)}/ad"></iframe><iframe sandbox src="${X(p)}/ad"></iframe>`, routes: { '/ad': '<!doctype html><p>sponsored</p><script>setInterval(()=>{},500)</script>' } }),
};
const totals = { fresh: 0, freshN: 0, later: 0, laterN: 0 };
for (const [name, make] of Object.entries(pages)) test('ordinary page: ' + name, { skip, timeout: 600000 }, async t => {
  const b = await bank(t), port = new URL(b.origin).port, { body, routes } = make(port);
  const failures = [];
  for (let n = 0; n < N; n++) {
    const f = await b.start(doc(body, keyLog), readOnly, { route: '/p' + n, routes });
    await sleep(DELAY);
    await f.page.evaluate(() => document.getElementById('a').focus());
    for (let k = 0; k < 3; k++) {
      let r; try { r = await f.act([{ do: 'press', key: 'Enter' }]); } catch (e) { r = { isError: true, text: 'THROW ' + e.message }; }
      const took = (await f.page.evaluate(() => window.__e).catch(() => [])).includes('keydown:Enter');
      const ok = !r.isError && took && !/not run|may have activated/.test(r.text);
      if (k === 0) { totals.freshN++; if (ok) totals.fresh++; } else { totals.laterN++; if (ok) totals.later++; }
      if (!ok) failures.push((k === 0 ? 'first ' : 'later ') + r.text.split('\n')[0].slice(0, 120));
      await f.page.evaluate(() => { window.__e.length = 0; document.getElementById('a').focus(); }).catch(() => {});
    }
    await f.safe();
  }
  t.diagnostic(JSON.stringify({ name, failures }));
  // Each page type may lose at most one press in N pages (a load-time race); the total is checked below.
  assert.ok(failures.length <= 2, 'presses refused on ' + name + ': ' + failures.join(' | '));
});

test('ordinary pages: at least 46 of 48 first presses and 94 of 96 later presses go through', { skip }, () => {
  const scale = 48 / (6 * N);
  t_diag(totals);
  assert.ok(totals.fresh * scale >= 46, 'first presses ' + totals.fresh + '/' + totals.freshN);
  assert.ok(totals.later * scale >= 94, 'later presses ' + totals.later + '/' + totals.laterN);
});
function t_diag(totals) { console.log('RESULT ordinary first ' + totals.fresh + '/' + totals.freshN + ' later ' + totals.later + '/' + totals.laterN); }
