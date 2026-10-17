import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillRules, localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

test('the shipped skill becomes the first-call rules without its front matter', () => {
  const rules = skillRules();
  assert.match(rules, /^# Driving Mac apps with sleight/);
  assert.doesNotMatch(rules, /^---|disable-model-invocation/m);
});

test('a missing or empty skill gives no rules', t => {
  const dir = trackTemp(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-skill-'))));
  assert.equal(skillRules(join(dir, 'missing.md')), undefined);
  writeFileSync(join(dir, 'empty.md'), '---\nname: x\n---\n');
  assert.equal(skillRules(join(dir, 'empty.md')), undefined);
});

test('the skill names no app and keeps the safety rules', () => {
  const rules = skillRules();
  assert.doesNotMatch(rules, /TextEdit|Calculator|Chess|Safari|Helium|iPhone|Simulator|Slack/);
  for (const rule of [/preapproved\.json/, /Never run that command yourself/, /flow_exception/, /lease/]) assert.match(rules, rule);
});

test('named native tasks acquire directly and action results avoid a confirming read', () => {
  const rules = skillRules();
  assert.match(rules, /When the task specifies an app, start with `let app = await cua\.getApp/);
  assert.match(rules, /`cua\.getState\(\)` only to find an app you can't name/);
  assert.match(rules, /End on the action\. Its result includes changed lines/);
  assert.match(rules, /Don't read just to confirm them/);
  assert.match(rules, /For missing information, use `await app\.getAXState\(\)`/);
  assert.match(rules, /empty tree[\s\S]*user changed the app[\s\S]*header\s+changed, read again before retrying/);
  assert.ok(rules.split(/\s+/).length <= 930);
});

// AN1: posted clicks on sheet tabs dragged them in 6 of 8 runs; next/previous-sheet keys moved nothing (6/6).
test('the skill switches document tabs by key or go-to control and checks the order, naming no app', () => {
  const rules = skillRules();
  assert.match(rules, /After finishing any edit, switch sheets or document tabs with the app's next\/previous-tab key or\s+go-to control \(clicks can drag tabs\), then check the order\./);
  assert.doesNotMatch(rules, /Excel|Numbers|Option\+(?:Left|Right)|Name Box/);
  for (const env of [{}, { SLEIGHT_LEAN_CALLS: '1' }]) assert.ok(skillRules(undefined, env).trim().split(/\s+/).length <= 930);
});

// AO1: one rectangular paste entered a known block in 3.82 s mean against 7.53 s cell by cell (3/3 each);
// a multiline typeText saved a cell wrong. The paste overwrites the block, so the rule names that condition.
test('the skill enters a known spreadsheet block as one tab and newline paste, only when every value is known', () => {
  for (const env of [{}, { SLEIGHT_LEAN_CALLS: '1' }]) {
    const rules = skillRules(undefined, env);
    assert.match(rules, /Fill spreadsheet cells as one paste at the block's top-left cell, tabs between columns and\s+newlines between rows/);
    assert.ok(rules.includes('`await app.paste("<a>\\t<b>\\n<c>\\t<d>", { format: "text" })`'));
    assert.match(rules, /It overwrites\s+the whole block: paste only when you know every cell's value, blanks included\./);
    assert.doesNotMatch(rules, /\.typeText\("[^"]*\\n/);
    // The drag tool's description carries its arguments and lost-text recovery; the skill keeps the routing.
    assert.match(rules, /To move selected text, select it in `js`, then call the `drag` tool, not `app\.drag`\./);
    assert.ok(rules.trim().split(/\s+/).length <= 930);
  }
});

test('the drag and menu_bar descriptions carry what the skill no longer repeats', () => {
  const drag = localToolDefinitions({}).find(tool => tool.name === 'drag');
  for (const passage of ['for what app.drag in the js tool can\'t do, such as moving selected text (select it with js first)',
    'in the same frame as the app\'s engine screenshot', 'Pass `windowId` when several windows fit',
    'A lost-text error tells you to press Cmd+Z in the target app and named window.']) assert.ok(drag.description.includes(passage), passage);
  const menuBar = localToolDefinitions({}).find(tool => tool.name === 'menu_bar');
  assert.match(menuBar.description, /status items in the macOS menu bar/);
});

test('the screenshot skill variant adds a read for textless document panes and tables only when selected', () => {
  for (const prompt of [undefined, 'lean']) {
    const normal = skillRules(undefined, { SLEIGHT_PROMPT: prompt });
    const selected = skillRules(undefined, { SLEIGHT_PROMPT: prompt, SLEIGHT_SKILL: 'screenshot' });
    const guidance = 'When a document pane or table exposes no text, read the window with `nodeRepl.emitImage(await app.getScreenshot())`.';
    assert.ok(selected.includes(guidance));
    assert.equal(selected.replace(guidance + '\n\n', ''), normal, 'all other guidance and safety stay identical');
    for (const value of [undefined, 'none', 'default', 'SCREENSHOT']) {
      assert.equal(skillRules(undefined, { SLEIGHT_PROMPT: prompt, SLEIGHT_SKILL: value }), normal);
    }
  }
});
