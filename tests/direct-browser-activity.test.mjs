import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { trackPage, observeActivity } from '../plugins/sleight/lib/direct-browser/activity.mjs';

// The refund watch (activity.mjs) counts every request started on the browser context, every WebSocket and frame sent, every new
// page and worker, and proves at settle time that no worker or other-origin frame sits outside it.
function fake({ frames = ['http://shop.test/checkout'], workers = [], targets = [], pages = [] } = {}) {
  const context = new EventEmitter(), page = new EventEmitter();
  Object.assign(page, { isClosed: () => false, workers: () => workers, mainFrame: () => ({ url: () => frames[0] }), frames: () => frames.map(url => ({ url: () => url })), context: () => context });
  context.pages = () => [page, ...pages];
  trackPage(page, { targets: async () => ({ targetInfos: targets }) });
  return { context, page };
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
