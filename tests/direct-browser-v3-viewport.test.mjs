import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { browserTools, validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';

// A page that tracks its size the way a browser does: Runtime.evaluate reads it, setViewportSize changes it.
function sizedPage(initial = { width: 1280, height: 720 }, { readable = true } = {}) {
  const page = new EventEmitter(), calls = []; let size = { ...initial };
  page.url = () => 'https://example.invalid/';
  page.mainFrame = () => page;
  page.evaluate = async () => {};
  page.context = () => ({ newCDPSession: async () => ({
    send: async (method, params) => {
      calls.push(method);
      assert.equal(method, 'Runtime.evaluate');
      if (!readable) throw Error('no session');
      assert.match(params.expression, /innerWidth/);
      return { result: { value: [size.width, size.height] } };
    },
    detach: async () => { calls.push('detach'); },
  }) });
  page.setViewportSize = async next => { calls.push(['setViewportSize', next]); size = { ...next }; };
  return { page, calls, size: () => size };
}
function runner(page) {
  let time = 0;
  const run = createActionRunner({ check: async () => ({ kind: 'allow' }), now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  return steps => run({ page, state: { snapshotNo: 1, submitUnconfirmed: false } }, steps, {});
}

test('a viewport step reports the new and the old size and says how to restore', async () => {
  const { page, size } = sizedPage();
  const result = await runner(page)([{ do: 'viewport', width: 390, height: 844 }]);
  assert.deepEqual(size(), { width: 390, height: 844 });
  assert.equal(result.lines[0], process.env.SLEIGHT_MT === '0'
    ? '1 viewport: viewport 390x844 (was 1280x720); a viewport step with no size restores 1280x720'
    : '1 viewport: viewport 390x844 (was 1280x720; a viewport step with no size restores it). [offscreen] means outside this viewport; [partly offscreen] means cut off by it.');
});

test('a viewport step with no size gives the original size back, once', async () => {
  const { page, size } = sizedPage({ width: 1000, height: 800 });
  const run = runner(page);
  await run([{ do: 'viewport', width: 390, height: 844 }]);
  const restored = await run([{ do: 'viewport' }]);
  assert.deepEqual(size(), { width: 1000, height: 800 });
  assert.match(restored.lines[0], /viewport restored to 1000x800$/);
  const again = await run([{ do: 'viewport' }]);
  assert.match(again.lines[0], /viewport unchanged: no size was set on this tab$/);
  assert.deepEqual(size(), { width: 1000, height: 800 });
});

test('several resizes still restore the size the tab had before the first one', async () => {
  const { page, size } = sizedPage({ width: 1000, height: 800 });
  const run = runner(page);
  await run([{ do: 'viewport', width: 390, height: 844 }]);
  const second = await run([{ do: 'viewport', width: 768, height: 1024 }]);
  assert.match(second.lines[0], process.env.SLEIGHT_MT === '0' ? /viewport 768x1024 \(was 390x844\); a viewport step with no size restores 1000x800$/ : /viewport 768x1024 \(was 390x844; a viewport step with no size restores it\)\. \[offscreen\] means outside this viewport; \[partly offscreen\] means cut off by it\.$/);
  await run([{ do: 'viewport' }]);
  assert.deepEqual(size(), { width: 1000, height: 800 });
});

test('two tabs keep their own original sizes', async () => {
  const a = sizedPage({ width: 1000, height: 800 }), b = sizedPage({ width: 1440, height: 900 });
  await runner(a.page)([{ do: 'viewport', width: 390, height: 844 }]);
  await runner(b.page)([{ do: 'viewport', width: 390, height: 844 }]);
  await runner(a.page)([{ do: 'viewport' }]); await runner(b.page)([{ do: 'viewport' }]);
  assert.deepEqual([a.size(), b.size()], [{ width: 1000, height: 800 }, { width: 1440, height: 900 }]);
});

test('an unreadable page size still sets the viewport and says the old size is unknown', async () => {
  const { page, size } = sizedPage({ width: 1000, height: 800 }, { readable: false });
  const run = runner(page);
  const result = await run([{ do: 'viewport', width: 390, height: 844 }]);
  assert.deepEqual(size(), { width: 390, height: 844 });
  assert.match(result.lines[0], /viewport 390x844; previous size unknown$/);
  assert.match((await run([{ do: 'viewport' }])).lines[0], /unchanged/);
});

test('half a size or an out-of-range size is refused before any input', async () => {
  const { page, calls } = sizedPage();
  for (const step of [{ do: 'viewport', width: 390 }, { do: 'viewport', height: 844 }, { do: 'viewport', width: 50, height: 844 },
    { do: 'viewport', width: 390, height: 20000 }, { do: 'viewport', width: 390.5, height: 844 }]) {
    await assert.rejects(runner(page)([step]), /width and height between 100 and 10000, or neither to restore/);
  }
  assert.deepEqual(calls, []);
});

test('the tool boundary takes both sizes or neither, and the descriptions name the viewport step and the markers', () => {
  const call = step => validateToolCall({ name: 'browser_act', arguments: { tab: 'tabc', steps: [step] } }, 'bbench');
  call({ do: 'viewport', width: 390, height: 844 });
  call({ do: 'viewport' });
  assert.throws(() => call({ do: 'viewport', width: 390 }), /width and height, or neither/);
  assert.throws(() => call({ do: 'viewport', height: 844 }), /width and height, or neither/);
  const text = Object.fromEntries(browserTools('bbench').map(tool => [tool.name, tool.description]));
  assert.match(text.browser_act, /viewport with width and height resizes and reports the old size; with neither it restores that size/);
  assert.match(text.browser_read, /Refs outside the viewport carry \[offscreen\] or \[partly offscreen\]/);
});


import { withMT } from './fixtures/mt-env.mjs';
for (const mode of [undefined, '0']) test(`MT6 viewport guidance preserves restore behavior, switch=${mode}`, async () => withMT(mode, async () => {
  const { page, size } = sizedPage(), run = runner(page);
  const result = await run([{ do: 'viewport', width: 390, height: 844 }]);
  assert.equal(result.lines[0], mode === '0'
    ? '1 viewport: viewport 390x844 (was 1280x720); a viewport step with no size restores 1280x720'
    : '1 viewport: viewport 390x844 (was 1280x720; a viewport step with no size restores it). [offscreen] means outside this viewport; [partly offscreen] means cut off by it.');
  await run([{ do: 'viewport' }]); assert.deepEqual(size(), { width: 1280, height: 720 });
}));
