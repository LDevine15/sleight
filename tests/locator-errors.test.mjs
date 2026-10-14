import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rewriteLocatorFailure } from '../plugins/sleight/lib/locator-errors.mjs';

const recorded = JSON.parse(readFileSync(new URL('fixtures/locator-errors-haiku.json', import.meta.url)));
const failure = (diag, extra = '') => `Error: Playwright selector deadline exceeded\nlocator.${diag.action} failed for selector ${diag.locator}\n${extra ? extra + '\n' : ''}Locator diagnostics: ${JSON.stringify(diag)}`;
const matched = { kind: 'action_failed', action: 'press', locator: 'body', matchCount: 1,
  matches: [{ tag: 'body', visible: true, disabled: false }], visibleCount: 1 };

test('matching a visible enabled element does not prove it is covered or that input was absent', () => {
  const out = rewriteLocatorFailure(failure(matched));
  assert.match(out.split('\n')[0], /action failed after the element matched/);
  assert.doesNotMatch(out, /covered|sent no input/);
});

test('readonly and multiple-match evidence gets its own cause', () => {
  const multiple = rewriteLocatorFailure(failure({ ...matched, matchCount: 2,
    matches: [{ tag: 'input', visible: true }, { tag: 'div', visible: false }] }));
  assert.match(multiple.split('\n')[0], /matched 2 elements/);
  assert.doesNotMatch(multiple.split('\n')[0], /covered| is hidden/);
});

test('an intercepted click is composed the way actionError emits it', () => {
  const diag = { kind: 'intercepted', action: 'click', locator: 'body', matchCount: 1,
    matches: [{ tag: 'body', visible: true, disabled: false }], visibleCount: 1 };
  const src = 'Error: Element does not receive pointer events at the click point; <div#ov.x> intercepts the click\n' +
    'waiting on click for selector body\n' +
    `Locator diagnostics: ${JSON.stringify(diag)}`;
  const out = rewriteLocatorFailure(src);
  assert.match(out.split('\n')[0], /covered by <div#ov\.x>/);
  assert.ok(out.includes(src));
  assert.doesNotMatch(out, /sent no input/);
});

test('a caller prefix still starts an intercept block, including dblclick', () => {
  const diag = { kind: 'intercepted', action: 'dblclick', locator: 'body', matchCount: 1,
    matches: [{ tag: 'body', visible: true, disabled: false }], visibleCount: 1 };
  for (const prefix of ['Error clicking Pay: Error: ', 'click failed: ']) {
    const src = `${prefix}Element does not receive pointer events at the dblclick point; <div#ov.x> intercepts the dblclick\n` +
      'waiting on dblclick for selector body\n' +
      `Locator diagnostics: ${JSON.stringify(diag)}`;
    const out = rewriteLocatorFailure(src);
    assert.match(out.split('\n')[0], /dblclick body is covered by <div#ov\.x>/, prefix);
    assert.ok(out.includes(src), prefix);
  }
});

test('an intercepted action without a covering node names another element', () => {
  const src = failure({ kind: 'intercepted', action: 'click', locator: 'body', matchCount: 1,
    matches: [{ tag: 'body', visible: true, disabled: false }], visibleCount: 1 });
  const out = rewriteLocatorFailure(src);
  assert.match(out.split('\n')[0], /covered by another element/);
  assert.doesNotMatch(out, /undefined/);
});

test('Element is not enabled, visible or editable uses the engine wording', () => {
  const enabled = rewriteLocatorFailure(failure(matched, 'Element is not enabled'));
  assert.match(enabled.split('\n')[0], /is disabled/);
  const hidden = rewriteLocatorFailure(failure(matched, 'Element is not visible'));
  assert.match(hidden.split('\n')[0], /is hidden/);
  const editable = rewriteLocatorFailure(failure(matched, 'Element is not editable'));
  assert.match(editable.split('\n')[0], /read-only/);
});

test('strict-mode matches include each visible flag', () => {
  const multiple = rewriteLocatorFailure(failure({ ...matched, matchCount: 2,
    matches: [{ tag: 'input', visible: true }, { tag: 'div', visible: false }] }));
  assert.match(multiple.split('\n')[0], /visible:true/);
  assert.match(multiple.split('\n')[0], /visible:false/);
});

test('malformed locator diagnostics leave the engine text unchanged', () => {
  const src = failure({ ...matched, matches: [{ ariaLabel: 5 }] });
  assert.equal(rewriteLocatorFailure(src), src);
});

test('waiting selector parsing retains internal selectors with colons', () => {
  for (const selector of ['internal:label="Dates"i', 'internal:role=button[name="OK"i]']) {
    const src = `Timed out after 3000ms waiting for selector ${selector}: Browser Use encountered an error interacting with this webpage: Error: No element matched selector`;
    const out = rewriteLocatorFailure(src).split('\n')[0];
    assert.ok(out.includes(JSON.stringify(selector)), out);
  }
});

for (const action of ['textContent', 'waitFor']) test(`strict mode on ${action} gives read advice`, () => {
  const src = `Error: strict mode violation: locator('p') resolved to 2 elements:\n  1) <p>one</p> aka getByText('one')\n  2) <p>two</p> aka getByText('two')\nwaiting on ${action} for selector p`;
  const out = rewriteLocatorFailure(src).split('\n')[0];
  assert.doesNotMatch(out, /click|fill/);
  assert.match(out, /domSnapshot/);
});

test('a truncated match listing reports the total and keeps the original diagnostics', () => {
  const src = failure({ ...matched, kind: 'multiple_matches', matchCount: 8,
    matches: Array.from({ length: 8 }, (_, i) => ({ tag: 'button', ariaLabel: String(i) })) });
  const out = rewriteLocatorFailure(src), hint = out.split('\n')[0];
  assert.match(hint, /matched 8 elements/);
  assert.equal((hint.match(/via /g) ?? []).length, 5);
  assert.ok(out.includes(src));
});

test('caller text mentioning a locator failure is left unchanged', () => {
  const src = 'caller output: strict mode violation: example resolved to 2 elements:';
  assert.equal(rewriteLocatorFailure(src), src);
});

test('all recorded locator errors preserve their full engine diagnostics without invented coverage', () => {
  assert.equal(recorded.length, 25);
  for (const row of recorded) {
    const out = rewriteLocatorFailure(row.text), hint = out.split('\n')[0];
    assert.notEqual(out, row.text, row.id);
    assert.ok(out.endsWith(row.text), row.id);
    assert.doesNotMatch(hint, /covered|sent no input/, row.id);
    assert.match(hint, /domSnapshot/, row.id);
  }
});

test('strict matches distinguish duplicate text with exact escaped labels without choosing one', () => {
  const labels = ['Save "draft"\\copy', "Save owner's final"];
  const src = failure({ ...matched, kind: 'multiple_matches', matchCount: 2,
    matches: labels.map(ariaLabel => ({ tag: 'button', role: 'button', text: 'Save', ariaLabel, visible: true })) });
  const hint = rewriteLocatorFailure(src).split('\n')[0];
  for (const label of labels) assert.ok(hint.includes(`getByLabel(${JSON.stringify(label)}, { exact: true })`), hint);
  assert.match(hint, /button/);
  assert.match(hint, /resolve one matching locator/);
  assert.doesNotMatch(hint, /\.first\(|\.nth\(|\.click\(/);
  assert.ok(rewriteLocatorFailure(src).endsWith(src));
});

test('strict diagnostics explicitly report the bounded match listing', () => {
  const src = failure({ ...matched, kind: 'multiple_matches', matchCount: 8, truncated: true,
    matches: Array.from({ length: 8 }, (_, i) => ({ tag: 'button', ariaLabel: `Save ${i}` })) });
  const hint = rewriteLocatorFailure(src).split('\n')[0];
  assert.match(hint, /showing 5 of 8 matches; truncated/);
  assert.equal((hint.match(/getByLabel\("/g) ?? []).length, 5);
});

test('a long label is bounded without suggesting a truncated label as an exact match', () => {
  const src = failure({ ...matched, kind: 'multiple_matches', matchCount: 2,
    matches: [{ role: 'button', ariaLabel: 'private'.repeat(100) }, { role: 'button', ariaLabel: 'Done' }] });
  const hint = rewriteLocatorFailure(src).split('\n')[0];
  assert.ok(hint.length < 900);
  assert.match(hint, /label truncated/);
  assert.doesNotMatch(hint, /getByLabel\("private/);
});

test('strict errors without structured diagnostics still name the documented exact-label form', () => {
  const raw = "Error: strict mode violation: locator('button') resolved to 2 elements:\n  1) <button>Save</button> aka getByRole('button', { name: 'Save' })\n  2) <button>Save as</button> aka getByRole('button', { name: 'Save as' })";
  const hint = rewriteLocatorFailure(raw).split('\n')[0];
  assert.match(hint, /getByLabel\(label, \{ exact: true \}\)/);
  assert.match(hint, /observed full label/);
  assert.ok(rewriteLocatorFailure(raw).endsWith(raw));
});
