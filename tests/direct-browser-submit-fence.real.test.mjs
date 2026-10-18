// The submit fence clears from the act's own observation: settling and delivery use the fence's start as one clock origin.
// Production trusted context, background click, action runner and dispatcher against a headless page (SLEIGHT_LIVE_DOM_TEST=1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { check, inspectElement, deliverSnapshot, beginSubmit, captureSnapshot } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';

const page = (delay = 0) => `<form onsubmit="event.preventDefault();setTimeout(()=>document.querySelector('dialog').showModal(),${delay})">
  <label>Name<input id="n"></label><button>Save</button></form>
  <dialog><p>Save these settings?</p><button type="button" onclick="window.saved=(window.saved||0)+1;this.parentElement.close()">Save settings</button></dialog>`;

// prepareMs delays the click callback, as the preparation before a real background click does (the gate runs inside it).
async function setup(t, html, prepareMs = 0) {
  const f = await fixture(t, html);
  const binding = createV3TurnBinding({ source: 'user', session: 'fence', turn: 'fixture', id: 'request', text: 'Fill the name and save the settings.' }, () => true);
  const ctx = createV3Context({ binding, browser: 'bfixture' }); t.after(() => ctx.dispose());
  const slowClick = (tab, locator, click, options) =>
    backgroundClick(tab, locator, async (...args) => { await new Promise(resolve => setTimeout(resolve, prepareMs)); return click(...args); }, options);
  const runSteps = createActionRunner({ check, snapshot, backgroundClick: slowClick });
  const fillFields = createFillFields({ check, runSteps, inspectElement });
  const dispatch = createToolDispatcher({ pages: f.registry, snapshot, runSteps, fillFields, ctx,
    deliverSnapshot: (state, capture) => { acknowledgeSnapshot(capture.page, capture.number); return deliverSnapshot(state, capture); } });
  const call = async (name, args) => {
    const result = await dispatch.call({ name, arguments: { tab: f.entry.tab, ...args } });
    dispatch.delivered(result); assert.equal(result.isError, false, result.text); return result.text;
  };
  const read = await call('browser_read', {});
  const refIn = (text, name) => /\[ref=(\w+)\]/.exec(text.split('\n').find(line => line.includes('"' + name + '"') && line.includes('[ref=')) ?? '')?.[1];
  return { ...f, call, ref: name => refIn(read, name), refIn };
}

test('submit fence: Save sent alone clears from its own observation, and the dialog button sent alone is not refused', { skip, timeout: 60000 }, async t => {
  for (const prepareMs of [0, 400]) {
    const f = await setup(t, page(), prepareMs);
    const started = Date.now();
    const saved = await f.call('browser_act', { steps: [{ do: 'click', ref: f.ref('Save') }], observe: 'full' });
    assert.match(saved, /the page answered with a dialog or panel \(below\) and no request has started/);
    assert.doesNotMatch(saved, /submit unconfirmed/);
    assert.equal(f.entry.state.submitUnconfirmed, false, `fence still set after the act's own observation (prepare ${prepareMs} ms): ${saved}`);
    assert.ok(Date.now() - started >= 1000, 'the one-second rule still holds');
    const confirm = f.refIn(saved, 'Save settings');
    assert.ok(confirm, saved);
    const sent = await f.call('browser_act', { steps: [{ do: 'click', ref: confirm }] });
    assert.doesNotMatch(sent, /not run|Submit unconfirmed/i, sent);
    assert.equal(await f.entry.page.evaluate(() => window.saved), 1);
  }
});

test('submit fence: a dialog that appears late is waited for before the fence clears', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, page(1500), 300);
  const started = Date.now();
  const saved = await f.call('browser_act', { steps: [{ do: 'click', ref: f.ref('Save') }], observe: 'full' });
  assert.ok(Date.now() - started >= 1500, 'returned before the slow dialog opened: ' + (Date.now() - started) + ' ms');
  assert.match(saved, /the page answered with a dialog or panel/);
  assert.equal(f.entry.state.submitUnconfirmed, false);
});

test('submit fence: a snapshot captured before the fence start, or inside its first second, never clears it', { skip, timeout: 60000 }, async t => {
  const f = await setup(t, page());
  const state = f.entry.state, submit = beginSubmit(state, 10_000); submit.settledAt = 10_050;
  const early = captureSnapshot(state, 9_999), within = captureSnapshot(state, 10_999), late = captureSnapshot(state, 11_000);
  assert.equal(deliverSnapshot(state, early), false); assert.equal(deliverSnapshot(state, within), false);
  assert.ok(state.submitUnconfirmed, 'fence cleared early');
  assert.equal(deliverSnapshot(state, late), true); assert.equal(state.submitUnconfirmed, false);
});
