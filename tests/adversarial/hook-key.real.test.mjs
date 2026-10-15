import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, plain, readOnly, skip } from './fixtures/bank.mjs';
import { popupHook } from '../../plugins/sleight/lib/direct-browser/page.mjs';
import { hookState } from './fixtures/hook.mjs';

// The page hook lives at a random window property with a secret only the controller and the hook closure know.
// A page can list that property but cannot replace, delete, redefine or switch it off, and cannot call it
// usefully. Every case drives a real headless Chromium whose own tab active bit is observed, so "background"
// means the browser's active tab did not change, and "the URL the model chose" means the fixture server saw
// no request for /danger. The repros are the pop round 2 review's p1 F1 to F3 and p5 G1, with the Symbol key
// replaced by whatever the page can find on its own window.
const opts = { skip, timeout: 120000 };
// What a hostile page does to find the hook: the one own property of window whose name looks like the key.
const FIND = `const K=Object.getOwnPropertyNames(window).find(n=>/^k[0-9a-f]{32}$/.test(n));`;
const LINK = `<a id="a" href="/landed" target="_blank">open docs</a>`;
const landed = b => ({ '/landed': '<!doctype html><title>landed</title><h1>Landed</h1>',
  '/danger': (req, res) => { b.effects.payment++; res.setHeader('content-type', 'text/html'); res.end('<title>danger</title><h1>danger</h1>'); } });

async function attack(t, { body = '', script = '', head = '', steps, label = 'Go', wait = 1500, probe, routes, text }) {
  const b = await bank(t, { observeTabs: true });
  const html = plain(`<button id="go" type="button">Go</button>` + body, script, head);
  const f = await b.start(html, text ?? readOnly, { routes: { ...landed(b), ...(routes ?? {}) } });
  const active = async () => (await b.tabState()).filter(x => x.active).map(x => x.id).sort().join(',');
  const before = await active();
  const result = await f.act(steps ? steps(f) : [{ do: 'click', ref: f.ref(label) }]);
  await new Promise(resolve => setTimeout(resolve, wait));
  const tabs = (await b.tabState()).map(x => x.url.replace(b.origin, '') + (x.active ? ' ACTIVE' : ''));
  const hits = f.hits().map(h => h.path);
  const extra = probe ? await probe(f, b) : undefined;
  t.diagnostic(JSON.stringify({ act: result.text.split('\n').slice(0, 4).join(' | '), activeChanged: before !== await active(), tabs, hits, extra }));
  return { f, b, result, tabs, hits, extra, activeChanged: before !== await active() };
}
const dangerHits = r => r.hits.filter(path => path.startsWith('/danger'));
const background = r => { assert.equal(r.activeChanged, false, 'the browser activated a tab: ' + r.tabs.join(', ')); assert.deepEqual(dangerHits(r), []); };
const click = label => f => [{ do: 'click', ref: f.ref(label) }];

test('control: an honest target=_blank link opens in the background and the result says so', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs') });
  background(r);
  assert.ok(r.hits.includes('/landed'), 'the link opened');
  assert.match(r.result.text, /background/);
  await r.f.safe({ settle: 100, tabs: false, allow: {} });
});

test('the key is no Symbol, the property is frozen and hidden, and the methods refuse a call without a proof', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs'),
    probe: f => f.page.evaluate(() => {
      const names = Object.getOwnPropertyNames(window).filter(n => /^k[0-9a-f]{32}$/.test(n));
      const K = names[0], descriptor = Object.getOwnPropertyDescriptor(window, K), api = window[K];
      const refusals = Object.keys(api).map(name => { try { api[name](); return name + ' ran'; } catch (error) { return error.message; } });
      const forged = Object.keys(api).map(name => { try { api[name]('x.' + '0'.repeat(64)); return name + ' ran'; } catch (error) { return error.message; } });
      let assigned = 'no throw', redefined = 'no throw', deleted;
      try { 'use strict'; window[K] = {}; } catch (error) { assigned = error.constructor.name; }
      try { Object.defineProperty(window, K, { value: {} }); } catch (error) { redefined = error.constructor.name; }
      try { deleted = delete window[K]; } catch (error) { deleted = error.constructor.name; }
      return { names: names.length, symbols: Object.getOwnPropertySymbols(window).map(String), bySymbol: typeof window[Symbol.for('sleight.popup3')],
        enumerable: Object.keys(window).includes(K), descriptor: { configurable: descriptor.configurable, writable: descriptor.writable, enumerable: descriptor.enumerable },
        frozen: Object.isFrozen(api), methods: Object.keys(api).sort(), refusals, forged, same: window[K] === api, deleted, redefined };
    }) });
  const found = r.extra;
  assert.equal(found.names, 1);
  assert.deepEqual(found.symbols, []);
  assert.equal(found.bySymbol, 'undefined');
  assert.equal(found.enumerable, false);
  assert.deepEqual(found.descriptor, { configurable: false, writable: false, enumerable: false });
  assert.equal(found.frozen, true);
  assert.deepEqual(found.methods, ['cancel', 'finish', 'guard', 'off', 'prepare', 'reveal', 'settle', 'take', 'takeRequest', 'verdict']);
  assert.ok(found.refusals.every(message => /refused the call/.test(message)), JSON.stringify(found.refusals));
  assert.ok(found.forged.every(message => /refused the call/.test(message)), JSON.stringify(found.forged));
  assert.equal(found.same, true);
  assert.equal(found.deleted, false);
  assert.equal(found.redefined, 'TypeError');
});

// F1 (pop r2 p1): replace the hook at load so prepare says "no modifier" and the click is a plain one.
const fakeHook = `{prepare(){return false},finish(){return true},takeRequest(){},take(){return 0},cancel(){},off(){return true},reveal(){},settle(){},guard(){return true},verdict(){}}`;
for (const [name, attempt] of Object.entries({
  'assignment': `window[K]=${fakeHook};`,
  'defineProperty': `try{Object.defineProperty(window,K,{value:${fakeHook},configurable:true,writable:true})}catch(e){}`,
  'delete then assignment': `try{delete window[K]}catch(e){}window[K]=${fakeHook};`,
  'Reflect.defineProperty': `Reflect.defineProperty(window,K,{value:${fakeHook}});`,
  'Object.assign': `try{Object.assign(window,{[K]:${fakeHook}})}catch(e){}`,
  'off() and every other method with guessed arguments': `for(const n of Object.keys(window[K])){for(const a of [[],[true],['x'],[{}],['x.y']])try{window[K][n](...a)}catch(e){}}`,
})) test('F1 a page that replaces the hook at load by ' + name + ' cannot make a link click a foreground tab', opts, async t => {
  const r = await attack(t, { body: LINK, script: FIND + attempt, steps: click('open docs') });
  background(r);
  assert.ok(r.hits.includes('/landed'), 'the link still opened, in the background');
  assert.match(r.result.text, /background/);
});

test('F2 a page that cancels the link and swaps in a takeRequest during the click opens nothing', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs'),
    script: FIND + `a.addEventListener('click',e=>{e.preventDefault();try{window[K]={takeRequest(){return {url:location.origin+'/danger',target:'_blank',rel:''}},finish(){return true},take(){return 0}}}catch(_){}
      try{Object.defineProperty(window,K,{value:{takeRequest(){return {url:location.origin+'/danger',target:'_blank',rel:''}}}})}catch(_){}});` });
  background(r);
  assert.equal(r.hits.includes('/landed'), false, 'the page cancelled the link, so nothing opens');
});

test('F3 a page that forges prepare and takeRequest cannot make a plain button open a page-chosen URL', opts, async t => {
  const r = await attack(t, { body: `<button id="b" type="button">Save</button>`, steps: click('Save'),
    script: FIND + `window[K]={prepare(){return {kind:'link'}},finish(){return true},takeRequest(){return {url:location.origin+'/danger',target:'_blank',rel:''}},take(){return 0},cancel(){},off(){return true}};` });
  background(r);
  assert.equal(r.tabs.length, 2, 'only the foreign tab and the page: ' + r.tabs.join(', '));
});

test('G1 a page that calls off() at load does not switch the hook off: a window.open in an input handler is still held', opts, async t => {
  const r = await attack(t, { body: `<input id="i" aria-label="Name">`, steps: f => [{ do: 'type', ref: f.ref('Name'), text: 'abc' }],
    script: FIND + `try{window[K].off()}catch(e){window.__off=e.message}for(const a of [[],[true],['x'],['x.y']])try{window[K].off(...a)}catch(e){}i.addEventListener('input',()=>window.open('/danger'))`,
    probe: f => f.page.evaluate(() => window.__off) });
  background(r);
  assert.equal(r.tabs.length, 2, 'no tab opened: ' + r.tabs.join(', '));
  assert.match(r.extra, /refused the call/);
});

test('G2 a page that calls off() at load cannot turn the next target=_blank click into a foreground tab', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs'), script: FIND + `try{window[K].off()}catch(e){}` });
  background(r);
  assert.ok(r.hits.includes('/landed'));
  assert.match(r.result.text, /background/);
});

test('a page that replaces Symbol.for, Object.defineProperty and the other statics the hook once used finds the hook intact', opts, async t => {
  const script = `Symbol.for=()=>Symbol('x');Object.defineProperty=()=>{throw Error('no')};Object.getOwnPropertyDescriptor=()=>undefined;Object.freeze=x=>x;
    JSON.stringify=()=>'{}';Number.isFinite=()=>false;Function.prototype.bind=()=>()=>{};Reflect.defineProperty=()=>false;String=function(){return ''};Error=function(){return 1};
    window.Set=function(){};window.WeakMap=function(){};window.URL=function(){};window.Promise=function(){};window.Math={imul(){return 0}};`;
  const r = await attack(t, { body: LINK + `<input id="i" aria-label="Name">`, script, steps: click('open docs') });
  background(r);
  assert.ok(r.hits.includes('/landed'));
  assert.match(r.result.text, /background/);
});

// A page that overrides what the hook captured cannot hold a script-started opening open: the timer open is held.
test('a page that replaces Symbol.for and Object.defineProperty still has its timer window.open held', opts, async t => {
  const r = await attack(t, { script: `Symbol.for=()=>Symbol('x');Object.defineProperty=()=>{};Object.getOwnPropertyDescriptor=()=>undefined;go.onclick=()=>setTimeout(()=>window.open('/danger'),300)` });
  background(r);
  assert.equal(r.tabs.length, 2);
});

// The sweep: replace, delete, redefine or call off() on every own property of window, at load and again in the click.
// Playwright's own page-side code reads globals too, so a page that sweeps all of them breaks the controller's calls
// before they reach the hook; that must end in no tab and an honest result, never a foreground tab or a page-chosen URL.
const sweep = (mode, only) => `(()=>{const names=${only ? JSON.stringify(only) : 'Object.getOwnPropertyNames(window)'},defineProperty=Object.defineProperty,reflectGet=Reflect.get,junk=function(){return null};
  for(const n of names){ if(n==='window'||n==='document'||n==='location'||n==='top'||n==='Object'||n==='Reflect')continue; let v;try{v=reflectGet(window,n)}catch(e){}
    try{if(v&&typeof v.off==='function')v.off()}catch(e){}
    try{if(${JSON.stringify(mode)}==='replace')window[n]=junk;else if(${JSON.stringify(mode)}==='delete')delete window[n];
      else defineProperty(window,n,{get(){return junk},set(){},configurable:true})}catch(e){} } })();`;
const honest = r => assert.ok(r.hits.includes('/landed') || /not run|unconfirmed|unavailable|changed|refused/.test(r.result.text), 'neither opened nor reported: ' + r.result.text.split('\n')[0]);
// The globals popupHook captures, minus Object, Array, Map and the typed arrays, which Playwright's own page-side code needs to deliver a call at all.
const captured = ['Function', 'Symbol', 'Math', 'Number', 'String', 'Error', 'Set', 'WeakMap', 'Promise', 'URL', 'JSON', 'Date', 'RegExp', 'Element', 'HTMLElement',
  'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLLabelElement', 'HTMLTextAreaElement', 'HTMLFormElement', 'Event', 'EventTarget', 'MouseEvent',
  'KeyboardEvent', 'Node', 'Document', 'DocumentFragment', 'ShadowRoot', 'NodeList', 'Window', 'setTimeout', 'clearTimeout', 'navigator', 'crypto'];
for (const mode of ['replace', 'delete', 'redefine']) {
  test('sweep (' + mode + ') of every own property of window at load and again in the click ends in the background or in no tab', opts, async t => {
    const r = await attack(t, { body: LINK, steps: click('open docs'), script: sweep(mode) + `a.addEventListener('click',()=>{${sweep(mode)}},true);` });
    background(r); honest(r);
  });
  test('sweep (' + mode + ') in the click handler, after the hook was armed, ends in the background or in no tab', opts, async t => {
    const r = await attack(t, { body: LINK, steps: click('open docs'), script: `a.addEventListener('click',()=>{${sweep(mode)}},true);` });
    background(r); honest(r);
  });
  test('sweep (' + mode + ') of every global the hook captured, at load and in the click, leaves the link opening in the background', opts, async t => {
    const r = await attack(t, { body: LINK, steps: click('open docs'),
      script: sweep(mode, captured) + `a.addEventListener('click',()=>{${sweep(mode, captured)}},true);` });
    background(r); honest(r);
    assert.ok(r.hits.includes('/landed') && /opened background tab/.test(r.result.text), 'the hook itself held: ' + r.result.text.split('\n')[0]);
  });
  test('sweep (' + mode + ') of every global the hook captured leaves a timer window.open held and a script click on a target=_blank link held', opts, async t => {
    const r = await attack(t, { body: LINK, script: sweep(mode, captured) + `go.onclick=()=>{setTimeout(()=>window.open('/danger'),200);setTimeout(()=>document.getElementById('a').click(),300)};` });
    background(r);
    assert.equal(r.tabs.length, 2, 'no tab opened: ' + r.tabs.join(', '));
  });
  test('sweep (' + mode + ') at load leaves a script-started window.open held', opts, async t => {
    const r = await attack(t, { script: sweep(mode) + `go.onclick=()=>setTimeout(()=>window.open('/danger'),200);` });
    background(r);
    assert.equal(r.tabs.length, 2);
  });
}

// Playwright hands its evaluate arguments through code the page can replace. A page that reads them gets one proof
// per method, usable once: it can burn that call, which fails closed, and nothing else.
test('a page that reads the controller\'s proofs off the evaluate arguments can burn one call but cannot switch the hook off or reach another method', opts, async t => {
  const script = FIND + `window.__proofs=[];window.__tried=[];
    const slice=Array.prototype.slice;
    Array.prototype.slice=function(...a){try{const text=JSON.stringify(this);for(const m of text.matchAll(/[0-9a-f]{24}\\.[0-9a-f]{64}/g)){window.__proofs.push(m[0]);
      for(const name of ['off','take','finish','prepare','takeRequest','guard','settle','reveal','verdict','cancel']){try{window[K][name](m[0]);window.__tried.push(name+' ran')}catch(e){window.__tried.push(name+' '+e.message)}}}}catch(e){}
      return slice.apply(this,a)};window.__restore=()=>{Array.prototype.slice=slice};`;
  const r = await attack(t, { body: LINK, script, steps: click('open docs'), wait: 800,
    probe: async f => ({ proofs: await f.page.evaluate(() => window.__proofs.length), tried: await f.page.evaluate(() => window.__tried.slice(0, 400)) }) });
  assert.equal(r.activeChanged, false);
  assert.deepEqual(dangerHits(r), []);
  // Whatever the page took, the hook still answers its owner and nothing but the stolen proof's own method ran.
  const ran = r.extra.tried.filter(line => / ran$/.test(line));
  assert.ok(ran.length <= r.extra.proofs, 'a stolen proof ran ' + ran.length + ' calls for ' + r.extra.proofs + ' proofs: ' + ran.join(', '));
  const offRan = ran.filter(line => line === 'off ran');
  assert.deepEqual(offRan, [], 'off ran with a proof made for another method');
  await r.f.page.evaluate('window.__restore()');
  assert.equal(await hookState(r.f.page, r.f.entry.hook), 'live');
});

test('a second install over the same key fails closed and leaves the first hook alone', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs') });
  background(r);
  const hook = r.f.entry.hook, patched = await r.f.page.evaluate(() => String(window.open));
  assert.equal(await r.f.page.evaluate(`(${popupHook})(${JSON.stringify(hook)})`), false);
  assert.equal(await r.f.page.evaluate(`(${popupHook})(${JSON.stringify({ key: hook.key, secret: 'another secret value here' })})`), false);
  assert.equal(await r.f.page.evaluate(() => String(window.open)), patched, 'a refused install changed nothing');
  assert.equal(await hookState(r.f.page, hook), 'live');
});

// Playwright evaluates the controller's functions with window.eval, which a page can replace, so a page can forge
// whatever the hook "returned". The hook signs its answers, so a forged one is refused instead of believed.
const forgeEval = (match, answer) => `const nativeEval=window.eval;window.eval=function(source){if(${match}.test(String(source)))return ()=>(${answer});return nativeEval.call(window,source)};`;
test('a page that forges the prepare answer as "no modifier" cannot get a plain click on a target=_blank link', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs'), script: forgeEval('/prepare\\(/', 'false') });
  background(r);
  assert.equal(r.hits.includes('/landed'), false, 'nothing opened: ' + r.result.text.split('\n')[0]);
  assert.match(r.result.text, /not run|unconfirmed|prepar/i);
});

test('a page that forges the takeRequest answer cannot steer where a cancelled link opens', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs'),
    script: forgeEval('/takeRequest\\(/', `{url:location.origin+'/danger',target:'_blank',rel:''}`) });
  background(r);
  assert.match(r.result.text, /unconfirmed|refused|changed|not run/i);
});

test('a page that forges the guard answer as armed does not make a click that was never guarded look guarded', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs'), script: forgeEval('/\\.guard\\(/', 'true') });
  background(r);
  assert.equal(r.hits.includes('/landed'), false);
  assert.match(r.result.text, /not run|unconfirmed|changed|guard/i);
});

test('a page that forges the finish answer cannot hide that the hook refused the call', opts, async t => {
  const r = await attack(t, { body: LINK, steps: click('open docs'), script: forgeEval('/\\.finish\\(/', 'true') });
  background(r);
  assert.match(r.result.text, /page changed during the click|unconfirmed|not run/i);
});
