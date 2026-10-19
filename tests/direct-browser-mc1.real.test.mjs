import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { backgroundClick, changedMidClick, changedAfterPress } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { fixture, skip } from './fixtures/cr4-real.mjs';

const html = readFileSync(new URL('./fixtures/direct-browser-mc1.html', import.meta.url), 'utf8');

test('MC1 real clipped radio accepts its own label press', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, html), locator = await f.entry.page.locator('#shipping').elementHandle();
  try {
    await backgroundClick(f.entry, locator, options => locator.click({ ...options, force: true }));
    assert.equal(await locator.isChecked(), true);
    assert.ok((await f.entry.page.evaluate(() => received)).length > 0);
  } finally { await locator.dispose(); }
});

for (const kind of ['rerender', 'gone', 'replacement', 'covered', 'part received'])
  test('MC1 real click race: ' + kind, { skip, timeout: 60000 }, async t => {
    const f = await fixture(t, html), page = f.entry.page;
    const locator = await page.locator('#move').elementHandle();
    let attempts = 0, retries = 0;
    try {
      const action = backgroundClick(f.entry, locator, async options => {
        attempts++;
        if (attempts === 1) {
          const box = await locator.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
          if (kind === 'part received') {
            await page.mouse.move(x, y);
            await page.mouse.down();
          }
          await locator.evaluate((el, kind) => {
            if (kind === 'gone') el.remove();
            else if (kind === 'replacement') el.replaceWith(el.cloneNode(true));
            else if (kind === 'covered') {
              const cover = document.createElement('div');
              cover.style.cssText = 'position:fixed;inset:0;z-index:10'; document.body.append(cover);
            } else {
              el.setAttribute('aria-label', 'Rendering');
              setTimeout(() => el.removeAttribute('aria-label'), 80);
            }
          }, kind);
          // Send at the stale point even for a detached node, so the shield must veto before page listeners.
          await page.mouse.click(x, y);
        } else await locator.click(options);
      }, { onRetry: () => { retries++; } });
      if (kind === 'rerender') {
        await action; assert.equal(attempts, 2); assert.equal(retries, 1);
      } else {
        await assert.rejects(action, { message: kind === 'part received' ? changedAfterPress : changedMidClick });
        assert.equal(attempts, 1); assert.equal(retries, 0);
      }
      if (kind !== 'part received' && kind !== 'rerender') assert.deepEqual(await page.evaluate(() => received), []);
    } finally { await page.mouse.up(); await locator.dispose(); }
  });
