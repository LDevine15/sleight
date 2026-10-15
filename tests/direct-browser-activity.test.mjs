import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackPage, observeActivity, openRequestCount } from '../plugins/sleight/lib/direct-browser/activity.mjs';

// The refund watch (activity.mjs) counts every request started on the browser context, every WebSocket and frame sent, every new
// page and worker, and proves at settle time that no worker or other-origin frame sits outside it.
function fake({ frames = ['http://shop.test/checkout'], workers = [], targets = [], pages = [] } = {}) {
  const context = new EventEmitter(), page = new EventEmitter();
  Object.assign(page, { isClosed: () => false, workers: () => workers, mainFrame: () => ({ url: () => frames[0] }), frames: () => frames.map(url => ({ url: () => url })), context: () => context });
  context.pages = () => [page, ...pages];
  trackPage(page, { targets: async () => ({ targetInfos: targets }) });
  return { context, page };
}
// A second page of the same context (an owned tab), tracked the way the registry tracks an adopted page.
function sibling(first, url = 'http://shop.test/other') {
  const page = new EventEmitter();
  Object.assign(page, { isClosed: () => false, workers: () => [], mainFrame: () => ({ url: () => url }), frames: () => [{ url: () => url }], context: () => first.context });
  const was = first.context.pages;
  first.context.pages = () => [...was(), page];
  trackPage(page, { targets: async () => ({ targetInfos: [] }) });
  return page;
}
const socket = () => new EventEmitter();

test('a quiet page stays quiet and verifies', async () => {
  const { page } = fake(), watch = observeActivity(page);
  assert.equal(watch.observable, true);
  assert.equal(await watch.verify(), true);
  assert.equal(watch.quiet(), true);
  watch.stop();
  assert.equal(watch.quiet(), true);
});
test('every kind of request, failed ones included, ends the quiet', () => {
  for (const event of ['request', 'requestfailed', 'requestfinished', 'serviceworker']) {
    const { context, page } = fake(), watch = observeActivity(page);
    context.emit(event, {});
    assert.equal(watch.quiet(), false, event);
  }
});
test('a WebSocket created, a frame sent on a socket opened before the watch, a new page and a worker all end the quiet', () => {
  const early = fake(), old = socket(); early.page.emit('websocket', old);
  const watch = observeActivity(early.page);
  assert.equal(watch.quiet(), true);
  old.emit('framesent', {});
  assert.equal(watch.quiet(), false);
  const created = fake(), a = observeActivity(created.page);
  created.page.emit('websocket', socket());
  assert.equal(a.quiet(), false);
  const popup = fake(), b = observeActivity(popup.page);
  popup.context.emit('page', fake().page);
  assert.equal(b.quiet(), false);
  const worker = fake(), c = observeActivity(worker.page);
  worker.page.emit('worker', {});
  assert.equal(c.quiet(), false);
});
test('activity after stop() is not counted, activity before it stays counted', () => {
  const { context, page } = fake(), watch = observeActivity(page);
  context.emit('request', {});
  watch.stop();
  context.emit('request', {});
  assert.equal(watch.quiet(), false);
  const clean = fake(), other = observeActivity(clean.page);
  other.stop(); clean.context.emit('request', {});
  assert.equal(other.quiet(), true);
});
test('a page that was never tracked, or a context without events, cannot be observed', () => {
  const { page } = fake();
  const stranger = new EventEmitter(); Object.assign(stranger, { context: () => new EventEmitter() });
  assert.equal(observeActivity(stranger).observable, false);
  const bare = Object.assign(new EventEmitter(), { context: () => ({}) }); trackPage(bare);
  assert.equal(observeActivity(bare).observable, false);
  assert.equal(observeActivity(page).observable, true);
});
test('verify refuses a dedicated worker, an other-origin frame, a service or shared worker of the page origin, and an unlistable browser', async () => {
  const proof = async options => observeActivity(fake(options).page).verify();
  assert.equal(await proof({ workers: [{}] }), false);
  assert.equal(await proof({ frames: ['http://shop.test/checkout', 'https://pay.example/frame'] }), false);
  assert.equal(await proof({ targets: [{ type: 'service_worker', url: 'http://shop.test/sw.js' }] }), false);
  assert.equal(await proof({ targets: [{ type: 'shared_worker', url: 'http://shop.test/w.js' }] }), false);
  assert.equal(await proof({ targets: [{ type: 'shared_worker', url: 'blob:http://shop.test/1234' }] }), false);
  assert.equal(await proof({ targets: [{ type: 'shared_worker', url: 'data:text/javascript,1' }] }), false);
  const silent = fake(), page = silent.page; page.removeAllListeners();
  const noList = Object.assign(new EventEmitter(), { isClosed: () => false, workers: () => [], mainFrame: () => ({ url: () => 'http://shop.test/' }), frames: () => [], context: () => silent.context });
  trackPage(noList);
  assert.equal(await observeActivity(noList).verify(), false);
});
test('verify accepts same-origin and blank frames and workers of other origins', async () => {
  const ok = fake({ frames: ['http://shop.test/checkout', 'http://shop.test/frame', 'about:blank', 'about:srcdoc'],
    targets: [{ type: 'service_worker', url: 'http://elsewhere.test/sw.js' }, { type: 'page', url: 'http://shop.test/checkout' }] });
  assert.equal(await observeActivity(ok.page).verify(), true);
});

test('F1: the watch detaches at its lifetime cap and then counts as not quiet; stop() takes every listener off', async () => {
  const { context, page } = fake(), before = ['request', 'requestfailed', 'requestfinished', 'serviceworker', 'weberror', 'page'].map(e => context.listenerCount(e));
  const capped = observeActivity(page, { maxMs: 20 });
  assert.equal(capped.quiet(), true);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(capped.quiet(), false);
  assert.deepEqual(['request', 'requestfailed', 'requestfinished', 'serviceworker', 'weberror', 'page'].map(e => context.listenerCount(e)), before);
  assert.equal(page.listenerCount('websocket'), 1);
  const quick = observeActivity(page); quick.stop();
  assert.equal(quick.quiet(), true);
  assert.equal(context.listenerCount('request'), before[0]);
});
test('F2: a page of the same site that the context does not hold ends the refund; other sites and held pages do not', async () => {
  const own = { type: 'page', url: 'http://shop.test/checkout' };
  assert.equal(await observeActivity(fake({ targets: [own] }).page).verify(), true);
  assert.equal(await observeActivity(fake({ targets: [own, { type: 'page', url: 'http://shop.test/orders' }] }).page).verify(), false);
  assert.equal(await observeActivity(fake({ targets: [own, { type: 'page', url: 'http://www.shop.test/' }] }).page).verify(), false);
  assert.equal(await observeActivity(fake({ targets: [own, { type: 'page', url: 'http://news.test/' }, { type: 'page', url: 'about:blank' }] }).page).verify(), true);
  const two = fake({ targets: [own, { type: 'page', url: 'http://shop.test/other' }] }); sibling(two);
  assert.equal(await observeActivity(two.page).verify(), true);
});
test('F3: a WebSocket frame sent by another page of the context ends the quiet; so does a page that was never tracked', async () => {
  const first = fake(), old = socket(), other = sibling(first); other.emit('websocket', old);
  const watch = observeActivity(first.page);
  assert.equal(watch.quiet(), true);
  old.emit('framesent', {});
  assert.equal(watch.quiet(), false);
  const stray = fake(), extra = new EventEmitter();
  Object.assign(extra, { context: () => stray.context });
  const was = stray.context.pages; stray.context.pages = () => [...was(), extra];
  assert.equal(await observeActivity(stray.page).verify(), false);
});
test('F4: a request still open when the watch starts ends the refund, one that finished before does not', async () => {
  const first = fake(), request = {};
  first.context.emit('request', request);
  const open = observeActivity(first.page);
  assert.equal(await open.verify(), false);
  assert.equal(open.quiet(), false);
  first.context.emit('requestfinished', request);
  const done = observeActivity(first.page);
  assert.equal(await done.verify(), true);
  assert.equal(done.quiet(), true);
  const failed = fake(), gone = {}; failed.context.emit('request', gone); failed.context.emit('requestfailed', gone);
  assert.equal(await observeActivity(failed.page).verify(), true);
});
test('F4: more open requests than the tracker keeps still end the refund until they drain; none is evicted while open', async () => {
  const first = fake(), long = {}, many = Array.from({ length: 600 }, () => ({}));
  first.context.emit('request', long);
  for (const request of many) first.context.emit('request', request);
  assert.equal(await observeActivity(first.page).verify(), false);
  first.context.emit('requestfinished', many[0]); // an unkept or kept one finishing does not clear the long-lived one
  assert.equal(await observeActivity(first.page).verify(), false);
  for (const request of many) first.context.emit('requestfinished', request);
  assert.equal(await observeActivity(first.page).verify(), false, 'the first request is still open');
  first.context.emit('requestfailed', long);
  assert.equal(await observeActivity(first.page).verify(), true);
  const flood = fake(), tail = {};
  for (let n = 0; n < 513; n++) flood.context.emit('request', {});
  flood.context.emit('request', tail);
  assert.equal(await observeActivity(flood.page).verify(), false);
});

// F-B (round 8). Playwright never reports the end of a request that is open when its page closes or its frame loads a new document.
function frameFor(page, url = 'http://shop.test/checkout', { emitter = true } = {}) {
  const frame = new EventEmitter();
  Object.assign(frame, { url: () => url, page: () => page });
  if (emitter) frame._eventEmitter = new EventEmitter();
  return frame;
}
function tab(url = 'http://shop.test/checkout', options) {
  const first = fake({ frames: [url] }), frame = frameFor(first.page, url, options);
  first.page.frames = () => [frame]; first.page.mainFrame = () => frame;
  first.page.emit('frameattached', frame); // the frame the tracker has not seen yet
  const navigate = (to, { newDocument } = {}) => {
    frame.url = () => to;
    if (newDocument !== undefined && frame._eventEmitter) frame._eventEmitter.emit('navigated', newDocument ? { url: to, newDocument: {} } : { url: to });
    first.page.emit('framenavigated', frame);
  };
  const request = (extra = {}) => { const r = { frame: () => frame, isNavigationRequest: () => false, ...extra }; first.context.emit('request', r); return r; };
  return { ...first, frame, navigate, request, count: () => openRequestCount(first.page) };
}
test('F-B: a closed page and a detached frame drop what they had open; another frame\'s requests stay', () => {
  const t = tab(); t.request(); t.request();
  assert.equal(t.count(), 2);
  const other = frameFor(t.page); t.page.emit('frameattached', other);
  const kept = { frame: () => other, isNavigationRequest: () => false }; t.context.emit('request', kept);
  t.page.emit('framedetached', other);
  assert.equal(t.count(), 2);
  t.page.emit('close');
  assert.equal(t.count(), 0);
});
test('F-B: a new document drops the old document\'s requests but not its own navigation request; a same-document change drops nothing', () => {
  for (const emitter of [true, false]) {
    const t = tab('http://shop.test/cart', { emitter });
    const old = t.request(), second = t.request();
    t.navigate('http://shop.test/cart#x', emitter ? { newDocument: false } : {});
    assert.equal(t.count(), 2, 'a hash change (emitter ' + emitter + ')');
    t.navigate('http://shop.test/pushed', emitter ? { newDocument: false } : {});
    assert.equal(t.count(), 2, 'pushState (emitter ' + emitter + ')');
    const nav = t.request({ isNavigationRequest: () => true });
    t.navigate('http://shop.test/checkout', emitter ? { newDocument: true } : {});
    assert.equal(t.count(), 1, 'the navigation request is the only one left (emitter ' + emitter + ')');
    t.context.emit('requestfinished', nav);
    assert.equal(t.count(), 0);
    assert.equal(old !== second, true);
  }
});
test('F-B: a navigation request that ends without a commit (204, download) does not turn a later pushState into a new document', () => {
  const t = tab(), early = t.request(), nav = t.request({ isNavigationRequest: () => true });
  t.context.emit('requestfinished', nav);
  t.navigate('http://shop.test/pushed', { newDocument: false });
  assert.equal(t.count(), 1);
  const bare = tab('http://shop.test/a', { emitter: false }), open = bare.request(), n2 = bare.request({ isNavigationRequest: () => true });
  bare.context.emit('requestfailed', n2);
  bare.navigate('http://shop.test/pushed');
  assert.equal(bare.count(), 1, 'without the emitter, the same guess holds');
  assert.equal(early !== open, true);
});
test('F-B: a document with no request at all (about:blank) or another origin drops the old requests; the same origin does not guess', () => {
  const t = tab(); t.request(); t.request();
  t.navigate('about:blank', { newDocument: true });
  assert.equal(t.count(), 0);
  const bare = tab('http://shop.test/a', { emitter: false }); bare.request();
  bare.navigate('http://shop.test/b');
  assert.equal(bare.count(), 1);
  bare.navigate('about:blank');
  assert.equal(bare.count(), 0);
});
test('F-B: past the cap the unkept requests of a frame drop with it; a watch that was running when a request opened keeps counting it', async () => {
  const t = tab(), running = observeActivity(t.page);
  for (let n = 0; n < 600; n++) t.request();
  assert.equal(t.count(), 600);
  assert.equal(running.quiet(), false);
  t.navigate('http://shop.test/next', { newDocument: true });
  assert.equal(t.count(), 0);
  assert.equal(running.quiet(), false, 'the running watch still saw them open');
  running.stop();
  const fresh = observeActivity(t.page);
  assert.equal(await fresh.verify(), true);
  assert.equal(fresh.quiet(), true);
});

// F-C (round 8). A dedicated worker of any page the context holds, or any worker target the watch cannot see, ends the refund.
test('F-C: a dedicated worker of another held page, or a worker target of that page\'s origin, ends the refund', async () => {
  const first = fake({ targets: [{ type: 'page', url: 'http://shop.test/checkout' }, { type: 'page', url: 'https://help.example/' }] });
  const popup = sibling(first, 'https://help.example/');
  assert.equal(await observeActivity(first.page).verify(), true, 'a held popup with nothing running is fine');
  popup.workers = () => [{}];
  assert.equal(await observeActivity(first.page).verify(), false);
  const viaTarget = fake({ targets: [{ type: 'page', url: 'http://shop.test/checkout' }, { type: 'page', url: 'https://help.example/' }, { type: 'worker', url: 'blob:https://help.example/1234' }] });
  sibling(viaTarget, 'https://help.example/');
  assert.equal(await observeActivity(viaTarget.page).verify(), false);
  const unrelated = fake({ targets: [{ type: 'worker', url: 'https://elsewhere.test/w.js' }] });
  assert.equal(await observeActivity(unrelated.page).verify(), true, 'a worker of a site no held page shows is not this tab\'s');
});
