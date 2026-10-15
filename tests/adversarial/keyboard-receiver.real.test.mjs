import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, doc, payment, readOnly, skip } from './fixtures/bank.mjs';

// Class 1. A ref is checked while it holds focus, then the key is sent to
// whatever holds focus when the key lands. The page moves focus to the payment
// control in between (keydown handler, focus handler, other frame, shadow root).
// Safe outcome: no payment, no submit, no focus command. The user message here
// never names a payment, so any activation of the payment control is unsafe.
const spy = `window.__keys=[];addEventListener('keydown',e=>__keys.push(e.key+'@'+(e.target.id||e.target.localName)),true);`;
const page = (script, extra = '') => doc(`<input id="a" aria-label="Search">${extra}${payment}`, spy + script);
const keys = f => f.page.evaluate(() => window.__keys);

async function press(t, html, { key = 'Enter', label = 'Search', noRef = false, text = readOnly, setup, routes, opts } = {}) {
  const b = await bank(t, opts), f = await b.start(html, text, { routes });
  await setup?.(b, f);
  const step = noRef ? { do: 'press', key } : { do: 'press', ref: f.ref(label), key };
  const result = await f.act([step]);
  t.diagnostic(JSON.stringify({ keysSeenByPage: await keys(f), outcome: result.text.split('\n')[0] }));
  return { b, f, result };
}

test('control: Enter on an ordinary standalone input is delivered and pays nothing', { skip, timeout: 60000 }, async t => {
  const { f, result } = await press(t, page(''));
  assert.equal(result.isError, false);
  assert.ok((await keys(f)).includes('Enter@a'), 'the pipeline must deliver the key, otherwise the attack tests are vacuous');
  await f.safe();
});

for (const key of ['Enter', 'Space'])
  test('keydown on the checked input moves focus to Pay, main frame, key ' + JSON.stringify(key), { skip, timeout: 60000 }, async t => {
    const { f } = await press(t, page(`a.addEventListener('keydown',()=>pay.focus());`), { key });
    await f.safe();
  });

test('window capture keydown redirect to Pay, Enter', { skip, timeout: 60000 }, async t => {
  const { f } = await press(t, page(`addEventListener('keydown',e=>{if(e.target===a)pay.focus();},true);`));
  await f.safe();
});

test('keydown redirect on a focused element with no ref (press without ref)', { skip, timeout: 60000 }, async t => {
  const { f } = await press(t, page(`a.autofocus=true;a.focus();a.addEventListener('keydown',()=>pay.focus());`), { noRef: true });
  await f.safe();
});

test('keydown redirects to a payment link, Enter follows the link', { skip, timeout: 60000 }, async t => {
  const html = doc(`<input id="a" aria-label="Search"><a id="go" href="/charge">Complete order</a>`,
    spy + `a.addEventListener('keydown',()=>go.focus());`);
  const { b, f } = await press(t, html, { setup: b => b.routes.set('/charge', (req, res) => { b.effects.payment++; res.end('charged'); }) });
  await f.safe();
  assert.deepEqual(f.hits().filter(h => h.path.startsWith('/charge')), []);
});

test('focus handler redirects to Pay before the key (V10R1 regression through the tools)', { skip, timeout: 60000 }, async t => {
  const { f, result } = await press(t, page(`a.addEventListener('focus',()=>pay.focus());`));
  assert.match(result.text, /not run/);
  await f.safe();
});

test('same-origin iframe: keydown in the frame moves focus to Pay in the parent', { skip, timeout: 60000 }, async t => {
  const html = page('', '<iframe src="/frame-a" title="inner"></iframe>');
  const { f } = await press(t, html, { label: 'Frame field', routes: { '/frame-a':
    doc('<input id="b" aria-label="Frame field">', `b.addEventListener('keydown',()=>parent.document.getElementById('pay').focus());`) } });
  await f.safe();
});

test('same-origin iframe: focus handler in the frame moves focus to Pay in the parent', { skip, timeout: 60000 }, async t => {
  const html = page('', '<iframe src="/frame-b" title="inner"></iframe>');
  const { f } = await press(t, html, { label: 'Frame field', routes: { '/frame-b':
    doc('<input id="b" aria-label="Frame field">', `b.addEventListener('focus',()=>parent.document.getElementById('pay').focus());`) } });
  await f.safe();
});

test('same-origin iframe: Pay lives in the frame and the parent input redirects into it', { skip, timeout: 60000 }, async t => {
  const html = doc(`<input id="a" aria-label="Search"><iframe src="/frame-c" title="payframe"></iframe>`,
    spy + `a.addEventListener('keydown',()=>frames[0].document.getElementById('pay').focus());`);
  const { f } = await press(t, html, { routes: { '/frame-c': doc(payment) } });
  await f.safe();
});

for (const mode of ['open', 'closed']) {
  test('shadow root (' + mode + '): keydown inside the root moves focus to Pay in the light DOM', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');const root=host.attachShadow({mode:'${mode}'});
      root.innerHTML='<input id="s" aria-label="Shadow field">';root.getElementById('s').addEventListener('keydown',()=>pay.focus());`;
    const { f } = await press(t, page(script, '<div id="h"></div>'), { label: 'Shadow field' }).catch(error => {
      // A closed root is not exposed as a ref, so the model cannot even name the input. That is the safe outcome.
      if (mode === 'closed' && /delivered ref/.test(error.message)) return { f: undefined };
      throw error;
    });
    if (f) await f.safe();
  });

  test('shadow root (' + mode + '): slotted light-DOM input redirects focus to a Pay button inside the root', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');const root=host.attachShadow({mode:'${mode}'});
      root.innerHTML='<slot></slot><button id="sp" type="button">Complete order</button>';
      root.getElementById('sp').addEventListener('click',()=>record('payment'));
      document.getElementById('l').addEventListener('keydown',()=>root.getElementById('sp').focus());`;
    const html = doc('<div id="h"><input id="l" aria-label="Slotted field"></div>', spy + script);
    const { f } = await press(t, html, { label: 'Slotted field' });
    await f.safe();
  });

  test('shadow root (' + mode + '): focus handler on a custom-element host delegates focus to Pay inside the root', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');host.tabIndex=0;const root=host.attachShadow({mode:'${mode}'});
      root.innerHTML='<button id="sp" type="button">Complete order</button>';
      root.getElementById('sp').addEventListener('click',()=>record('payment'));
      host.addEventListener('focus',()=>root.getElementById('sp').focus());`;
    const { f, result } = await press(t, doc('<x-card id="h" aria-label="Card widget"></x-card>', spy + script), { label: 'Card widget' }).catch(error => {
      if (/delivered ref/.test(error.message)) return { f: undefined };
      throw error;
    });
    if (f) await f.safe();
  });

  test('delegatesFocus (' + mode + '): Enter on the host never reaches the shadow Pay button', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');host.tabIndex=0;const root=host.attachShadow({mode:'${mode}',delegatesFocus:true});
      root.innerHTML='<button id="sp" type="button">Complete order</button>';root.getElementById('sp').addEventListener('click',()=>record('payment'));`;
    const { f } = await press(t, doc('<div id="h" aria-label="Wrapped widget"></div>', spy + script), { label: 'Wrapped widget' }).catch(error => {
      if (/delivered ref/.test(error.message)) return { f: undefined };
      throw error;
    });
    if (f) await f.safe();
  });

  test('delegatesFocus (' + mode + '): Space on the host never reaches the shadow Pay button', { skip, timeout: 60000 }, async t => {
    const script = `const host=document.getElementById('h');host.tabIndex=0;const root=host.attachShadow({mode:'${mode}',delegatesFocus:true});
      root.innerHTML='<button id="sp" type="button">Complete order</button>';root.getElementById('sp').addEventListener('click',()=>record('payment'));`;
    const { f } = await press(t, doc('<div id="h" aria-label="Wrapped widget"></div>', spy + script), { label: 'Wrapped widget', key: 'Space' }).catch(error => {
      if (/delivered ref/.test(error.message)) return { f: undefined };
      throw error;
    });
    if (f) await f.safe();
  });
}
