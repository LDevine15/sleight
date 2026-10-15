import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, plain, readOnly, skip } from './fixtures/bank.mjs';
import { callHook, callHookIn, hookArgs, hookOf, openDeep } from './fixtures/hook.mjs';
import { backgroundClick, frameShield } from '../../plugins/sleight/lib/direct-browser/page.mjs';

// The input shield in the page hook (guard, verdict, finish) driven directly with trusted input from the
// harness's own Playwright. Part one is the key-shield API a keyboard path arms before it sends a key.
// Part two is a hostile page: the check must read only natives captured before page scripts, and when it
// cannot decide it must cancel the input. delivered() counts what reached the page, from the independent server.
const arm = async (f, selector, { keys = false, ms = 3000, token = 't1' } = {}) => openDeep(f, await f.page.evaluate(({ selector, keys, ms, token, key, proofs }) =>
  window[key].guard(proofs.guard, document.querySelector(selector), token, ms, { keys }), { selector, keys, ms, token, ...hookArgs(f, 'guard') }));
const verdict = async (f, token = 't1') => openDeep(f, await f.page.evaluate(({ token, key, proofs }) => window[key].verdict(proofs.verdict, token), { token, ...hookArgs(f, 'verdict') }));
const finish = async (f, token = 't1') => openDeep(f, await f.page.evaluate(({ token, key, proofs }) => window[key].finish(proofs.finish, token), { token, ...hookArgs(f, 'finish') }));
// Hostile pages replace the array helpers Playwright serializes arguments with, so these send an expression, not an argument.
const run = (f, code) => callHook(f, code);
const armHere = (f, selector, options = '') => run(f, `api.guard(document.querySelector(${JSON.stringify(selector)}), 't1', 3000${options})`);
const verdictHere = f => run(f, `api.verdict('t1')`);
const settle = () => new Promise(resolve => setTimeout(resolve, 250));
const submitted = f => f.delta().submit;
const delivered = f => f.delta().upload;

const form = (extra = '') => `<form id="f" action="/ok" method="post"><input id="t" name="q"><button id="b" type="submit">Go</button>${extra}</form>`;
const record = `f.addEventListener('submit',e=>{e.preventDefault();record('submit')});`;
const swapAction = `t.addEventListener('keydown',()=>{f.action='/charge'});`;

async function press(f) { await f.page.focus('#t'); await f.page.keyboard.press('Enter'); await settle(); }

test('key shield: with { keys: true } an action swapped on keydown cancels the Enter before it submits', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(form(), swapAction + record), readOnly);
  assert.equal(await arm(f, '#t', { keys: true }), true);
  await press(f);
  assert.equal(await verdict(f), 'the checked element changed');
  assert.equal(submitted(f), 0);
  assert.equal(await finish(f), 'the checked element changed');
  assert.equal(b.hits.filter(hit => hit.path === '/charge').length, 0);
});

test('key shield: a default { keys } of false leaves key events alone, { keys: true } vetoes the same swap', { skip, timeout: 60000 }, async t => {
  const page = plain('<input id="t" aria-label="Name">', `t.addEventListener('keydown',()=>t.setAttribute('aria-label','Pay $99 now'));`);
  const b = await bank(t), f = await b.start(page, readOnly);
  assert.equal(await arm(f, '#t'), true);
  await f.page.focus('#t'); await f.page.keyboard.press('a');
  assert.equal(await verdict(f), undefined);
  await finish(f);
  await f.page.evaluate(() => document.getElementById('t').setAttribute('aria-label', 'Name'));
  assert.equal(await arm(f, '#t', { keys: true, token: 't2' }), true);
  await f.page.keyboard.press('b');
  assert.equal(await verdict(f, 't2'), 'the checked element changed');
});

test('key shield: pointer-only mode still cancels the click an Enter makes on the form\'s submit button', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(form(), record), readOnly);
  assert.equal(await arm(f, '#t'), true);
  await press(f);
  assert.equal(await verdict(f), 'the input landed on a different element');
  assert.equal(submitted(f), 0);
});

test('key shield: an unchanged form submits with { keys: true } and the verdict stays empty', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(form(), record), readOnly);
  assert.equal(await arm(f, '#t', { keys: true }), true);
  await press(f);
  assert.equal(await verdict(f), undefined);
  assert.equal(submitted(f), 1);
  assert.equal(await finish(f), true);
});

test('key shield: a new default submitter inserted on keydown cancels the Enter', { skip, timeout: 60000 }, async t => {
  const script = `t.addEventListener('keydown',()=>{const x=document.createElement('button');x.setAttribute('formaction','/charge');x.textContent='Go';f.prepend(x)});` + record;
  const b = await bank(t), f = await b.start(plain(form(), script), readOnly);
  assert.equal(await arm(f, '#t', { keys: true }), true);
  await press(f);
  assert.match(await verdict(f), /changed/);
  assert.equal(submitted(f), 0);
});

test('key shield: the form owner of the field moved on keydown cancels the Enter', { skip, timeout: 60000 }, async t => {
  const html = form() + `<form id="g" action="/charge" method="post"></form>`;
  const b = await bank(t), f = await b.start(plain(html, `t.addEventListener('keydown',()=>{t.setAttribute('form','g')});` + record + `g.addEventListener('submit',e=>{e.preventDefault();record('submit')});`), readOnly);
  assert.equal(await arm(f, '#t', { keys: true }), true);
  await press(f);
  assert.match(await verdict(f), /changed/);
  assert.equal(submitted(f), 0);
});

test('key shield: finish disarms, a wrong token neither reads nor ends it, and input past the cap is cancelled', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(form(), swapAction + record), readOnly);
  assert.equal(await arm(f, '#t', { keys: true, token: 'a' }), true);
  assert.equal(await verdict(f, 'other'), undefined);
  assert.equal(await finish(f, 'other'), true);
  assert.equal(await finish(f, 'a'), true, 'no input arrived, so nothing was vetoed');
  assert.equal(await verdict(f, 'a'), undefined, 'a finished shield reports nothing');
  assert.equal(await arm(f, '#t', { keys: true, token: 'a' }), false, 'a finished token cannot be re-armed');
  await press(f);
  assert.equal(submitted(f), 1, 'after finish the swap is not vetoed');
  const g = await b.start(plain(form(), swapAction + record), readOnly);
  assert.equal(await arm(g, '#t', { keys: true, ms: 30, token: 'b' }), true);
  await new Promise(resolve => setTimeout(resolve, 80));
  await press(g);
  // F4: an expired shield that nobody finished is a late click, not a free pass.
  assert.equal(await verdict(g, 'b'), 'the input arrived after the shield expired', 'past its cap the input is cancelled');
  assert.equal(submitted(g), 0);
  assert.equal(await finish(g, 'b'), 'the input arrived after the shield expired');
});

test('key shield: bad arguments arm nothing, and a new guard replaces the old one', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(form(), swapAction + record), readOnly);
  const outcomes = await callHook(f, `(() => {
    const field = document.getElementById('t'), detached = document.createElement('button');
    return [api.guard(detached, 'x1', 1000), api.guard(document.createTextNode('x'), 'x2', 1000), api.guard(window, 'x3', 1000), api.guard(null, 'x4', 1000),
      api.guard(field, 'x5', 0), api.guard(field, 'x6', NaN), api.guard(field, 'x7', 1000, { keys: true }), api.guard(field, 'x8', 1000), api.verdict('x7')];
  })()`);
  assert.deepEqual(outcomes, [false, false, false, false, false, false, true, true, undefined]);
});

// A page that replaces the language's own helpers and the element's own accessors.
const hostile = `<script>
const wrong = value => function() { return value; };
for (const [name, value] of Object.entries({ includes: true, indexOf: 0, some: true, every: false, find: undefined, findIndex: 0, map: [], filter: [], join: '', slice: [], concat: [], push: 0 }))
  Object.defineProperty(Array.prototype, name, { value: wrong(value), configurable: true, writable: true });
for (const name of ['slice', 'replace', 'split', 'trim', 'match']) Object.defineProperty(String.prototype, name, { value: wrong(''), configurable: true, writable: true });
Object.defineProperty(String.prototype, 'charCodeAt', { value: wrong(0), configurable: true, writable: true });
Math.imul = wrong(0); RegExp.prototype.test = wrong(true); RegExp.prototype.exec = wrong(null);
WeakMap.prototype.has = wrong(true); WeakMap.prototype.get = wrong(1); WeakMap.prototype.set = wrong(undefined);
for (const klass of [Element, HTMLButtonElement, HTMLInputElement, HTMLLabelElement, ShadowRoot, Node])
  Object.defineProperty(klass, Symbol.hasInstance, { value: wrong(false), configurable: true });
for (const name of ['getAttribute', 'hasAttribute', 'matches', 'querySelectorAll', 'getRootNode', 'closest'])
  Object.defineProperty(Element.prototype, name, { value: wrong(name === 'querySelectorAll' ? [] : null), configurable: true, writable: true });
Object.defineProperty(Node.prototype, 'textContent', { get: wrong('Next'), configurable: true });
Object.defineProperty(Node.prototype, 'isConnected', { get: wrong(true), configurable: true });
Object.defineProperty(Node.prototype, 'parentElement', { get: wrong(null), configurable: true });
Object.defineProperty(Element.prototype, 'localName', { get: wrong('button'), configurable: true });
Object.defineProperty(Event.prototype, 'type', { get: wrong('nothing'), configurable: true });
Object.defineProperty(Event.prototype, 'composedPath', { value: wrong([]), configurable: true, writable: true });
Object.defineProperty(EventTarget.prototype, 'addEventListener', { value: wrong(undefined), configurable: true, writable: true });
</script>`;
const button = `<button id="b" type="button" aria-label="Next" onclick="record('upload')">Next</button>`;
const clickIt = async f => { await f.page.click('#b', { timeout: 3000 }); await settle(); };

test('hostile prototypes: an unchanged button is still clicked, and the verdict stays empty', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(button, '', hostile), readOnly);
  assert.equal(await armHere(f, '#b'), true);
  await clickIt(f);
  assert.equal(await verdictHere(f), undefined);
  assert.equal(delivered(f), 1);
});

test('hostile prototypes: a swapped aria-label still cancels the click', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(button, '', hostile), readOnly);
  assert.equal(await armHere(f, '#b'), true);
  await run(f, `document.getElementById('b').setAttribute('aria-label', 'Pay $99 now')`);
  await clickIt(f);
  assert.equal(await verdictHere(f), 'the checked element changed');
  assert.equal(delivered(f), 0);
});

// Own properties on the element itself that claim it never changed.
const liar = `const x=document.getElementById('b');
for (const [name, value] of Object.entries({ getAttribute: () => 'Next', hasAttribute: () => false, matches: () => false, getRootNode: () => document, closest: () => null,
  querySelectorAll: () => [], localName: 'button', isConnected: true, parentElement: null, textContent: 'Next', form: null, type: 'button', control: null }))
  Object.defineProperty(x, name, { value, configurable: true, writable: true });`;

const swaps = {
  'aria-label': () => document.getElementById('b').setAttribute('aria-label', 'Pay $99 now'),
  'text': () => { document.getElementById('b').replaceChildren('Pay $99 now'); },
  'formaction': () => document.getElementById('b').setAttribute('formaction', '/charge'),
};
for (const [name, swap] of Object.entries(swaps))
  test('own-property liars on the element: a swapped ' + name + ' still cancels the click', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(plain(button, liar), readOnly);
    assert.equal(await arm(f, '#b'), true);
    await f.page.evaluate(swap);
    await clickIt(f);
    assert.equal(await verdict(f), 'the checked element changed');
    assert.equal(delivered(f), 0);
  });

test('a target that leaves the page, replaced by a lookalike at the same place, receives no click', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(button, ''), readOnly);
  assert.equal(await arm(f, '#b'), true);
  await f.page.evaluate(() => {
    const old = document.getElementById('b'), copy = old.cloneNode(true);
    old.replaceWith(copy);
  });
  await clickIt(f);
  assert.match(await verdict(f), /left the page|different element|changed/);
  assert.equal(delivered(f), 0);
});

test('a target removed before arming cannot be armed', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(button, ''), readOnly);
  const armed = await callHook(f, `(() => { const x = document.getElementById('b'); x.remove(); return api.guard(x, 'gone', 1000); })()`);
  assert.equal(armed, false);
});

test('an image map whose name holds selector syntax is matched as a string and its area is sealed', { skip, timeout: 60000 }, async t => {
  const svg = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="#ccc"/></svg>');
  const body = `<img id="i" usemap="#a&quot;]x\\" src="${svg}" width="60" height="40"><map name="a&quot;]x\\"><area id="ar" shape="default" href="/charge" alt="Open"></map>`;
  const b = await bank(t), f = await b.start(plain(body, ''), readOnly);
  assert.equal(await arm(f, '#i'), true, 'the guard arms without building a selector from the name');
  await f.page.evaluate(() => document.getElementById('ar').setAttribute('href', '/charge?swapped=1'));
  await f.page.click('#i', { timeout: 3000 }).catch(() => {});
  await settle();
  assert.equal(await verdict(f), 'the checked element changed');
  assert.equal(b.hits.filter(hit => hit.path.startsWith('/charge')).length, 0);
});

// ---- Round 3 -----------------------------------------------------------------------------------------------

// F4: the cap is soft. A click that arrives after it is cancelled, whatever the page did in between.
test('a pointer click that arrives after the cap is cancelled, even when nothing changed', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(button, ''), readOnly);
  assert.equal(await arm(f, '#b', { ms: 30 }), true);
  await new Promise(resolve => setTimeout(resolve, 120));
  await clickIt(f);
  assert.equal(await verdict(f), 'the input arrived after the shield expired');
  assert.equal(delivered(f), 0);
  assert.equal(await finish(f), 'the input arrived after the shield expired');
});

// F4: a shield nobody finishes is dropped by the hard cap, not left cancelling input for the rest of the page's life.
test('a shield that is never finished is dropped by the hard cap, so later input is not cancelled', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(button, ''), readOnly);
  assert.equal(await arm(f, '#b', { ms: 30 }), true);
  await f.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 5300)));
  await clickIt(f);
  assert.equal(await verdict(f), undefined, 'the shield was dropped');
  assert.equal(delivered(f), 1);
});

// F3: expect() ties what the rules read to what was sealed.
test('expect: digests equal to the sealed ones pass, any other digest cancels the click that follows', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(button, ''), readOnly);
  const sealedParts = async () => callHook(f, `(() => {
    api.guard(document.getElementById('b'), 'e1', 3000);
    return api.expect('e1', { element: 'nothing', forwarded: '', areas: [] });
  })()`);
  assert.equal(await sealedParts(), 'the checked element changed');
  await clickIt(f);
  assert.equal(delivered(f), 0, 'a click after a failed expect is cancelled');
  assert.equal(await finish(f, 'e1'), 'the checked element changed');
});

test('expect: a wrong token, a foreign shield and missing evidence all fail closed', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(button, ''), readOnly);
  const out = await callHook(f, `(() => {
    const el = document.getElementById('b');
    api.guard(el, 'e2', 3000);
    return [api.expect('other', { element: 'x', forwarded: '', areas: [] }), api.expect('e2'), api.expect('e2', {}), api.expect('e2', { element: 1, forwarded: '', areas: [] })];
  })()`);
  assert.deepEqual(out, ['the checked element changed', 'the checked element changed', 'the checked element changed', 'the checked element changed']);
});

// F5: a relative action resolves through <base>, so the seal covers the document's base URL, URL and base target.
const baseForm = `<form id="f" action="ok" method="post"><input id="t" name="q" aria-label="Query"><button id="b" type="submit" aria-label="Next">Next</button></form>`;
const baseRoutes = b => ({ '/charge/ok': (req, res) => { b.effects.payment++; res.end('charged'); }, '/ok': (req, res) => res.end('fine') });
const baseSwaps = {
  'a base href inserted': `const x=document.createElement('base');x.href='/charge/';document.head.append(x);`,
  'a base target inserted': `const x=document.createElement('base');x.target='_blank';document.head.append(x);`,
  'history.pushState': `history.pushState({}, '', '/charge/');`,
};
for (const [name, swap] of Object.entries(baseSwaps)) {
  test('pointer: ' + name + ' on mousedown cancels the submit', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(plain(baseForm, `b.addEventListener('mousedown',()=>{${swap}});`), readOnly, { routes: baseRoutes(b) });
    assert.equal(await arm(f, '#b'), true);
    await clickIt(f);
    assert.equal(await verdict(f), 'the checked element changed');
    assert.equal(b.hits.filter(hit => hit.path.startsWith('/charge')).length, 0);
  });
  test('keys: ' + name + ' on keydown cancels the Enter', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(plain(baseForm, `t.addEventListener('keydown',()=>{${swap}});` + record), readOnly, { routes: baseRoutes(b) });
    assert.equal(await arm(f, '#t', { keys: true }), true);
    await press(f);
    assert.equal(await verdict(f), 'the checked element changed');
    assert.equal(b.hits.filter(hit => hit.path.startsWith('/charge')).length, 0);
  });
}

// F6: the default submitter is sealed by its own attributes, the submit event names the sealed submitter,
// and a key must reach the field itself.
const keyForm = (extra = '') => `<form id="f" action="/ok" method="post"><input id="t" name="q"><button id="b" type="submit">Go</button><button id="alt" type="submit" formaction="/charge">Alt</button>${extra}</form>`;
const keyAttacks = {
  'formaction set on the default submitter in keydown': { script: `t.addEventListener('keydown',()=>b.setAttribute('formaction','/charge'));` },
  'formaction set on the default submitter in keypress': { script: `t.addEventListener('keypress',()=>b.setAttribute('formaction','/charge'));` },
  'formtarget set on the default submitter': { script: `t.addEventListener('keydown',()=>b.setAttribute('formtarget','_blank'));` },
  'formmethod set on the default submitter': { script: `t.addEventListener('keydown',()=>b.setAttribute('formmethod','get'));` },
  'requestSubmit with another submitter from keydown': { script: `t.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();f.requestSubmit(alt)}});` },
  'requestSubmit with another submitter from keypress': { script: `t.addEventListener('keypress',e=>{if(e.key==='Enter'){e.preventDefault();f.requestSubmit(alt)}});` },
  'form.action changed from keypress': { script: `t.addEventListener('keypress',()=>{f.action='/charge'});` },
};
for (const [name, { script }] of Object.entries(keyAttacks))
  test('key shield: ' + name + ' is vetoed and nothing reaches /charge', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(plain(keyForm(), script + record), readOnly);
    assert.equal(await arm(f, '#t', { keys: true }), true);
    await press(f);
    assert.ok(await verdict(f), 'a veto names a reason');
    assert.equal(b.hits.filter(hit => hit.path.startsWith('/charge')).length, 0);
    assert.equal(submitted(f), 0);
  });

for (const [name, focus] of Object.entries({ 'another button in the same form': 'pay', 'a button outside the form': 'out' }))
  test('key shield: focus moved to ' + name + ' before Enter does not run that button', { skip, timeout: 60000 }, async t => {
    const html = keyForm(`<button id="pay" type="button" onclick="record('payment')">Hidden pay</button>`) + `<button id="out" type="button" onclick="record('payment')">Outside pay</button>`;
    const b = await bank(t), f = await b.start(plain(html, record), readOnly);
    await f.page.focus('#t');
    assert.equal(await arm(f, '#t', { keys: true }), true);
    await f.page.evaluate(id => document.getElementById(id).focus(), focus);
    await f.page.keyboard.press('Enter'); await settle();
    assert.ok(await verdict(f), 'a veto names a reason');
    assert.equal(f.delta().payment, 0);
  });

test('key shield: a quiet form still submits with its sealed submitter, and the verdict stays empty', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(keyForm(), record), readOnly);
  assert.equal(await arm(f, '#t', { keys: true }), true);
  await press(f);
  assert.equal(await verdict(f), undefined);
  assert.equal(submitted(f), 1);
});

test('key shield: a form with no submit button still submits implicitly with its null submitter', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain('<form id="f" action="/ok" method="post"><input id="t" name="q"></form>', record), readOnly);
  assert.equal(await arm(f, '#t', { keys: true }), true);
  await press(f);
  assert.equal(await verdict(f), undefined);
  assert.equal(submitted(f), 1);
});

// F2: every frame but the owner's is armed from Node over page.frames() (frameShield) and released the same way.
const frameDoc = '<style>body{margin:0}button{width:100vw;height:100vh}</style><button type="button" onclick="record(\'payment\')">Pay now</button>';
const cover = `<style>.box{position:relative;width:160px;height:48px;margin:10px}.fill{position:absolute;inset:0;width:100%;height:100%;border:0}</style>`;
const shieldOf = (f, { token = 't1', keys = false } = {}) => frameShield(f.page, f.page.mainFrame(), { hook: hookOf(f), token, capMs: 3000, timeoutMs: 2000, keys });
const armedIn = async (f, frame) => (await callHookIn(f, frame, 'api.armed()'))?.token ?? null;
const elsewhere = 'the input landed on a different element';

test('a same-origin iframe shown after arming receives no click, and the release reports it', { skip, timeout: 60000 }, async t => {
  const html = `${cover}<div class="box"><button id="b" class="fill" type="button" aria-label="Close ad">Close ad</button><iframe id="fr" class="fill" src="/pay-frame" style="opacity:0;z-index:2;visibility:hidden"></iframe></div>`;
  const b = await bank(t), f = await b.start(plain(html, `b.addEventListener('pointermove',()=>{fr.style.visibility='visible'});`), readOnly, { routes: { '/pay-frame': plain(frameDoc) } });
  await new Promise(resolve => setTimeout(resolve, 400));
  const shield = shieldOf(f);
  assert.equal(await arm(f, '#b'), true);
  assert.equal(await shield.arm(), true);
  await f.page.evaluate(() => { document.getElementById('fr').style.visibility = 'visible'; });
  await f.page.mouse.click(40, 34); await settle();
  assert.equal(f.delta().payment, 0);
  assert.equal(await shield.release(), elsewhere);
  const report = await callHook(f, `api.conclude('t1')`);
  assert.equal(report.passed, false, 'the sealed document saw no press');
});

test('a same-origin iframe created while armed arms itself at document start, and release disarms it', { skip, timeout: 60000 }, async t => {
  const html = `${cover}<div class="box" id="c"><button id="b" class="fill" type="button" aria-label="Close ad">Close ad</button></div>`;
  const b = await bank(t), f = await b.start(plain(html, ''), readOnly, { routes: { '/pay-frame': plain(frameDoc) } });
  assert.equal(await arm(f, '#b'), true);
  await f.page.evaluate(() => new Promise(resolve => {
    const q = document.createElement('iframe'); q.className = 'fill'; q.src = '/pay-frame'; q.style.cssText = 'z-index:2;opacity:0';
    q.onload = resolve; document.getElementById('c').append(q);
  }));
  const child = f.page.frames().find(x => x !== f.page.mainFrame());
  assert.equal(await armedIn(f, child), 't1', 'no Node call has run: the frame read its parent');
  await f.page.mouse.click(40, 34); await settle();
  assert.equal(f.delta().payment, 0);
  assert.equal(await shieldOf(f).release(), elsewhere);
  assert.equal(await armedIn(f, child), null);
});

test('a child frame released by the shield takes input again', { skip, timeout: 60000 }, async t => {
  const html = `${cover}<div class="box"><button id="b" class="fill" type="button" aria-label="Close ad">Close ad</button></div><iframe id="fr" src="/pay-frame" style="width:200px;height:60px"></iframe>`;
  const b = await bank(t), f = await b.start(plain(html, ''), readOnly, { routes: { '/pay-frame': plain(frameDoc) } });
  await new Promise(resolve => setTimeout(resolve, 300));
  const shield = shieldOf(f);
  assert.equal(await arm(f, '#b'), true);
  assert.equal(await shield.arm(), true);
  const frame = f.page.frames().find(x => x !== f.page.mainFrame());
  assert.equal(await armedIn(f, frame), 't1');
  assert.equal(await shield.release(), undefined);
  assert.equal(await armedIn(f, frame), null);
  await frame.click('button', { timeout: 3000 }); await settle();
  assert.equal(f.delta().payment, 1, 'after release the frame takes input again');
});

// F2-C: an iframe inside a shadow root is not in window[i]; Playwright's frame list has it.
test('an iframe in a shadow root is armed before the click, and one created while armed is released (no leak)', { skip, timeout: 60000 }, async t => {
  const html = `<button id="t" aria-label="Top">Top</button><div id="h"></div>`;
  const frames = { '/f': plain(`<button id="fb" style="width:100%;height:100%" onclick="record('payment')">fb</button>`) };
  const b = await bank(t), f = await b.start(plain(html, `const sr=h.attachShadow({mode:'open'});sr.innerHTML='<iframe id="pre" src="/f" style="width:200px;height:40px;border:0"></iframe>';`), readOnly, { routes: frames });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await f.page.evaluate(() => window.length), 0, 'window[i] sees no shadow-root frame');
  const preloaded = f.page.frames().find(x => x !== f.page.mainFrame());
  assert.ok(preloaded, 'the frame list has the shadow-root frame');
  const shield = shieldOf(f);
  assert.equal(await arm(f, '#t'), true);
  assert.equal(await shield.arm(), true);
  assert.equal(await armedIn(f, preloaded), 't1', 'a preloaded shadow-root frame is armed');
  await f.page.evaluate(() => new Promise(resolve => {
    const q = document.createElement('iframe'); q.style.cssText = 'width:200px;height:40px;border:0'; q.src = '/f'; q.onload = resolve;
    document.getElementById('h').shadowRoot.append(q);
  }));
  const created = f.page.frames().find(x => x !== f.page.mainFrame() && x !== preloaded);
  assert.equal(await armedIn(f, created), 't1', 'a shadow-root frame created while armed starts armed');
  await created.click('button', { timeout: 1500 }).catch(() => {}); await settle();
  assert.equal(f.delta().payment, 0, 'both frames cancel the click');
  assert.equal(await shield.release(), elsewhere);
  assert.equal(await armedIn(f, preloaded), null);
  assert.equal(await armedIn(f, created), null, 'conclude-time release reaches the frame created while armed');
  await created.click('button', { timeout: 3000 }); await settle();
  assert.equal(f.delta().payment, 1, 'a later real click in it is delivered');
});

test('a frame whose hook already holds another shield cannot be armed, so the arm fails closed', { skip, timeout: 60000 }, async t => {
  const html = `<button id="t" aria-label="Top">Top</button><iframe id="fr" src="/f" style="width:200px;height:60px"></iframe>`;
  const b = await bank(t), f = await b.start(plain(html, ''), readOnly, { routes: { '/f': plain('<button id="fb">fb</button>') } });
  await new Promise(resolve => setTimeout(resolve, 300));
  const frame = f.page.frames().find(x => x !== f.page.mainFrame());
  assert.equal(await callHookIn(f, frame, `api.guard(document.getElementById('fb'), 'other', 3000)`), true);
  assert.equal(await shieldOf(f).arm(), false);
});

// F2-A: document.open() erases a window's listeners. The hook wraps it (and write) and re-adds them, in the
// realm of the document that was rewritten, and the Node confirm re-adds them before the click.
const payButton = `<button type="button" style="width:100vw;height:100vh;margin:0" onclick="parent.record('payment')">Pay</button>`;
const openModes = {
  'control (no rewrite)': '',
  'document.open()': 'd.open();',
  'document.open() + write + close()': `d.open();d.write(${JSON.stringify(payButton)});d.close();`,
  'the parent realm\'s Document.prototype.open on the child document': `Document.prototype.open.call(d);d.write(${JSON.stringify(payButton)});d.close();`,
  'document.write after close (implicit open)': `d.open();d.close();d.write(${JSON.stringify(payButton)});d.close();`,
  'document.writeln on a closed document': `d.writeln(${JSON.stringify(payButton)});d.close();`,
};
for (const [name, code] of Object.entries(openModes))
  test('document rewrite in an armed child frame still cancels the click: ' + name, { skip, timeout: 60000 }, async t => {
    const html = `<style>iframe{position:absolute;left:0;top:100px;width:200px;height:60px;border:0}</style><button id="x" aria-label="Close ad">Close ad</button><iframe id="fr" src="/p"></iframe>`;
    const b = await bank(t), f = await b.start(plain(html, ''), readOnly, { routes: { '/p': plain(payButton) } });
    await new Promise(resolve => setTimeout(resolve, 400));
    const shield = shieldOf(f);
    assert.equal(await arm(f, '#x'), true);
    assert.equal(await shield.arm(), true);
    await f.page.evaluate(`(() => { const d = document.getElementById('fr').contentDocument; ${code} })()`);
    await f.page.mouse.click(50, 130); await settle();
    assert.equal(f.delta().payment, 0);
    // A bare open() leaves an empty document: nothing there takes the press, so there is nothing to veto.
    assert.equal(await shield.release(), code === 'd.open();' ? undefined : elsewhere);
  });

test('the confirm before the click arms a frame that navigated after the first arm', { skip, timeout: 60000 }, async t => {
  const html = `<style>iframe{position:absolute;left:0;top:100px;width:200px;height:60px;border:0}</style><button id="x" aria-label="Close ad">Close ad</button><iframe id="fr" src="/p"></iframe>`;
  const b = await bank(t), f = await b.start(plain(html, ''), readOnly, { routes: { '/p': plain(frameDoc), '/q': plain(frameDoc) } });
  await new Promise(resolve => setTimeout(resolve, 400));
  const shield = shieldOf(f);
  assert.equal(await arm(f, '#x'), true);
  assert.equal(await shield.arm(), true);
  const frame = f.page.frames().find(x => x !== f.page.mainFrame());
  await frame.goto(b.origin + '/q');
  assert.equal(await shield.confirm(), true);
  assert.equal(await armedIn(f, frame), 't1');
  await f.page.mouse.click(50, 130); await settle();
  assert.equal(f.delta().payment, 0);
  assert.equal(await shield.release(), elsewhere);
});

// F2-B: the checked element is in a same-origin child frame; the top document and its siblings are armed too.
const inner = plain(`<style>body{margin:0}button{width:100vw;height:100vh}</style><button id="x" type="button" aria-label="Close ad" onclick="record('upload')">Close ad</button>`);
test('with the checked element in a child frame, the top document and a sibling frame are armed and the owner is not', { skip, timeout: 60000 }, async t => {
  const html = `<style>iframe{position:absolute;top:0;width:200px;height:60px;border:0}</style><iframe id="a" src="/inner" style="left:0"></iframe><iframe id="s" src="/inner" style="left:300px"></iframe><button id="ov" style="position:absolute;left:0;top:100px;width:200px;height:40px" onclick="record('payment')">Pay</button>`;
  const b = await bank(t), f = await b.start(plain(html, ''), readOnly, { routes: { '/inner': inner } });
  await new Promise(resolve => setTimeout(resolve, 400));
  const [, owner, sibling] = f.page.frames();
  const shield = frameShield(f.page, owner, { hook: hookOf(f), token: 't1', capMs: 3000, timeoutMs: 2000 });
  assert.equal(await callHookIn(f, owner, `api.guard(document.getElementById('x'), 't1', 3000)`), true);
  assert.equal(await shield.arm(), true);
  assert.equal(await armedIn(f, f.page.mainFrame()), 't1', 'the top document is armed');
  assert.equal(await armedIn(f, sibling), 't1', 'the sibling frame is armed');
  assert.equal((await callHookIn(f, owner, `api.armed()`)).keys, false);
  await f.page.mouse.click(50, 110); await settle();
  assert.equal(f.delta().payment, 0, 'the top button takes no click');
  await f.page.mouse.click(50, 30); await settle();
  assert.equal(f.delta().upload, 1, 'the owner frame still takes the click on the checked button');
  assert.equal(await shield.release(), elsewhere);
  assert.equal((await callHookIn(f, owner, `api.conclude('t1')`)).landed, true);
});

// F9: whether the page saw part of the click decides whether a retry is safe.
test('conclude reports passed: false when only a veto happened, true once a press was delivered', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain('<button id="b" aria-label="Add" onclick="record(\'upload\')">Add</button>', `b.addEventListener('mouseup',()=>{b.textContent='Added'});`), readOnly);
  assert.equal(await arm(f, '#b'), true);
  await f.page.mouse.click(30, 20); await settle();
  const report = await callHook(f, `api.conclude('t1')`);
  assert.equal(report.passed, true);
  assert.equal(report.bad, 'the checked element changed');
  await f.page.evaluate(() => { document.getElementById('b').textContent = 'Add'; });
  assert.equal(await arm(f, '#b', { token: 't2' }), true);
  await f.page.evaluate(() => { document.getElementById('b').setAttribute('aria-label', 'Pay'); });
  await f.page.mouse.click(30, 20); await settle();
  const quiet = await callHook(f, `api.conclude('t2')`);
  assert.equal(quiet.passed, false);
  assert.equal(quiet.bad, 'the checked element changed');
});

// Boolean attributes are sealed by presence: formnovalidate="" is not the same as no attribute.
test('a boolean attribute added with an empty value is a change (formnovalidate, novalidate, disabled)', { skip, timeout: 60000 }, async t => {
  for (const [name, target] of [['formnovalidate', 'b'], ['novalidate', 'f'], ['disabled', 'b']]) {
    const b = await bank(t), f = await b.start(plain(form(), ''), readOnly);
    assert.equal(await arm(f, '#t', { keys: true }), true);
    await f.page.evaluate(({ name, target }) => document.getElementById(target).setAttribute(name, ''), { name, target });
    await f.page.focus('#t'); await f.page.keyboard.press('Enter'); await settle();
    assert.ok(await verdict(f), name + ' set to the empty string must be seen');
  }
});

// The reviewer's key-mode repros (keysX): every swap on the Enter path is vetoed or lands on the sealed action.
const attackForm = (extra = '', attrs = '') => `<form id="f" action="/ok" method="post" ${attrs}><input id="t" name="q"><button id="b" type="submit">Go</button><button id="alt" type="submit" formaction="/charge">Alt</button>${extra}</form>`;
const reviewAttacks = {
  'field form= attribute switched to a second form (keydown)': { html: attackForm() + `<form id="g" action="/charge" method="post"><button type="submit">G</button></form>`, script: `t.addEventListener('keydown',()=>{t.setAttribute('form','g')});` },
  'default submitter formmethod set (keydown)': { html: attackForm(), script: `t.addEventListener('keydown',()=>b.setAttribute('formmethod','get'));` },
  'default submitter formenctype set (keypress)': { html: attackForm(), script: `t.addEventListener('keypress',()=>b.setAttribute('formenctype','text/plain'));` },
  'default submitter formnovalidate set (keydown)': { html: attackForm(), script: `t.addEventListener('keydown',()=>b.setAttribute('formnovalidate',''));` },
  'default submitter replaced by a clone with formaction (keydown)': { html: attackForm(), script: `t.addEventListener('keydown',()=>{const c=b.cloneNode(true);c.setAttribute('formaction','/charge');b.replaceWith(c)});` },
  'requestSubmit() with no submitter after formaction on b (keydown)': { html: attackForm(), script: `t.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();b.setAttribute('formaction','/charge');f.requestSubmit()}});` },
  'requestSubmit(b) after b.formaction (keydown)': { html: attackForm(), script: `t.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();b.setAttribute('formaction','/charge');f.requestSubmit(b)}});` },
  'document.baseURI via pushState in keydown (relative action)': { html: attackForm().replace('action="/ok"', 'action="ok"'), script: `t.addEventListener('keydown',()=>{history.pushState({},'','/charge/page')});` },
  'a later window capture keydown swaps the action': { html: attackForm(), script: `window.addEventListener('keydown',()=>{f.action='/charge'},true);` },
};
for (const [name, { html, script }] of Object.entries(reviewAttacks))
  test('key shield attack: ' + name, { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(plain(html, script + `f.addEventListener('submit',()=>{record('submit')});`), readOnly);
    assert.equal(await arm(f, '#t', { keys: true }), true);
    await press(f);
    const veto = await verdict(f);
    assert.ok(veto, 'no veto; hits ' + b.hits.map(h => h.method + ' ' + h.path).join(', '));
    assert.equal(b.hits.filter(h => h.path.startsWith('/charge')).length, 0);
  });

test('key shield attack: a keyup handler that changes the action after the submit has started is not a veto, and /charge is not reached', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(attackForm(), `t.addEventListener('keyup',()=>{f.action='/charge'});`), readOnly);
  assert.equal(await arm(f, '#t', { keys: true }), true);
  await press(f);
  assert.equal(await verdict(f), undefined);
  assert.equal(b.hits.filter(h => h.path.startsWith('/charge')).length, 0);
  assert.equal(b.hits.filter(h => h.path === '/ok').length, 1);
});

// A click that closes its own tab (a popup's Close button) reports the close, not a failed release: a closed
// page's frames are not marked detached, so the release must treat the closed page as gone (swap r4 review).
test('a click that closes its own tab reports the close and leaves the opener idle', { skip, timeout: 120000 }, async t => {
  const routes = { '/popup': plain(`<button id="c" type="button" aria-label="Close me" onclick="record('upload');window.close()">Close me</button><iframe src="/f" style="width:100px;height:30px"></iframe><iframe src="/f" style="width:100px;height:30px"></iframe>`), '/f': plain('<p>x</p>') };
  const f = await (await bank(t)).start(plain(`<button id="b" type="button" aria-label="Open" onclick="window.open('/popup')">Open</button><iframe src="/f" style="width:100px;height:30px"></iframe>`), readOnly, { routes });
  await new Promise(resolve => setTimeout(resolve, 400));
  await f.act([{ do: 'click', ref: f.ref('Open') }]);
  await new Promise(resolve => setTimeout(resolve, 800));
  const pop = /^(t\w+) \S+ \(opener/m.exec((await f.call('browser_tabs', { do: 'list' })).text)?.[1];
  assert.ok(pop, 'the popup tab is listed');
  const ref = /"Close me"[^\n]*\[ref=([^\]]+)\]/.exec((await f.call('browser_read', { tab: pop })).text)?.[1];
  const popPage = f.registry.tab(pop).page;
  const result = await f.call('browser_act', { tab: pop, steps: [{ do: 'click', ref }] });
  assert.match(result.text.split('\n')[0], /tab closed/);
  assert.equal(popPage.isClosed(), true);
  assert.equal(f.delta().upload, 1);
  for (const frame of f.page.frames())
    assert.equal(await callHookIn(f, frame, `api.armed()`), undefined, 'no frame of the opener is left armed');
});

// AD1 pop5, F-INT-1. A same-site frame that answers "absent" is trusted to have no hook only when it cannot run scripts: its iframe's
// sandbox attribute (or an ancestor's) lacks allow-scripts, read from the parent's side in the utility world. Any other frame that has no
// hook fails the arm closed, and the message sends the model to the engine browser path.
const pingPage = (extra = '') => `<button id="b" type="button" aria-label="Ping" onclick="record('payment')">Ping</button>${extra}`;
const sandboxRoutes = {
  '/f': plain('<p>frame</p>'),
  '/nest': plain('<p>nest</p><iframe sandbox title="inner"></iframe>'),
  '/csp': (req, res) => { res.setHeader('content-type', 'text/html'); res.setHeader('content-security-policy', 'sandbox'); res.end('<!doctype html><title>csp</title><p>sandboxed by header</p>'); },
};
const addFrames = (f, html) => f.page.evaluate(markup => { const box = document.createElement('div'); box.innerHTML = markup; document.body.append(box); return new Promise(resolve => setTimeout(resolve, 400)); }, html);
for (const [name, html] of Object.entries({
  '<iframe sandbox> (blank)': '<iframe sandbox title="s"></iframe>',
  'sandbox="allow-same-origin" with a same-site src': '<iframe sandbox="allow-same-origin" src="/f" title="s"></iframe>',
  'sandbox="allow-forms allow-popups" with a same-site src': '<iframe sandbox="allow-forms allow-popups" src="/f" title="s"></iframe>',
  'a sandboxed srcdoc frame': '<iframe sandbox srcdoc="<p>x</p>" title="s"></iframe>',
  'a sandboxed frame with a same-site src and no tokens': '<iframe sandbox src="/f" title="s"></iframe>',
  'a frame that runs scripts and holds a script-less sandboxed frame': '<iframe sandbox="allow-scripts allow-same-origin" src="/nest" title="s"></iframe>',
  'two script-less frames and an ordinary one': '<iframe sandbox title="a"></iframe><iframe sandbox="allow-same-origin" src="/f" title="b"></iframe><iframe src="/f" title="c"></iframe>',
})) test('a same-site frame that cannot run scripts does not block arming: ' + name + ' (F-INT-1)', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(pingPage(), ''), readOnly, { routes: sandboxRoutes });
  await addFrames(f, html);
  const shield = shieldOf(f);
  assert.equal(await shield.arm(), true);
  assert.equal(shield.unarmable, false);
  assert.equal(await shield.release(), undefined);
});
test('a sandbox attribute with allow-scripts is still a frame that must hold a hook, and it is armed (F-INT-1)', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(pingPage(), ''), readOnly, { routes: sandboxRoutes });
  await addFrames(f, '<iframe sandbox="allow-scripts allow-same-origin" src="/f" title="s"></iframe>');
  const shield = shieldOf(f);
  assert.equal(await shield.arm(), true);
  const frame = f.page.frames().find(x => x !== f.page.mainFrame());
  assert.equal(await armedIn(f, frame), 't1', 'the frame answered with a hook and holds the shield');
  assert.equal(await shield.release(), undefined);
  assert.equal(await armedIn(f, frame), null);
});
test('a same-site frame sandboxed by a header, which no attribute shows, still fails the arm closed (F-INT-1)', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(pingPage(), ''), readOnly, { routes: sandboxRoutes });
  await addFrames(f, '<iframe src="/csp" title="s"></iframe>');
  const shield = shieldOf(f);
  assert.equal(await shield.arm(), false);
  assert.equal(shield.unarmable, true);
  await shield.release();
});
for (const [name, html] of Object.entries({
  'S2 sandbox="allow-same-origin" with a same-site src': '<iframe sandbox="allow-same-origin" src="/f" title="s"></iframe>',
  'S6 <iframe sandbox> (blank)': '<iframe sandbox title="s"></iframe>',
})) test('a click on a page with a script-less sandboxed same-site frame works: ' + name + ' (F-INT-1)', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(pingPage(html), ''), readOnly, { routes: sandboxRoutes });
  const result = await f.act([{ do: 'click', ref: f.ref('Ping') }]);
  assert.doesNotMatch(result.text, /not run|read again|retry|engine browser/, result.text.split('\n')[0]);
  assert.equal(f.delta().payment, 1, 'the click reached the page');
});
test('a click on a page whose same-site frame cannot be armed says to use the engine browser path, and sends nothing (F-INT-1)', { skip, timeout: 60000 }, async t => {
  // The page cannot be read with that frame in it (browser_read fails on sandboxed frames, a separate problem), so the click goes in directly.
  const b = await bank(t), f = await b.start(plain(pingPage(), ''), readOnly, { routes: sandboxRoutes });
  await addFrames(f, '<iframe src="/csp" title="s"></iframe>');
  await assert.rejects(backgroundClick(f.entry, f.page.locator('#b')), error => /use the engine browser path/.test(error.message) && !/retry is safe|read again/.test(error.message), 'the message');
  await settle();
  assert.equal(f.delta().payment, 0, 'nothing was sent');
});
