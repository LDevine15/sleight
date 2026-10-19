import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClick, changedMidClick, changedAfterPress, hookOpen, hookProof } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { mc1Fixture } from './fixtures/direct-browser-mc1-fixture.mjs';

function input(f, target = f.radio) {
  const delivered = [];
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const event = f.send(type, target);
    if (!event.prevented) delivered.push(type);
  }
  return delivered;
}

test('MC1 recorded e44 shape: a hidden radio under its own label receives the label press and forwarded click', async () => {
  const f = mc1Fixture();
  f.run('document.hit = fixture.label');
  let delivered;
  await backgroundClick(f.entry, f.locator, async () => {
    delivered = input(f, f.label);
    delivered.push(...input(f));
  });
  assert.equal(delivered.length, 10);
});

test('MC1=0 preserves the exact old e44 refusal and sends only one attempt', async t => {
  const saved = process.env.SLEIGHT_MC1; process.env.SLEIGHT_MC1 = '0';
  t.after(() => { if (saved === undefined) delete process.env.SLEIGHT_MC1; else process.env.SLEIGHT_MC1 = saved; });
  const f = mc1Fixture(); let attempts = 0;
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {
    attempts++; assert.deepEqual(input(f, f.label), []);
  }), { message: changedMidClick });
  assert.equal(attempts, 1);
});

test('MC1 re-render during the click settles the same node and retries once within the step', async () => {
  const f = mc1Fixture(); let attempts = 0, retries = 0, received = 0;
  await backgroundClick(f.entry, f.locator, async () => {
    attempts++;
    if (attempts === 1) {
      f.radio.attrs.value = 'rendering'; f.mutate();
      received += input(f).length;
      setTimeout(() => { f.radio.attrs.value = 'overnight'; f.mutate(); }, 20);
    } else received += input(f).length;
    return 'sent';
  }, { onRetry: () => { retries++; } });
  assert.deepEqual({ attempts, retries, received }, { attempts: 2, retries: 1, received: 5 });
});

test('MC1 a moved target retries at its new clear location after cancelling the stale press', async () => {
  const f = mc1Fixture(); let attempts = 0, received = 0;
  await backgroundClick(f.entry, f.locator, async () => {
    attempts++;
    if (attempts === 1) {
      f.radio.box.x += 40; f.radio.box.left += 40; f.radio.box.right += 40;
      assert.deepEqual(input(f, f.other), []);
    } else received += input(f).length;
  });
  assert.equal(attempts, 2); assert.equal(received, 5);
});

test('MC1 waits for transient label content to return to the original seal', async () => {
  const f = mc1Fixture(), original = f.label.text; let attempts = 0;
  await backgroundClick(f.entry, f.locator, async () => {
    attempts++;
    if (attempts === 1) {
      f.label.text = 'Updating'; f.radio.attrs.value = 'rendering'; input(f);
      setTimeout(() => { f.label.text = original; f.radio.attrs.value = 'overnight'; f.mutate(); }, 20);
    } else assert.equal(input(f).length, 5);
  });
  assert.equal(attempts, 2);
});

test('MC1 a cover that disappears after the veto still refuses', async () => {
  const f = mc1Fixture(); let attempts = 0;
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {
    attempts++; f.run('document.hit = fixture.other'); input(f, f.other);
    f.run('document.hit = fixture.radio');
  }), { message: changedMidClick });
  assert.equal(attempts, 1);
});

for (const kind of ['gone', 'replacement', 'covered', 'hidden', 'changed identity', 'never quiet', 'part received', 'unknown dispatch'])
  test('MC1 refuses without retry: ' + kind, async () => {
    const f = mc1Fixture(); let attempts = 0, interval;
    try {
      await assert.rejects(backgroundClick(f.entry, f.locator, async () => {
        attempts++;
        if (kind === 'part received') { assert.equal(f.send('pointerdown', f.radio).prevented, undefined); }
        if (kind === 'unknown dispatch') throw Error('dispatch uncertain');
        f.radio.attrs.value = 'rendering'; f.mutate();
        if (kind === 'gone' || kind === 'replacement') f.radio.live = false;
        if (kind === 'replacement') f.run('document.hit = new HTMLInputElement({ type: "radio", value: "overnight" }, fixture.label)');
        if (kind === 'covered') f.run('document.hit = fixture.other');
        if (kind === 'hidden') f.radio.hidden = true;
        if (kind === 'never quiet') interval = setInterval(() => f.mutate(), 10);
        input(f);
        if (kind !== 'changed identity') setTimeout(() => { f.radio.attrs.value = 'overnight'; f.mutate(); }, 10);
      }), kind === 'unknown dispatch' ? /dispatch uncertain/ : { message: kind === 'part received' ? changedAfterPress : changedMidClick });
      assert.equal(attempts, 1);
    } finally { clearInterval(interval); }
  });

test('MC1 stops after a second veto and reports the attempted retry', async () => {
  const f = mc1Fixture(); let attempts = 0;
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {
    attempts++; f.radio.attrs.value = 'rendering'; input(f);
    setTimeout(() => { f.radio.attrs.value = 'overnight'; f.mutate(); }, 10);
  }), /after one settled click retry/);
  assert.equal(attempts, 2);
});

for (const kind of ['reassigned label', 'nested button']) test('MC1 own-label route refuses ' + kind, async () => {
  const f = mc1Fixture();
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {
    if (kind === 'reassigned label') f.label.target = f.other;
    const target = kind === 'nested button' ? f.run('new HTMLButtonElement({type: "button"}, fixture.label)') : f.label;
    assert.deepEqual(input(f, target), []);
  }), { message: changedMidClick });
});

test('MC1 does not trust an unsigned retry answer', async () => {
  const f = mc1Fixture(), evaluate = f.locator.evaluate; let attempts = 0;
  f.locator.evaluate = (fn, arg) => arg?.proof && /\.retry\(/.test(String(fn)) ? 't' : evaluate(fn, arg);
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {
    attempts++; f.radio.attrs.value = 'changed'; input(f); f.radio.attrs.value = 'overnight';
  }), { message: changedMidClick });
  assert.equal(attempts, 1);
});

test('MC1 recovery disabled for payment/submit callers and a finished token', async () => {
  const f = mc1Fixture(); let attempts = 0;
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {
    attempts++; f.radio.attrs.value = 'changed'; input(f); f.radio.attrs.value = 'overnight';
  }, { recover: false }), { message: changedMidClick });
  assert.equal(attempts, 1);
  const proof = hookProof(f.entry.hook, 'retry');
  assert.equal(hookOpen(f.entry.hook, await f.locator.evaluate((el, { key, proof }) => window[key].retry(proof, el, 'finished'), { key: f.entry.hook.key, proof })), false);
});

test('MC1 keeps the part-received message unchanged if the retry delivers a press before a later veto', async () => {
  const f = mc1Fixture(); let attempts = 0;
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {
    attempts++;
    if (attempts === 2) f.send('pointerdown', f.radio);
    f.radio.attrs.value = 'rendering'; input(f);
    setTimeout(() => { f.radio.attrs.value = 'overnight'; f.mutate(); }, 10);
  }), { message: changedAfterPress });
  assert.equal(attempts, 2);
});

test('MC1 pins one node across the retry and disposes the owned handle', async () => {
  const f = mc1Fixture(); let acquisitions = 0, disposals = 0, attempts = 0;
  const handle = { ...f.locator, dispose: async () => { disposals++; } };
  const locator = { elementHandle: async () => { acquisitions++; return handle; } };
  const result = await backgroundClick(f.entry, locator, async () => {
    attempts++;
    if (attempts === 1) {
      f.radio.attrs.value = 'rendering'; input(f);
      setTimeout(() => { f.radio.attrs.value = 'overnight'; f.mutate(); }, 10);
    } else input(f);
    return 'sent';
  });
  assert.deepEqual({ result, acquisitions, disposals, attempts }, { result: 'sent', acquisitions: 1, disposals: 1, attempts: 2 });
});
