import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const sandbox = { module: { exports: {} } };
runInNewContext(readFileSync(new URL('../bench/world/calculator-read.js', import.meta.url), 'utf8'), sandbox);
const read = sandbox.module.exports.readCalculatorField;
function fixture() {
  const record = JSON.parse(readFileSync(new URL('../docs/benchmarks/2026-10-04-double-keys-1791128043845.json', import.meta.url)));
  let tree;
  const find = value => {
    if (typeof value === 'string' && value.includes('Last Expression, Value: 12 × 12') && value.includes('Edit field, Value: 144')) tree ??= value;
    else if (value && typeof value === 'object') Object.values(value).forEach(find);
  };
  find(record);
  assert.ok(tree);
  const window = { role: 'AXWindow', children: [], sheets: [] }, parents = [window];
  const roles = { text: 'AXStaticText', 'scroll area': 'AXScrollArea', button: 'AXButton' };
  for (const line of tree.split('\n').slice(2)) {
    const match = /^(\t*)(\d+) (.+)$/.exec(line);
    if (!match) continue;
    const depth = match[1].length, text = match[3];
    const node = { role: roles[/^(scroll area|text|button)\b/.exec(text)?.[1]] ?? 'AXGroup',
      description: /Description: ([^,\n]+)/.exec(text)?.[1], value: /Value: ([^,\n]+)/.exec(text)?.[1],
      identifier: /ID: (.*?)(?:, Secondary Actions:|$)/.exec(text)?.[1], children: [] };
    (parents[depth - 1] ?? window).children.push(node); parents[depth] = node;
  }
  const field = (() => {
    const nodes = [window]; while (nodes.length) { const node = nodes.pop(); if (node.description === 'Edit field') return node; nodes.push(...node.children); }
  })();
  const app = { pid: 42, start: 1234, element: { windows: [window] } };
  return { app, window, field, api: {
    trusted: () => true, apps: () => [app], windows: element => element.windows, sheets: element => element.sheets ?? [],
    role: element => element.role, value: element => element.value, description: element => element.description,
    identifier: element => element.identifier, hidden: element => Boolean(element.hidden),
    children: element => element.children ?? [], same: (a, b) => a === b,
  } };
}
test('the read-only helper selects the one current visible field on the retained process', () => {
  const f = fixture();
  assert.equal(f.field.role, 'AXStaticText');
  const result = read(f.api, { pid: 42, start: 1234 });
  assert.equal(result.value, '144');
  assert.equal(result.mode, 'scientific');
  f.window.children.push({ role: 'AXStaticText', description: 'Edit field', value: 'history', hidden: true });
  assert.equal(read(f.api, { pid: 42, start: 1234 }).value, '144');
});
test('missing, replaced and ambiguous processes or windows fail without launching anything', () => {
  const f = fixture();
  assert.throws(() => read({ ...f.api, apps: () => [] }, { pid: 42 }), /process/);
  assert.throws(() => read(f.api, { pid: 43 }), /process/);
  assert.throws(() => read(f.api, { pid: 42, start: 1235 }), /process/);
  f.app.element.windows.push(f.window);
  assert.throws(() => read(f.api, { pid: 42 }), /window/);
});
test('permission loss, dialogs, multiple fields and cyclic trees refuse a display result', () => {
  const f = fixture();
  assert.throws(() => read({ ...f.api, trusted: () => false }, { pid: 42 }), /permission/);
  f.window.sheets.push({});
  assert.throws(() => read(f.api, { pid: 42 }), /dialog/);
  f.window.sheets = [];
  f.window.children.push({ role: 'AXStaticText', description: 'Edit field', value: 'old result' });
  assert.throws(() => read(f.api, { pid: 42 }), /field/);
  f.window.children = [f.window];
  assert.throws(() => read(f.api, { pid: 42 }), /cycle/);
});

// Engine 26.1013 (2026-10-19): the driven app gained an unproven AXDialog window beside its own, and every native smoke row
// failed "window absent or ambiguous" with the right product on the display.
test('an extra non-modal non-standard window beside the one standard window is ignored; a modal one still stops', () => {
  const { app, window, api } = fixture();
  window.subrole = 'AXStandardWindow';
  const extra = { role: 'AXWindow', subrole: 'AXDialog', children: [] };
  app.element.windows = [window, extra];
  const withSubrole = { ...api, subrole: element => element.subrole };
  assert.equal(read(withSubrole, { pid: 42 }).value, '144');
  extra.modal = true;
  assert.throws(() => read({ ...withSubrole, modal: element => Boolean(element.modal) }, { pid: 42 }), /dialog present/);
  extra.modal = false; extra.subrole = 'AXStandardWindow';
  assert.throws(() => read(withSubrole, { pid: 42 }), /absent or ambiguous/);
});
