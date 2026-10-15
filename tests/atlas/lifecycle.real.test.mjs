import test from 'node:test';
import { atlas, skip, rejected } from './fixture.real.test.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const dialogs = [];
for (const type of ['alert', 'confirm', 'prompt']) for (const accept of [false, true]) {
  dialogs.push({ name: `${type} ${accept ? 'accept' : 'dismiss'} blocks click completion`,
    html: `<button id=go onclick="window.answer=${type}('atlas question'${type === 'prompt' ? ", 'default'" : ''});window.finished=true">Ask</button>`,
    run: async (page, mod) => {
      const ready = page.waitForEvent('dialog'); let completed = false;
      const clicked = page.locator('#go').click({ modifiers: mod }).then(() => { completed = true; });
      const dialog = await ready;
      const beforeAnswer = completed, observedType = dialog.type(), message = dialog.message(), defaultValue = dialog.defaultValue();
      if (accept) await dialog.accept(type === 'prompt' ? 'entered' : undefined); else await dialog.dismiss();
      await clicked;
      return { type: observedType, message, defaultValue, completedBeforeAnswer: beforeAnswer,
        ...await page.evaluate(() => ({ answer: window.answer ?? null, finished: window.finished })) };
    }, want: { type, message: 'atlas question', defaultValue: type === 'prompt' ? 'default' : '', completedBeforeAnswer: false,
      answer: type === 'alert' ? null : type === 'confirm' ? accept : accept ? 'entered' : null, finished: true } });
}
dialogs.push({ name: 'delayed alert can arrive after click completion',
  html: '<button id=go onclick="setTimeout(()=>{alert(\'delayed\');window.finished=true},150)">Ask later</button>',
  run: async (page, mod) => {
    const ready = page.waitForEvent('dialog'); let completed = false;
    const clicked = page.locator('#go').click({ modifiers: mod }).then(() => { completed = true; });
    const dialog = await ready, beforeAnswer = completed; await dialog.dismiss(); await clicked;
    await page.waitForFunction(() => window.finished === true);
    return { type: dialog.type(), completedBeforeAnswer: beforeAnswer, finished: await page.evaluate(() => window.finished) };
  }, want: { type: 'alert', completedBeforeAnswer: true, finished: true } });
for (const accept of [false, true]) dialogs.push({ name: `beforeunload ${accept ? 'accept leaves' : 'dismiss stays'}`,
  html: `<button id=go onclick="window.onbeforeunload=e=>{e.preventDefault();e.returnValue='leave?'}">Arm</button>`,
  run: async (page, mod, { origin }) => {
    await page.locator('#go').click({ modifiers: mod });
    const ready = page.waitForEvent('dialog'); let completed = false;
    const going = page.goto(origin + '/landed').catch(() => null).then(() => { completed = true; });
    const dialog = await ready, beforeAnswer = completed;
    if (accept) await dialog.accept(); else await dialog.dismiss(); await going;
    return { type: dialog.type(), completedBeforeAnswer: beforeAnswer, landed: new URL(page.url()).pathname === '/landed' };
  }, want: { type: 'beforeunload', completedBeforeAnswer: false, landed: accept } });

const scrolls = [{ name: 'already visible target can remain under sticky header',
  html: `<header style="position:fixed;top:0;left:0;width:100%;height:100px;background:white;z-index:2">Header</header>
    <button id=go style="position:absolute;top:10px;left:10px">Target</button><div style="height:2000px"></div>`,
  run: async (page, mod) => {
    await page.locator('#go').scrollIntoViewIfNeeded();
    // force records the browser hit target; scrollIntoViewIfNeeded does not test occlusion.
    await page.locator('#go').click({ modifiers: mod, force: true });
    return page.locator('#go').evaluate(el => {
      const r = el.getBoundingClientRect(); return { covered: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) !== el, scroll: scrollY };
    });
  }, want: { covered: true, scroll: 0 } }];
scrolls.push({ name: 'offscreen target centers below sticky header',
  html: `<header style="position:fixed;top:0;left:0;width:100%;height:100px;background:white;z-index:2">Header</header>
    <div style="height:1200px"></div><button id=go>Target</button><div style="height:1200px"></div>`,
  run: async (page, mod) => {
    await page.locator('#go').scrollIntoViewIfNeeded(); await page.locator('#go').click({ modifiers: mod });
    return page.locator('#go').evaluate(el => {
      const r = el.getBoundingClientRect(); return { covered: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) !== el, scrolled: scrollY > 0 };
    });
  }, want: { covered: false, scrolled: true } });
scrolls.push({ name: 'scrollIntoView scrolls nested ancestors',
  html: `<div style="height:900px"></div><div id=outer style="height:180px;overflow:auto"><div style="height:600px"></div>
    <div id=inner style="height:120px;overflow:auto"><div style="height:600px"></div><button id=go>Target</button>
    <div style="height:600px"></div></div><div style="height:600px"></div></div><div style="height:900px"></div>`,
  run: async (page, mod) => {
    await page.locator('#go').scrollIntoViewIfNeeded(); await page.locator('#go').click({ modifiers: mod });
    return page.evaluate(() => ({ window: scrollY > 0, outer: outer.scrollTop > 0, inner: inner.scrollTop > 0 }));
  }, want: { window: true, outer: true, inner: true } });
scrolls.push({ name: 'wheel targets inner scroller before ancestor',
  html: `<button id=go>Prepare</button><div id=inner style="height:200px;width:300px;overflow:auto"><div style="height:2000px">Content</div></div>
    <div style="height:2000px"></div>`,
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); const r = await page.locator('#inner').boundingBox();
    await page.mouse.move(r.x + 100, r.y + 100); await page.mouse.wheel(0, 150);
    await page.waitForFunction(() => inner.scrollTop > 0);
    return page.evaluate(() => ({ inner: inner.scrollTop, window: scrollY }));
  }, want: { inner: 150, window: 0 } });

const focuses = [{ name: 'autofocus sets activeElement at load', html: '<input id=x autofocus><button id=go>Click</button>',
  run: async (page, mod) => {
    await page.waitForFunction(() => document.activeElement.id === 'x'); const before = await page.evaluate(() => document.activeElement.id);
    await page.locator('#go').click({ modifiers: mod }); return { before, after: await page.evaluate(() => document.activeElement.id) };
  }, want: { before: 'x', after: 'go' } }];
focuses.push({ name: 'focus trap redirects click focus',
  html: `<input id=inside><button id=go>Outside</button><script>document.addEventListener('focusin',e=>{if(e.target.id==='go')inside.focus()})</script>`,
  run: async (page, mod) => { await page.locator('#go').click({ modifiers: mod }); return { active: await page.evaluate(() => document.activeElement.id) }; },
  want: { active: 'inside' } });
focuses.push({ name: 'inert descendants refuse pointer click', html: '<div inert><button id=go>Inert</button></div>',
  run: async (page, mod) => ({ rejected: await rejected(() => page.locator('#go').click({ modifiers: mod })), active: await page.evaluate(() => document.activeElement.tagName) }),
  want: { rejected: true, active: 'BODY' } });
focuses.push({ name: 'inert descendants ignore programmatic focus', html: '<button id=go>Prepare</button><div inert><input id=x></div>',
  run: async (page, mod) => { await page.locator('#go').click({ modifiers: mod }); await page.locator('#x').focus(); return { active: await page.evaluate(() => document.activeElement.id) }; },
  want: { active: 'go' } });
focuses.push({ name: 'hover dispatches mouseenter without focusing', html: '<button id=go>Prepare</button><button id=x onmouseenter="window.entered=true">Hover</button>',
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); await page.locator('#x').hover();
    return page.evaluate(() => ({ active: document.activeElement.id, entered: window.entered }));
  }, want: { active: 'go', entered: true } });
focuses.push({ name: 'viewport resize changes CSS media match', html: '<button id=go>Prepare</button>',
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); await page.setViewportSize({ width: 390, height: 844 });
    return page.evaluate(() => ({ width: innerWidth, height: innerHeight, mobile: matchMedia('(max-width:400px)').matches }));
  }, want: { width: 390, height: 844, mobile: true } });
focuses.push({ name: 'waitFor visible follows a delayed DOM reveal', html: '<button id=go onclick="setTimeout(()=>x.hidden=false,50)">Reveal</button><div id=x hidden>Visible later</div>',
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); await page.locator('#x').waitFor({ state: 'visible' });
    return { visible: await page.locator('#x').isVisible() };
  }, want: { visible: true } });

const popupState = async (page, context) => {
  const others = context.pages().filter(p => p !== page);
  await Promise.all(others.map(p => p.waitForLoadState('domcontentloaded')));
  return { current: new URL(page.url()).pathname.startsWith('/fixture/') ? 'fixture' : new URL(page.url()).pathname,
    popups: await Promise.all(others.map(async p => ({ path: new URL(p.url()).pathname,
      opener: await p.evaluate(() => Boolean(window.opener)), name: await p.evaluate(() => window.name) }))) };
};
const popupRows = [
  ['window.open blank', "window.handle=window.open('/landed','_blank')", true, ''],
  ['window.open named', "window.handle=window.open('/landed','atlas-child')", true, 'atlas-child'],
  ['window.open noopener', "window.handle=window.open('/landed','_blank','noopener')", false, ''],
  ['window.open noreferrer', "window.handle=window.open('/landed','_blank','noreferrer')", false, ''],
  ['window.open initial about:blank then location', "window.handle=window.open('','_blank');handle.location='/landed'", true, ''],
  ['window.open self', "window.open('/landed','_self')", null, ''],
].map(([name, script, opener, childName]) => ({ name, html: `<button id=go onclick="${script}">Open</button>`,
  run: async (page, mod, { context }) => {
    const ready = opener === null ? page.waitForURL('**/landed') : context.waitForEvent('page');
    await page.locator('#go').click({ modifiers: mod }); await ready;
    if (opener !== null) await context.pages().find(p => p !== page).waitForURL('**/landed');
    return popupState(page, context);
  }, want: { current: opener === null ? '/landed' : 'fixture', popups: opener === null ? [] : [{ path: '/landed', opener, name: childName }] } }));
popupRows.push({ name: 'window.open named target reuses one context', html: `<button id=go onclick="window.open('/landed','atlas-child')">Open</button>`,
  run: async (page, mod, { context }) => {
    const ready = context.waitForEvent('page'); await page.locator('#go').click({ modifiers: mod }); const child = await ready;
    await child.waitForURL('**/landed'); await page.locator('#go').click({ modifiers: mod }); await pause(150);
    return popupState(page, context);
  }, want: { current: 'fixture', popups: [{ path: '/landed', opener: true, name: 'atlas-child' }] } });
popupRows.push({ name: 'named link reuses its target only on plain click', html: '<a id=go href=/landed target=atlas-child>Open</a>',
  run: async (page, mod, { context }) => {
    const ready = context.waitForEvent('page'); await page.locator('#go').click({ modifiers: mod }); const child = await ready;
    await child.waitForURL('**/landed'); await page.locator('#go').click({ modifiers: mod }); await pause(150);
    return popupState(page, context);
  }, want: { current: 'fixture', popups: [{ path: '/landed', opener: true, name: 'atlas-child' }] },
  modified: { current: 'fixture', popups: [{ path: '/landed', opener: false, name: '' }, { path: '/landed', opener: false, name: '' }] } });
for (const [name, attrs, opener, childName] of [
  ['link blank implicit noopener', 'target=_blank', false, ''],
  ['link blank rel opener', 'target=_blank rel=opener', true, ''],
  ['link named', 'target=atlas-child', true, 'atlas-child'],
  ['link named rel noopener', 'target=atlas-child rel=noopener', false, 'atlas-child'],
  ['link blank noreferrer', 'target=_blank rel=noreferrer', false, ''],
]) popupRows.push({ name, html: `<a id=go href=/landed ${attrs}>Open</a>`,
  run: async (page, mod, { context }) => {
    const ready = context.waitForEvent('page'); await page.locator('#go').click({ modifiers: mod });
    const child = await ready; await child.waitForURL('**/landed'); return popupState(page, context);
  }, want: { current: 'fixture', popups: [{ path: '/landed', opener, name: childName }] },
  modified: { current: 'fixture', popups: [{ path: '/landed', opener: false, name: '' }] } });
for (const method of ['get', 'post']) for (const target of ['_self', '_blank', 'atlas-child']) {
  popupRows.push({ name: `form ${method.toUpperCase()} ${target}`, html: `<form action=/landed method=${method} target=${target}>
    <input name=q value=fixture><button id=go>Submit</button></form>`,
    run: async (page, mod, { context }) => {
      const newPage = mod.length || target !== '_self';
      const ready = newPage ? context.waitForEvent('page') : page.waitForURL('**/landed*');
      await page.locator('#go').click({ modifiers: mod }); const child = await ready;
      if (newPage) await child.waitForURL('**/landed*'); return popupState(page, context);
    }, want: { current: target === '_self' ? '/landed' : 'fixture',
      popups: target === '_self' ? [] : [{ path: '/landed', opener: target !== '_blank', name: target === 'atlas-child' ? target : '' }] },
    modified: { current: 'fixture', popups: [{ path: '/landed', opener: false, name: '' }] } });
}
popupRows.push({ name: 'form targets an existing named iframe', html: `<iframe name=atlas-frame src=/initial></iframe>
  <form action=/landed target=atlas-frame><button id=go>Submit</button></form>`,
  run: async (page, mod, { context }) => {
    const frame = page.frames().find(frame => frame.name() === 'atlas-frame');
    await frame.waitForURL('**/initial');
    const ready = mod.length ? context.waitForEvent('page') : frame.waitForURL('**/landed*');
    await page.locator('#go').click({ modifiers: mod }); const child = await ready;
    if (mod.length) await child.waitForURL('**/landed*');
    return { ...await popupState(page, context), frame: new URL(frame.url()).pathname };
  }, want: { current: 'fixture', popups: [], frame: '/landed' },
  modified: { current: 'fixture', popups: [{ path: '/landed', opener: false, name: '' }], frame: '/initial' } });

const navigation = [
  ['pushState keeps document', "history.pushState({n:1},'', '/history')", '/history', true],
  ['replaceState keeps document', "history.replaceState({n:1},'', '/history')", '/history', true],
  ['hash keeps document', "location.hash='section'", null, true],
  ['meta refresh creates document', "document.head.insertAdjacentHTML('beforeend','<meta http-equiv=refresh content=\"0;url=/landed\">')", '/landed', false],
].map(([name, script, path, same]) => ({ name,
  html: `<script>window.marker='original'</script><button id=go>Navigate</button><script>go.onclick=()=>{${script}}</script>`,
  run: async (page, mod, { path: fixturePath }) => {
    await page.locator('#go').click({ modifiers: mod });
    await page.waitForURL(url => path ? url.pathname === path : url.hash === '#section');
    return { path: new URL(page.url()).pathname === fixturePath ? 'fixture' : new URL(page.url()).pathname,
      hash: new URL(page.url()).hash, sameDocument: await page.evaluate(() => window.marker === 'original') };
  }, want: { path: path ?? 'fixture', hash: path ? '' : '#section', sameDocument: same } }));
navigation.push({ name: 'redirect chain commits final document', html: '<a id=go href=/redirect/2>Redirect</a>',
  run: async (page, mod, { context }) => {
    const chain = []; context.on('request', req => { if (req.isNavigationRequest()) chain.push(new URL(req.url()).pathname); });
    const ready = mod.length ? context.waitForEvent('page') : page.waitForURL('**/landed');
    await page.locator('#go').click({ modifiers: mod }); const child = await ready;
    if (mod.length) await child.waitForURL('**/landed');
    return { chain, currentLanded: new URL(page.url()).pathname === '/landed', pages: context.pages().length };
  }, want: { chain: ['/redirect/2', '/redirect/1', '/redirect/0', '/landed'], currentLanded: true, pages: 1 },
  modified: { chain: ['/redirect/2', '/redirect/1', '/redirect/0', '/landed'], currentLanded: false, pages: 2 } });
navigation.push({ name: 'same-document back and forward preserve state', html: `<button id=go onclick="window.marker='original';history.pushState({},'', '/one');history.pushState({},'', '/two')">History</button>`,
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); await page.goBack(); const back = new URL(page.url()).pathname;
    await page.goForward(); return { back, forward: new URL(page.url()).pathname, marker: await page.evaluate(() => window.marker) };
  }, want: { back: '/one', forward: '/two', marker: 'original' } });
navigation.push({ name: 'reload creates a new document', html: '<button id=go onclick="window.marker=\'old\'">Set</button>',
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); await page.reload(); return { oldDocument: await page.evaluate(() => window.marker === 'old') };
  }, want: { oldDocument: false } });

test('AT1 lifecycle behavior atlas on pinned Chromium 1248', { skip, timeout: 240000 }, t =>
  atlas(t, [['dialogs', dialogs], ['scroll', scrolls], ['focus', focuses], ['popups', popupRows], ['navigation', navigation]]));
