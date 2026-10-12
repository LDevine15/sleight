import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { unawaitedAction } from '../plugins/sleight/lib/relay.mjs';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/h4-page-callbacks.json', import.meta.url), 'utf8'));
for (const { id, code } of recorded) test(`recorded DOM callback is not a kernel action: ${id}`, () => {
  assert.equal(unawaitedAction(code), undefined);
});
for (const code of [
  'await tab.evaluate(() => { button.click(); return true; }); nodeRepl.write("done");',
  'await tab.playwright.evaluate(async () => { button.click(); await Promise.resolve(); }); nodeRepl.write("done");',
  'await locator.evaluateAll(nodes => { nodes.forEach(node => { node.click(); }); return nodes.length; }); nodeRepl.write("done");',
  'await tab.evaluate(function () { button.click(); return true; }); nodeRepl.write("done");',
  'await tab.evaluate((() => { button.click(); return true; })); nodeRepl.write("done");',
  'await tab.evaluate(() => { const braces = "})"; /* } */ button.click(); return /[})]/.test(braces); }); nodeRepl.write("done");',
  'function pageClick() { button.click(); return 1; } await tab.evaluate(pageClick); nodeRepl.write("done");',
  'const pageClick = () => { button.click(); return 1; }; await tab.evaluate(pageClick); nodeRepl.write("done");',
  'await tab.evaluate(() => { const f = () => /["}]/; button.click(); return f().test("x"); }); nodeRepl.write("done");',
  'await tab.evaluate(() => { const x = obj.return / 2; button.click(); return x; }); nodeRepl.write("done");',
]) test(`inline page callback skips the kernel await check: ${code}`, () => {
  assert.equal(unawaitedAction(code), undefined);
});
for (const code of [
  'app.click(1); await tab.evaluate(() => { button.click(); return 1; });',
  'await tab.evaluate(() => { button.click(); return 1; }); app.click(1); await app.getAXState();',
  'await tab.evaluate(() => { button.click(); return 1; }, app.click(1)); app.click(2); await app.getAXState();',
  'await tab.evaluate((() => { app.click(1); return 1; })()); await app.getAXState();',
  'const fn = () => { app.click(1); return 1; }; await tab.evaluate(fn); fn();',
  'await tab.evaluate(() => { button.click(); return 1; }); app.click(1).then(() => 2); await app.getAXState();',
]) test(`kernel actions outside a page callback retain refusal: ${code}`, () => {
  assert.ok(unawaitedAction(code));
});
for (const expression of ['const f = () => /["}]/;', 'const x = obj.return / 2;', 'const s = "go to /home";', 'const x = (a + b) / 2;']) {
  test(`lexical punctuation cannot hide an action after evaluate: ${expression}`, () => {
    const code = `await tab.evaluate(() => { ${expression} button.click(); return 1; }); app.click(1); await app.getAXState();`;
    assert.equal(unawaitedAction(code), 'app.click(');
  });
}
