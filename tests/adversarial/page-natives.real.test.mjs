import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, plain, payment, payRequest, readOnly, skip, terms } from './fixtures/bank.mjs';

// Class 2. The page redefines natives in its own (main) world, or shadows them
// with DOM named properties, which cross worlds. Sleight reads page state from a
// separate utility world, but a form's named controls and the document's named
// img/form/object/embed elements shadow properties in every world, and the
// background-popup hook itself runs in the main world beside the page.
const mismatch = (extra = '') => payment.replace('data-payment-amount="18.00">Amount: 18.00', 'data-payment-amount="99.00">Amount: 99.00')
  .replace('<label>Note', extra + '<label>Note');
const maybeRef = (f, label) => { try { return f.ref(label); } catch { return undefined; } };
const deadline = (promise, ms = 20000) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve('HUNG'), ms))]);

test('control: the exact authorized payment goes through once with clean natives', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(payment), payRequest);
  const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  assert.doesNotMatch(result.text, /not run/);
  assert.equal(f.delta().payment, 1);
});

// Main-world redefinitions. The trust reads must not consult any of these.
const overrides = {
  'Document.prototype.activeElement': `Object.defineProperty(Document.prototype,'activeElement',{configurable:true,get(){return document.getElementById('a')}});`,
  'document.activeElement (own property)': `Object.defineProperty(document,'activeElement',{configurable:true,get(){return document.getElementById('a')}});`,
  'HTMLButtonElement.prototype.form': `Object.defineProperty(HTMLButtonElement.prototype,'form',{configurable:true,get(){return null}});`,
  'HTMLInputElement.prototype.form': `Object.defineProperty(HTMLInputElement.prototype,'form',{configurable:true,get(){return null}});`,
  'Element.prototype.checkVisibility': `Element.prototype.checkVisibility=()=>true;`,
  'Element.prototype.getAttribute': `const g=Element.prototype.getAttribute;Element.prototype.getAttribute=function(n){return /payment|aria-label|autocomplete|type/.test(n)?null:g.call(this,n)};`,
  'Element.prototype.hasAttribute': `Element.prototype.hasAttribute=()=>false;`,
  'Node.prototype.textContent': `Object.defineProperty(Node.prototype,'textContent',{configurable:true,get(){return 'Next'},set(){}});`,
  'Element.prototype.closest': `Element.prototype.closest=()=>null;`,
  'Element.prototype.querySelectorAll': `Element.prototype.querySelectorAll=()=>[];`,
  'Element.prototype.getBoundingClientRect': `Element.prototype.getBoundingClientRect=()=>({left:0,top:0,right:9999,bottom:9999,width:9999,height:9999});`,
  'Element.prototype.matches': `Element.prototype.matches=()=>false;`,
  'window.getComputedStyle': `window.getComputedStyle=()=>({opacity:'1',visibility:'visible',display:'block'});`,
  'HTMLElement.prototype.focus': `HTMLElement.prototype.focus=function(){};`,
  'HTMLInputElement.prototype.value': `Object.defineProperty(HTMLInputElement.prototype,'value',{configurable:true,get(){return '18.00'},set(){}});`,
  'HTMLInputElement.prototype.type': `Object.defineProperty(HTMLInputElement.prototype,'type',{configurable:true,get(){return 'text'}});`,
};
for (const [name, script] of Object.entries(overrides))
  test('main-world override of ' + name + ' cannot launder an unauthorized payment click', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(mismatch() + '<input id="a" aria-label="Search">', script), payRequest);
    const result = await f.act([{ do: 'click', ref: f.ref('Continue') }]);
    assert.match(result.text, /not run|unconfirmed|confirmation/);
    await f.safe();
  });

test('per-element own-property getters for value, form and checkVisibility are invisible to the trust reads', { skip, timeout: 60000 }, async t => {
  const body = `<form id="payment"><p data-payment-item="Fixture item">Item: Fixture item</p>
    <label>Amount<input name="amount" id="amt" value="99.00"></label>
    <p data-payment-payee="Fixture shop">Payee: Fixture shop</p><p data-payment-currency="USD">Currency: USD</p>
    <label>Card<input autocomplete="cc-number"></label><button id="pay">Continue</button></form>`;
  const script = `const amt=document.getElementById('amt'),pay=document.getElementById('pay');
    Object.defineProperty(amt,'value',{get(){return '18.00'}});Object.defineProperty(amt,'checkVisibility',{value:()=>true});
    Object.defineProperty(pay,'form',{get(){return null}});Object.defineProperty(pay,'getAttribute',{value:()=>null});`;
  const b = await bank(t), f = await b.start(doc(body, script), payRequest);
  await f.act([{ do: 'click', ref: f.ref('Continue') }]);
  await f.safe();
});

// DOM clobbering of document properties by a named element that is the checked ref.
for (const tag of ['img', 'form', 'object', 'embed'])
  test('document.activeElement clobbered by <' + tag + ' name=activeElement> never lets a focus redirect pass the checked-focus test', { skip, timeout: 60000 }, async t => {
    const element = { img: '<img name="activeElement" id="h" tabindex="0" alt="Help" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
      form: '<form name="activeElement" id="h" tabindex="0" aria-label="Help"></form>',
      object: '<object name="activeElement" id="h" tabindex="0" aria-label="Help"></object>',
      embed: '<embed name="activeElement" id="h" tabindex="0" aria-label="Help">' }[tag];
    const b = await bank(t), f = await b.start(doc(element + payment, `h.addEventListener('focus',()=>pay.focus());`), readOnly);
    const ref = maybeRef(f, 'Help');
    if (!ref) { t.diagnostic('the clobbering element is not nameable in the snapshot, so the model cannot press on it'); await f.safe(); return; }
    const real = () => f.page.evaluate(() => Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement').get.call(document)?.id);
    const result = await f.act([{ do: 'press', ref, key: 'Enter' }]);
    t.diagnostic(JSON.stringify({ realFocusAfter: await real(), outcome: result.text.split('\n')[0] }));
    await f.safe();
  });

test('document.activeElement clobbered by <iframe name=activeElement> (a window, not an element) fails closed', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(doc(`<iframe name="activeElement" src="about:blank" title="frame"></iframe><input id="a" aria-label="Search">` + payment,
    `a.addEventListener('focus',()=>pay.focus());`), readOnly);
  await f.act([{ do: 'press', ref: f.ref('Search'), key: 'Enter' }]);
  await f.safe();
});

test('clobbered activeElement, defaultView and frameElement inside a same-origin frame cannot satisfy the frame walk', { skip, timeout: 60000 }, async t => {
  const inner = doc(`<img name="activeElement" id="defaultView" tabindex="0" alt="Frame help" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><img name="frameElement" alt="x" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">`,
    `document.querySelector('[tabindex]').addEventListener('focus',()=>parent.document.getElementById('pay').focus());`);
  const b = await bank(t), f = await b.start(doc('<iframe src="/inner" title="inner"></iframe>' + payment), readOnly, { routes: { '/inner': inner } });
  const ref = maybeRef(f, 'Frame help');
  if (ref) await f.act([{ do: 'press', ref, key: 'Enter' }]);
  await f.safe();
});

// Named controls inside the payment form shadow the form's own properties.
// Page terms disagree with the authorized request, so the safe outcome is no payment.
// A name that makes the reader loop forever is an availability failure, reported as HUNG.
const formNames = ['elements', 'action', 'method', 'submit', 'form', 'target', 'id', 'children', 'attributes', 'localName', 'tagName', 'nodeType',
  'textContent', 'innerText', 'parentElement', 'parentNode', 'ownerDocument', 'querySelectorAll', 'querySelector', 'getAttribute', 'hasAttribute', 'closest',
  'matches', 'contains', 'getRootNode', 'getBoundingClientRect', 'getClientRects', 'checkVisibility', 'clientLeft', 'clientTop', 'clientWidth', 'clientHeight',
  'isConnected', 'shadowRoot', 'labels', 'length', 'checkValidity', 'reset', 'requestSubmit', 'style'];
for (const name of formNames)
  test('payment form control named "' + name + '" shadows the form property without opening a payment or hanging the reader', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(mismatch(`<input name="${name}" value="x" aria-label="Shadow ${name}">`)), payRequest);
    const ref = maybeRef(f, 'Continue');
    if (!ref) { t.diagnostic('snapshot has no Continue ref (the page blinded the reader); nothing can be pressed'); await f.safe(); return; }
    const outcome = await deadline(f.act([{ do: 'click', ref }]));
    assert.notEqual(outcome, 'HUNG', 'the trust read never returned: a control named "' + name + '" stalls the reader in the page renderer');
    await f.safe();
  });

// Document-level named properties used by the trust reads.
const docNames = ['createTreeWalker', 'createRange', 'defaultView', 'querySelector', 'querySelectorAll', 'getElementById', 'body', 'documentElement',
  'elementFromPoint', 'location', 'forms', 'cookie'];
for (const name of docNames)
  test('document property "' + name + '" clobbered by <img name> cannot launder a payment click', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(doc(`<img name="${name}" alt="x" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">` + mismatch()), payRequest);
    const outcome = await deadline(f.act([{ do: 'click', ref: f.ref('Continue') }]));
    assert.notEqual(outcome, 'HUNG');
    await f.safe();
  });

// The background-popup hook runs in the page's own world. Its natives can be
// shadowed or restored by the page. The browser's tab active bit, read by an
// independent observer, proves whether a tab came to the foreground.
const landed = b => ({ '/landed': '<!doctype html><title>landed</title><h1>Landed</h1>', '/danger': (req, res) => { b.effects.payment++; res.end('<h1>danger</h1>'); } });

test('control: a target=_blank form submit opens a background tab (no active-tab change)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<form action="/landed" target="_blank"><button id="send">Send</button></form>'), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Send') }]);
  await f.safe({ settle: 600 });
});

test('document.querySelector overridden to hide <base target=_blank> keeps a form submit out of the foreground', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const html = plain('<form action="/landed"><button id="send">Send</button></form>', `document.querySelector=()=>null;`, '<base target="_blank">');
  const f = await b.start(html, readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Send') }]);
  await f.safe({ settle: 800 });
});

test('Document.prototype.querySelector overridden to hide <base target=_blank> keeps a link out of the foreground', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const html = plain('<a id="go" href="/landed">Open page</a>', `Document.prototype.querySelector=function(){return null};`, '<base target="_blank">');
  const f = await b.start(html, readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Open page') }]);
  await f.safe({ settle: 800 });
});

test('window.name set to _blank makes target=_blank look like the current context, link click stays in the background', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="go" href="/landed" target="_blank">Open page</a>', `window.name='_blank';`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Open page') }]);
  await f.safe({ settle: 800 });
});

test('window.name set to _blank, form target=_blank submit stays in the background', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<form action="/landed" target="_blank"><button id="send">Send</button></form>', `window.name='_blank';`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Send') }]);
  await f.safe({ settle: 800 });
});

// The agent's Ctrl-click keeps a page-opened tab in the background only while the
// modifier is held. A timer that fires after the click has finished still has
// transient user activation, and its programmatic anchor click or form submit
// opens a normal foreground tab. window.open from an owned background tab is
// refused by the browser itself, so it is the control.
const delayed = {
  'anchor.click() inside the agent click handler': ['a.click()', true],
  'window.open() 700 ms after the agent click': ["setTimeout(()=>window.open('/landed'),700)", true],
  'anchor.click() 100 ms after the agent click': ['setTimeout(()=>a.click(),100)'],
  'anchor.click() 700 ms after the agent click': ['setTimeout(()=>a.click(),700)'],
  'form.submit() to target=_blank 700 ms after the agent click': ['setTimeout(()=>f.submit(),700)'],
  'form.requestSubmit() to target=_blank 700 ms after the agent click': ['setTimeout(()=>f.requestSubmit(),700)'],
};
for (const [name, [body, control]] of Object.entries(delayed))
  test((control ? 'control: ' : '') + name + ' never brings a tab to the foreground', { skip, timeout: 90000 }, async t => {
    const b = await bank(t, { observeTabs: true });
    const script = `document.getElementById('go').addEventListener('click',()=>{const a=document.getElementById('a'),f=document.getElementById('f');${body}});`;
    const f = await b.start(plain('<a id="a" href="/landed" target="_blank" hidden>x</a><form id="f" action="/landed" target="_blank"></form><button id="go" type="button">Open help</button>', script),
      readOnly, { routes: landed(b) });
    await f.act([{ do: 'click', ref: f.ref('Open help') }]);
    await new Promise(resolve => setTimeout(resolve, 1500));
    t.diagnostic(JSON.stringify({ requestsSeen: f.hits().map(h => h.path), tabs: (await b.tabState()).map(x => x.url.replace(b.origin, '') + (x.active ? ' ACTIVE' : '')) }));
    await f.safe({ settle: 300 });
  });

test('control: an ordinary preventDefault on the link click stops sleight from opening it', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="l" href="/danger" target="_blank">Learn more</a>', `document.getElementById('l').addEventListener('click',e=>e.preventDefault());`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await f.safe({ settle: 800 });
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/danger')), []);
});

test('pristine Event.prototype.preventDefault from a frame realm cannot make sleight open a link the page cancelled', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `const pd=document.getElementById('r').contentWindow.Event.prototype.preventDefault;
    document.getElementById('l').addEventListener('click',e=>pd.call(e));`;
  const f = await b.start(plain('<iframe id="r" src="about:blank" hidden></iframe><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await f.safe({ settle: 800 });
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/danger')), [], 'the page cancelled the click; no request for the link target may follow');
});

test('inline onclick cancel through a frame-realm preventDefault cannot make sleight open the link', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const html = plain('<iframe id="r" src="about:blank" hidden></iframe><a id="l" href="/danger" target="_blank" onclick="document.getElementById(\'r\').contentWindow.Event.prototype.preventDefault.call(event)">Learn more</a>');
  const f = await b.start(html, readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await f.safe({ settle: 800 });
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/danger')), []);
});

// Round 2 of the popup hook. Every page here is a script-started or keyboard-started opening, a cancel from
// another realm, or a nested document. The browser's own tab active bit and the fixture server's request log
// decide the outcome; /danger is a request that must never be made, /landed one the agent's link may make.
const dangerHits = f => f.hits().filter(h => h.path.startsWith('/danger')).map(h => h.path);
const landedHits = f => f.hits().filter(h => h.path.startsWith('/landed')).map(h => h.path);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a window handle from an earlier agent click cannot cancel a later link click behind sleight (A1)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `go.onclick=()=>{window.__w=window.open('/landed','w')};
    document.getElementById('l').addEventListener('click',e=>{if(window.__w)window.__w.Event.prototype.preventDefault.call(e)});`;
  const f = await b.start(plain('<button id="go" type="button">Go</button><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(800);
  await f.act([{ do: 'click', ref: f.ref('Learn more', await f.read()) }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), [], 'the handle cancelled the click; no request for the link target may follow');
  await f.safe({ settle: 300 });
});

for (const [name, make] of Object.entries({
  'detached html anchor': `const a=document.createElement('a');a.href='/danger';a.target='_blank';`,
  'svg anchor': `const a=document.createElementNS('http://www.w3.org/2000/svg','a');a.setAttribute('href','/danger');a.setAttribute('target','_blank');`,
  'child of a detached anchor': `const p=document.createElement('a');p.href='/danger';p.target='_blank';const a=document.createElement('span');p.append(a);`,
})) test('dispatchEvent(click) on a ' + name + ' never opens a tab (A2)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `go.onclick=()=>setTimeout(()=>{${make}a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))},400)`;
  const f = await b.start(plain('<button id="go" type="button">Go</button>', script), readOnly, { routes: landed(b) });
  const result = await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(1500);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('w.focus() on a popup the page opened during an agent click does not raise it (A3)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<button id="go" type="button">Go</button>', `go.onclick=()=>{const w=window.open('/landed','w');setTimeout(()=>{try{w.focus()}catch(e){}},700)}`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(1800);
  await f.safe({ settle: 300 });
});

test('a script click on a link to a known named window does not navigate and raise it (A3)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="a" href="/danger" target="w" hidden>x</a><button id="go" type="button">Go</button>',
    `go.onclick=()=>{window.open('/landed','w');setTimeout(()=>a.click(),700)}`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(1800);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('the agent clicking a link to a known named window keeps it in the background (A3)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="a" href="/landed?second" target="w">Open again</a><button id="go" type="button">Go</button>',
    `go.onclick=()=>{window.open('/landed','w')}`), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(800);
  const result = await f.act([{ do: 'click', ref: f.ref('Open again', await f.read()) }]);
  await pause(1200);
  assert.ok(landedHits(f).some(path => path.includes('second')), 'the link was opened: ' + landedHits(f));
  assert.equal((await b.tabState()).filter(x => x.url.includes('/landed')).length, 1, 'the named window was reused, not duplicated');
  await f.safe({ settle: 300 });
});

test('Enter on a focused target=_blank link opens it in the background (A4)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="a" href="/landed" target="_blank">Open it</a>'), readOnly, { routes: landed(b) });
  const result = await f.act([{ do: 'press', ref: f.ref('Open it'), key: 'Enter' }]);
  await pause(1200);
  assert.deepEqual(landedHits(f), ['/landed'], result.text);
  await f.safe({ settle: 300 });
});

for (const [name, body, ref] of [
  ['in a text field of', '<input aria-label="Query" name="q">', 'Query'],
  ['on a focused submit button of', '<button id="send">Send</button>', 'Send'],
]) test('Enter ' + name + ' a target=_blank form is refused before it can raise a tab (A4)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<form action="/landed" target="_blank">' + body + '</form>'), readOnly, { routes: landed(b) });
  const result = await f.act([{ do: 'press', ref: f.ref(ref), key: 'Enter' }]);
  await pause(1200);
  assert.match(result.text, /not run: .*click its submit button/, result.text.split('\n')[0]);
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('Enter in a text field of a same-tab form still submits (A4)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<form action="/landed"><input aria-label="Query" name="q"></form>'), readOnly, { routes: landed(b) });
  await f.act([{ do: 'press', ref: f.ref('Query'), key: 'Enter' }]);
  await pause(1000);
  assert.deepEqual(landedHits(f), ['/landed?q=']);
  await f.safe({ settle: 300, tabs: false });
});

const frames = {
  'hidden srcdoc iframe': '<iframe hidden srcdoc="<p>hi</p>"></iframe>',
  'hidden about:blank iframe': '<iframe hidden src="about:blank"></iframe>',
  'chat widget iframe created by script': '',
};
for (const [name, markup] of Object.entries(frames))
  test('a new-tab link click still works beside a ' + name + ' (A5)', { skip, timeout: 90000 }, async t => {
    const b = await bank(t, { observeTabs: true });
    const script = markup ? '' : `const fr=document.createElement('iframe');fr.style.display='none';document.body.append(fr);fr.contentDocument.write('<p>widget</p>');`;
    const f = await b.start(plain('<a id="a" href="/landed" target="_blank">Open docs</a>' + markup, script), readOnly, { routes: landed(b) });
    const result = await f.act([{ do: 'click', ref: f.ref('Open docs') }]);
    await pause(1200);
    assert.doesNotMatch(result.text, /unconfirmed|not captured|link default changed/, result.text.split('\n')[0]);
    assert.deepEqual(landedHits(f), ['/landed']);
    await f.safe({ settle: 300 });
  });

test('a srcdoc iframe realm that cancels the click still stops the link (A5)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `const pd=document.getElementById('r').contentWindow.Event.prototype.preventDefault;
    document.getElementById('l').addEventListener('click',e=>pd.call(e));`;
  const f = await b.start(plain('<iframe id="r" hidden srcdoc="<p>hi</p>"></iframe><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

for (const [name, body] of Object.entries({
  'after an await': `go.onclick=async()=>{await fetch('/landed?f');a.click()}`,
  'in a zero-delay timer': `go.onclick=()=>{setTimeout(()=>a.click(),0)}`,
})) test('a script link click ' + name + ' is held and the result says so (A6)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<a id="a" href="/landed" target="_blank" hidden>x</a><button id="go" type="button">Go</button>', body), readOnly, { routes: landed(b) });
  const result = await f.act([{ do: 'click', ref: f.ref('Go') }]);
  assert.match(result.text, /page script tried to open .*held/i, result.text.split('\n').slice(0, 3).join(' | '));
  await pause(500);
  assert.deepEqual(landedHits(f).filter(path => path === '/landed'), []);
  await f.safe({ settle: 300 });
});

test('a click that opens nothing from script carries no held-opening sentence (A6)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<button id="go" type="button">Go</button>', `go.onclick=()=>{document.title='x'}`), readOnly);
  const result = await f.act([{ do: 'click', ref: f.ref('Go') }]);
  assert.doesNotMatch(result.text, /tried to open/i);
  await f.safe({ settle: 300 });
});

test('a preventDefault taken from an iframe the page then removed still stops the link (A5)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `const fr=document.getElementById('r'),pd=fr.contentWindow.Event.prototype.preventDefault;fr.remove();
    document.getElementById('l').addEventListener('click',e=>pd.call(e));`;
  const f = await b.start(plain('<iframe id="r" hidden srcdoc="<p>hi</p>"></iframe><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('a forged hook object on a window handle does not hide that window from the cancel check (A1)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `go.onclick=()=>{const w=window.__w=window.open('/landed','w');window.__nat=w.Event.prototype.preventDefault;
      w.Event.prototype.preventDefault=function(){return top.Event.prototype.preventDefault.call(this)};w[Symbol.for('sleight.popup3')]={cancel(){}};};
    document.getElementById('l').addEventListener('click',e=>window.__nat.call(e));`;
  const f = await b.start(plain('<button id="go" type="button">Go</button><a id="l" href="/danger" target="_blank">Learn more</a>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(800);
  await f.act([{ do: 'click', ref: f.ref('Learn more', await f.read()) }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), [], 'documented limit if this fails: a page holding a native preventDefault from an unhooked window');
  await f.safe({ settle: 300 });
});

test('a capture listener that stops propagation first cannot let a detached link click open a tab (A2)', { skip, timeout: 90000 }, async t => {
  const b = await bank(t, { observeTabs: true });
  const script = `go.onclick=()=>setTimeout(()=>{const a=document.createElement('a');a.href='/danger';a.target='_blank';
    a.addEventListener('click',e=>e.stopImmediatePropagation(),true);a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))},400)`;
  const f = await b.start(plain('<button id="go" type="button">Go</button>', script), readOnly, { routes: landed(b) });
  await f.act([{ do: 'click', ref: f.ref('Go') }]);
  await pause(1500);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// Round 3 of the popup hook. "Foreground" is the browser's own tab active bit: f.safe() compares it with the
// value at start and counts focus commands on the wire. /danger must never be requested, /landed may be.
async function attack(t, { body = '', script = '', steps, wait = 1500 } = {}) {
  const b = await bank(t, { observeTabs: true });
  const f = await b.start(plain('<button id="go" type="button">Go</button>' + body, script), readOnly, { routes: landed(b) });
  const result = await f.act(steps ? steps(f) : [{ do: 'click', ref: f.ref('Go') }]);
  await pause(wait);
  return { b, f, result };
}
const press = (label, key = 'Enter') => f => [{ do: 'press', ref: f.ref(label), key }];
const click = label => f => [{ do: 'click', ref: f.ref(label) }];
const first = result => result.text.split('\n')[0];

// A1: a window.open handle's first document carries the whole hook, so a native saved from it is the hooked one.
for (const [name, body, use] of [
  ['EventTarget.prototype.dispatchEvent on a detached link', '', `const d=w.EventTarget.prototype.dispatchEvent;setTimeout(()=>{const a=document.createElement('a');a.href='/danger';a.target='_blank';d.call(a,new MouseEvent('click',{bubbles:true,cancelable:true}))},400)`],
  ['HTMLFormElement.prototype.submit on a target=_blank form', '<form id="fm" action="/danger" target="_blank"><input name="q" value="1"></form>', `const s=w.HTMLFormElement.prototype.submit;setTimeout(()=>s.call(fm),400)`],
  ['HTMLFormElement.prototype.requestSubmit on a target=_blank form', '<form id="fm" action="/danger" target="_blank"><input name="q" value="1"></form>', `const s=w.HTMLFormElement.prototype.requestSubmit;setTimeout(()=>s.call(fm),400)`],
  ['HTMLElement.prototype.click on a target=_blank link', '<a id="a" href="/danger" target="_blank" hidden>x</a>', `const c=w.HTMLElement.prototype.click;setTimeout(()=>c.call(a),400)`],
  ['window.open called on the opener', '', `const o=w.open;setTimeout(()=>o.call(window,'/danger','_blank'),400)`],
  ['focus() on the popup', '', `const fc=w.focus;setTimeout(()=>fc.call(w),400)`],
]) test('a native saved from a window handle cannot open or raise a tab later: ' + name + ' (A1)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body, script: `go.onclick=()=>{const w=window.open('/landed');${use}}` });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('the handle realm runs the hook, not just a forwarded preventDefault (A1)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { script: `go.onclick=()=>{const w=window.open('/landed');window.__w=w;
    window.__x=[typeof w[Symbol.for('sleight.popup3')],w.open('/danger','_blank')===null,String(w.HTMLElement.prototype.click).includes('native code')].join()}` });
  assert.equal(await f.page.evaluate(() => window.__x), 'object,true,false');
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// A2: checks accept a node from any realm and look through shadow roots.
test('a hooked iframe realm dispatchEvent cannot click a detached target=_blank link (A2)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { script: `go.onclick=()=>{const fr=document.createElement('iframe');document.body.append(fr);const d=fr.contentWindow.EventTarget.prototype.dispatchEvent;
    setTimeout(()=>{const a=document.createElement('a');a.href='/danger';a.target='_blank';d.call(a,new MouseEvent('click',{bubbles:true,cancelable:true}))},400)}` });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('the top-realm dispatchEvent cannot click a link created in an iframe document (A2)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { script: `go.onclick=()=>{const fr=document.createElement('iframe');document.body.append(fr);const doc=fr.contentDocument;
    setTimeout(()=>{const a=doc.createElement('a');a.href='/danger';a.target='_blank';EventTarget.prototype.dispatchEvent.call(a,new MouseEvent('click',{bubbles:true,cancelable:true}))},400)}` });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

for (const [name, fire] of Object.entries({
  'dispatchEvent on an attached link': `a.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`,
  'click() on a span inside the link': `const s=document.createElement('span');a.append(s);s.click()`,
  'dispatchEvent on a span inside the link': `const s=document.createElement('span');a.append(s);s.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}))`,
})) test('a link in a closed shadow root is held: ' + name + ' (A2)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { script: `go.onclick=()=>setTimeout(()=>{const h=document.createElement('div');document.body.append(h);const sr=h.attachShadow({mode:'closed'});
    const a=document.createElement('a');a.href='/danger';a.target='_blank';sr.append(a);${fire}},300)` });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// A4: every spelling of Enter arms the hook; a press whose destination cannot be decided is refused.
test('NumpadEnter on a target=_blank link opens in the background like Enter (A4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_blank">Open it</a>', steps: press('Open it', 'NumpadEnter') });
  assert.deepEqual(landedHits(f), ['/landed'], first(result));
  await f.safe({ settle: 300 });
});

for (const [name, body, ref] of [
  ['a submit button outside the form with formtarget=_blank', '<form id="fm" action="/landed"></form><button form="fm" formtarget="_blank" id="b">Send out</button>', 'Send out'],
  ['a field whose default submit button sits outside the form with formtarget=_blank', '<form id="fm" action="/landed"><input name="q" aria-label="Query" value="x"></form><button form="fm" formtarget="_blank" type="submit">Go out</button>', 'Query'],
  ['a field whose form= attached default button has formtarget=new-name', '<form id="fm" action="/landed"></form><input form="fm" name="q" aria-label="Query" value="x"><button form="fm" formtarget="elsewhere">Go out</button>', 'Query'],
]) test('Enter on ' + name + ' is refused before it can raise a tab (A4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, steps: press(ref) });
  assert.match(result.text, /not run: .*click its submit button/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('Enter in a field submits the form when only a later button has formtarget=_blank (A4)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form action="/landed"><input name="q" aria-label="Query"><button>Search</button><button type="submit" formtarget="_blank">Search in a new tab</button></form>',
    steps: press('Query'), wait: 1000 });
  assert.doesNotMatch(result.text, /not run/, first(result));
  assert.deepEqual(landedHits(f), ['/landed?q=']);
  await f.safe({ settle: 300, tabs: false });
});

for (const [name, href] of [['credentials in its address', 'http://u:p@127.0.0.1:1/landed'], ['an about:blank address', 'about:blank']]) {
  test('Enter on a target=_blank link with ' + name + ' is refused (A4)', { skip, timeout: 90000 }, async t => {
    const { f, result } = await attack(t, { body: `<a id="a" href="${href}" target="_blank">Open it</a>`, steps: press('Open it') });
    assert.match(result.text, /not run: .*cannot check where it goes/, first(result));
    await f.safe({ settle: 300 });
  });
  test('a click on a target=_blank link with ' + name + ' still stays in the background (A4)', { skip, timeout: 90000 }, async t => {
    const { f, result } = await attack(t, { body: `<a id="a" href="${href}" target="_blank">Open it</a>`, steps: click('Open it') });
    assert.doesNotMatch(result.text, /not run/, first(result));
    await f.safe({ settle: 300 });
  });
}

// A5: a cancel through a hooked realm's returnValue setter reaches the clicked page.
test('returnValue=false through a hooked iframe realm setter stops the link (A5)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: '<iframe id="r" hidden srcdoc="<p>hi</p>"></iframe><a id="l" href="/danger" target="_blank">Learn more</a>',
    script: `const set=Object.getOwnPropertyDescriptor(document.getElementById('r').contentWindow.Event.prototype,'returnValue').set;
      document.getElementById('l').addEventListener('click',e=>set.call(e,false))`, steps: click('Learn more') });
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

test('returnValue=false through a setter saved from a window handle stops the link (A5)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: '<a id="l" href="/danger" target="_blank">Learn more</a>',
    script: `go.onclick=()=>{const w=window.open('/landed');window.__s=Object.getOwnPropertyDescriptor(w.Event.prototype,'returnValue').set};
      document.getElementById('l').addEventListener('click',e=>{if(window.__s)window.__s.call(e,false)})` });
  await f.act([{ do: 'click', ref: f.ref('Learn more') }]);
  await pause(1200);
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});

// A link's or form's own listener changes the destination after the hook decided it was a plain click.
const flip = 'a.addEventListener("click",()=>{a.target="_blank"})';
for (const [name, body, script, steps] of [
  ['its own click listener', '<a id="a" href="/landed" target="_self">Open it</a>', flip, click('Open it')],
  ['a document capture listener', '<a id="a" href="/landed" target="_self">Open it</a>', 'document.addEventListener("click",()=>{a.target="_blank"},true)', click('Open it')],
  ['a base element added by a listener', '<a id="a" href="/landed">Open it</a>', 'a.addEventListener("click",()=>{const b=document.createElement("base");b.target="_blank";document.head.append(b)})', click('Open it')],
  ['its own listener, then Enter', '<a id="a" href="/landed" target="_self">Open it</a>', flip, press('Open it')],
  ['a pointerdown listener', '<a id="a" href="/landed" target="_self">Open it</a>', 'a.addEventListener("pointerdown",()=>{a.target="_blank"})', click('Open it')],
]) test('a same-tab link that turns into a new-tab link in ' + name + ' opens in the background (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body, script, steps });
  assert.deepEqual(landedHits(f), ['/landed'], first(result));
  await f.safe({ settle: 300 });
});

test('a same-tab link whose listener flips it to a new tab pointing at credentials is stopped (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_self">Open it</a>',
    script: 'a.addEventListener("click",()=>{a.target="_blank";a.href="http://u:p@127.0.0.1:1/x"})', steps: click('Open it') });
  assert.match(result.text, /changed this link/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('a new-tab link that flips to same-tab in its listener opens nothing and says so (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="a" href="/landed" target="_blank">Open it</a>',
    script: 'a.addEventListener("click",()=>{a.target="_self"})', steps: click('Open it') });
  assert.match(result.text, /changed|not captured/, first(result));
  await f.safe({ settle: 300 });
});

for (const [name, script] of [
  ['its submit button listener', 's.addEventListener("click",()=>{fm.target="_blank"})'],
  ['its submit listener', 'fm.addEventListener("submit",()=>{fm.target="_blank"})'],
  ['a formtarget set on the button', 's.addEventListener("click",()=>{s.setAttribute("formtarget","_blank")})'],
]) test('a same-tab form that turns into a new-tab form in ' + name + ' is stopped (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form id="fm" action="/landed"><button id="s">Save it</button></form>', script, steps: click('Save it') });
  assert.match(result.text, /changed this form/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('Enter in a same-tab form whose submit listener turns it into a new-tab form is stopped (flip)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form id="fm" action="/landed"><input name="q" aria-label="Query"><button>Search</button></form>',
    script: 'fm.addEventListener("submit",()=>{fm.target="_blank"})', steps: press('Query') });
  assert.match(result.text, /changed this form/, first(result));
  assert.deepEqual(landedHits(f), []);
  await f.safe({ settle: 300 });
});

test('a same-tab form still submits when a listener only observes the click (flip control)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<form id="fm" action="/landed"><button id="s">Save it</button></form>',
    script: 's.addEventListener("click",()=>{window.__seen=1})', steps: click('Save it'), wait: 1000 });
  assert.doesNotMatch(result.text, /changed|not run/, first(result));
  assert.deepEqual(landedHits(f), ['/landed']);
  await f.safe({ settle: 300, tabs: false });
});

// window.focus is a no-op for a top-level window, never for a frame.
test('iframe.contentWindow.focus() still focuses the frame (focus)', { skip, timeout: 90000 }, async t => {
  const { f } = await attack(t, { body: '<iframe id="ed" title="editor" srcdoc="<body contenteditable>hello</body>" width=300 height=100></iframe>',
    script: `go.onclick=()=>{ed.contentWindow.focus();window.__x=document.activeElement.tagName+':'+ed.contentDocument.hasFocus()}` });
  assert.equal(await f.page.evaluate(() => window.__x), 'IFRAME:true');
  await f.safe({ settle: 300 });
});

// Known gap, reported: a script-started click on a link that flips its own target (a timer started by an
// unmodified agent click) still raises the tab. The result must not call that tab a background tab.
test('a script click that flips its own link after an unmodified click is reported as a probable foreground tab (known gap)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { body: '<a id="l1" href="/landed?start">Start</a><a id="a2" href="/landed" target="_self" hidden>x</a>',
    script: 'a2.addEventListener("click",()=>{a2.target="_blank"});document.getElementById("l1").addEventListener("click",e=>{e.preventDefault();setTimeout(()=>a2.click(),50)})',
    steps: click('Start') });
  assert.match(result.text, /probably took the foreground/, first(result));
  assert.doesNotMatch(result.text, /opened background tab/);
});

for (const [name, body] of Object.entries({
  'a user-blocking scheduler task': `go.onclick=()=>{scheduler.postTask(()=>window.open('/danger'),{priority:'user-blocking'})}`,
  'a message channel task': `go.onclick=()=>{const m=new MessageChannel();m.port1.onmessage=()=>window.open('/danger');m.port2.postMessage(1)}`,
  'a zero-delay timer': `go.onclick=()=>{setTimeout(()=>window.open('/danger'),0)}`,
})) test('window.open from ' + name + ' started by an agent click is held, not raised (dispatch end)', { skip, timeout: 90000 }, async t => {
  const { f, result } = await attack(t, { script: body });
  assert.match(result.text, /page script tried to open .*held/i, first(result));
  assert.deepEqual(dangerHits(f), []);
  await f.safe({ settle: 300 });
});
