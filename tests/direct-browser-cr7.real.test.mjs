import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { fixture, controls, skip } from './fixtures/cr4-real.mjs';

for (const label of [false, true]) for (const method of ['GET', 'POST'])
  for (const [kind, control] of Object.entries(controls)) for (const destination of ['form', 'control', 'base', 'named'])
    test(`CR7 real background submit: ${label ? 'label' : 'direct'} ${method} ${kind} ${destination}`,
      { skip, timeout: 60000 }, async t => {
        const target = destination === 'named' ? 'new-destination' : '_blank';
        const html = (destination === 'base' ? '<base target="_blank">' : '')
          + `<form method="${method}" action="/landed"${destination === 'form' || destination === 'named' ? ` target="${target}"` : ''}>`
          + '<input name="q" value="sent">'
          + control.replace(/<(button|input)/, `<$1 id="send"${destination === 'control' ? ' formtarget="_blank"' : ''}`)
          + '</form>' + (label ? '<label id="go" for="send">Submit label</label>' : '');
        const f = await fixture(t, html), page = f.entry.page, clicks = [], navigation = [];
        // Focus emulation makes every owned page look focused/visible. Disable it
        // for this receipt so an accidentally foregrounded child cannot pass.
        await f.entry.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        const observe = () => page.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }));
        const before = await observe();
        await page.evaluate(() => {
          window.focusEvents = 0; window.visibilityEvents = 0;
          addEventListener('focus', () => window.focusEvents++);
          document.addEventListener('visibilitychange', () => window.visibilityEvents++);
        });
        f.entry.cdp.on('Page.frameRequestedNavigation', event => navigation.push(event));
        const next = f.context.waitForEvent('page', { timeout: 5000 });
        const locator = page.locator(label ? '#go' : '#send');
        await backgroundClick(f.entry, locator, options => {
          clicks.push(options); return locator.click({ ...options, timeout: 5000 });
        }, { timeoutMs: 5000 });
        const child = await next;
        await child.waitForURL('**/landed**'); await f.registry.idle();
        const childCDP = await f.context.newCDPSession(child);
        try {
          await childCDP.send('Emulation.setFocusEmulationEnabled', { enabled: false });
          const disposition = await child.evaluate(() => ({ focused: document.hasFocus(), visibility: document.visibilityState }));
          t.diagnostic('background disposition ' + JSON.stringify({ before, after: await observe(), child: disposition, clicks, navigation }));
          assert.deepEqual(clicks, [{ modifiers: ['ControlOrMeta'] }]);
          assert.deepEqual(disposition, { focused: false, visibility: 'hidden' }, 'new tab must be background, with focus emulation off');
          assert.deepEqual(await observe(), before, 'opener keeps its focus and visibility state');
          assert.deepEqual(await page.evaluate(() => [window.focusEvents, window.visibilityEvents]), [0, 0]);
          assert.match(page.url(), /\/start$/);
          assert.equal(f.context.pages().length, 3);
          assert.ok(f.requests.some(request => request.method === method && request.url.startsWith('/landed')));
          assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
        } finally { await childCDP.detach(); }
      });

for (const mode of ['contenteditable', 'designMode']) for (const target of ['_self', '_blank', 'new-destination'])
  test(`CR7 real link in ${mode} places the caret: ${target}`, { skip, timeout: 60000 }, async t => {
    const link = `<a id="go" href="/landed" target="${target}"><span>Editable link</span></a>`;
    const html = mode === 'contenteditable' ? `<div contenteditable>${link}</div>` : link + '<script>document.designMode="on"</script>';
    const f = await fixture(t, html), page = f.entry.page, choices = [];
    const locator = page.locator('#go span');
    await backgroundClick(f.entry, locator, options => { choices.push(options); return locator.click({ ...options, timeout: 5000 }); }, { timeoutMs: 5000 });
    assert.deepEqual(choices, [{}]);
    assert.match(page.url(), /\/start$/);
    assert.equal(f.context.pages().length, 2, 'an editable link must not open a tab');
    assert.equal(f.requests.some(request => request.url.startsWith('/landed')), false);
    assert.equal(await page.evaluate(() => !!getSelection()?.anchorNode?.parentElement?.closest('a')), true);
  });
