import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, plain, readOnly, skip } from './fixtures/bank.mjs';
import { callHook, hookArgs, openDeep } from './fixtures/hook.mjs';

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

test('key shield: finish disarms, a wrong token neither reads nor ends it, and an expired shield stops vetoing', { skip, timeout: 60000 }, async t => {
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
  assert.equal(await verdict(g, 'b'), undefined, 'past its cap the shield does not veto');
  assert.equal(submitted(g), 1);
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
