import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';
import { createActionRunner, inspectTarget } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { snapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';

async function setup(t, html) {
  const f = await fixture(t, html), { page } = f.entry;
  const runSteps = createActionRunner({ check: () => 'allow', snapshot, backgroundClick });
  const fill = createFillFields({ check: () => 'allow', runSteps, inspectElement: inspectTarget });
  const ref = async selector => {
    await snapshot(page);
    const tree = await page.locator(selector).ariaSnapshot({ mode: 'ai' });
    const match = tree.match(/\[ref=(e\d+)\]/);
    assert.ok(match, tree); return match[1];
  };
  return { ...f, page, ref, runSteps, fill: async (selector, value) => fill(f.entry, [{ ref: await ref(selector), value }], {}, {}) };
}

const settings = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/test/forms/site/settings.html');
test('real settings Languages multi-select replaces prior choices, emits page events and clears', {
  skip: skip || (!existsSync(settings) && 'read-only settings fixture is unavailable'), timeout: 30000,
}, async t => {
  const source = readFileSync(settings, 'utf8'), control = source.match(/<select id="languages" multiple>[\s\S]*?<\/select>/)?.[0];
  assert.ok(control, 'settings Languages control');
  const f = await setup(t, '<label for="languages">Languages</label>' + control + `<script>
    window.events=[];
    for(const type of ['input','change']) languages.addEventListener(type,e=>events.push([e.type,[...languages.selectedOptions].map(o=>o.value)]));
    languages.options[0].selected=true;
  </script>`);
  const result = await f.fill('#languages', ['Portuguese (Brazil)', 'Japanese']);
  assert.equal(result.rows[0].status, 'set', JSON.stringify(result));
  assert.deepEqual(await f.page.locator('#languages').evaluate(el => [...el.selectedOptions].map(o => o.value)), ['pt-BR', 'ja']);
  assert.deepEqual(await f.page.evaluate(() => events), [['input', ['pt-BR', 'ja']], ['change', ['pt-BR', 'ja']]]);
  assert.equal((await f.fill('#languages', [])).rows[0].status, 'set');
  assert.deepEqual(await f.page.locator('#languages').evaluate(el => [...el.selectedOptions]), []);
  assert.deepEqual((await f.page.evaluate(() => events)).slice(-2), [['input', []], ['change', []]]);
});

const aria = `<div role="listbox" aria-label="Languages" aria-multiselectable="true" id="languages">
  <div role="option" aria-selected="true">English</div>
  <div role="option" aria-selected="true">Portuguese (Brazil)</div>
  <div role="option" aria-selected="false">Japanese</div>
</div><script>
window.selections=[];
languages.addEventListener('click',event=>{
  const row=event.target.closest('[role="option"]'); if(!row)return;
  if(!event.metaKey&&!event.ctrlKey) for(const other of languages.children)other.setAttribute('aria-selected','false');
  row.setAttribute('aria-selected',String(row.getAttribute('aria-selected')!=='true'));
  selections.push([...languages.children].filter(o=>o.getAttribute('aria-selected')==='true').map(o=>o.textContent));
});
</script>`;
const selected = page => page.locator('#languages').evaluate(el => [...el.children].filter(o => o.getAttribute('aria-selected') === 'true').map(o => o.textContent));

test('real ARIA multi-select updates page-owned selection and clears through modifier clicks', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, aria);
  const result = await f.fill('#languages', ['Portuguese (Brazil)', 'Japanese']);
  assert.equal(result.rows[0].status, 'set', JSON.stringify(result));
  assert.deepEqual(await selected(f.page), ['Portuguese (Brazil)', 'Japanese']);
  assert.equal((await f.fill('#languages', [])).rows[0].status, 'set');
  assert.deepEqual(await selected(f.page), []);
  assert.equal((await f.page.evaluate(() => selections)).length, 4);
});

test('real browser_act exposes its requested command modifier through the background hook', { skip, timeout: 30000 }, async t => {
  const f = await setup(t, aria);
  const result = await f.runSteps(f.entry, [{ do: 'click', ref: await f.ref('[role="option"]:last-child'), modifier: 'cmd' }], {});
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.deepEqual(await selected(f.page), ['English', 'Portuguese (Brazil)', 'Japanese']);
});
