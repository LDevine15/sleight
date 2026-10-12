import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { skillRules, localToolDefinitions } from '../plugins/sleight/lib/launch.mjs';
import { batchingDescription, createRelay } from '../plugins/sleight/lib/relay.mjs';
// The budget script parses relay.mjs with the typescript dev dependency, which CI doesn't install.
const budget = await import('../bench/prompt-budget.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return null;
  throw error;
});
const skip = !budget && 'needs the typescript dev dependency (npm install)';
const { noticeInventory, sharedNoticeInventory } = budget ?? {};

const firstRule = 'execute exactly one of the API calls shown below, optionally assigning its result to a variable. Do not add other API calls, waits, or snapshots to that invocation.';
const hash = text => createHash('sha256').update(text).digest('hex');
const baseline = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url)));
const skillPath = new URL('../plugins/sleight/skills/drive-mac-apps/SKILL.md', import.meta.url);
const leanSkill = () => skillRules(skillPath, { SLEIGHT_PROMPT: 'lean' });

test('both skill variants explain browser routing and script input within their word budgets', () => {
  for (const [env, limit] of [[{}, 930], [{ SLEIGHT_PROMPT: 'lean' }, 430]]) {
    const skill = skillRules(skillPath, env);
    assert.match(skill, /[Ww]eb pages.*tab handle, never `getApp`/);
    assert.match(skill, /top-level `await`, no `return`/);
    assert.match(skill, /[Ww]rite text with `nodeRepl\.write\(\.\.\.\)`/);
    assert.doesNotMatch(skill, /last expression is the result/);
    assert.match(skill, /Tab input.*first argument.*element index or `null`/);
    assert.match(skill, /Fill every (?:field you already see|visible field) in one call/);
    assert.match(skill, /nodeRepl\.write\(await sleight\.fillForm\(tab,/);
    assert.match(skill, /takes each field by label or locator \(an index needs a stable ID in the tree\)/);
    assert.match(skill, /[Rr]ead once at the end/);
    assert.match(skill, /Submit in (?:that|the same) call only when the user asked[^.]*confirmation policy\sdoesn't require confirming it\./);
    assert.match(skill, /Otherwise stop before the final click\./);
    assert.doesNotMatch(skill, /submit in (?:that|the same) call when nothing is uncertain/i);
    assert.match(skill, /Use locators when validation(?: or |\/)autocomplete (?:can add or move|moves) fields, indices on static forms\./);
    assert.match(skill, /`tab\.drag` takes page coordinates from `getBoundingClientRect\(\)`/);
    assert.match(skill, /`tab\.click\(index\)`, not a locator, then answer it: `\(await tab\.getJsDialog\(\)\)\.accept\(\)`/);
    assert.ok(skill.trim().split(/\s+/).length <= limit, 'skill word budget');
  }
});

test('the default skill retains extension selection and lean retains precise safety instructions', () => {
  const normal = skillRules(skillPath, {}), lean = leanSkill();
  assert.match(normal, /With a connected ChatGPT extension/);
  assert.match(normal, /Several Chromium browsers report as Chrome/);
  assert.match(normal, /metadata\.extensionInstanceId.*await cua\.listBrowsers\(\)/s);
  assert.match(normal, /cua\.getBrowser\(\{ extensionInstanceId \}\).*in a call of its own/s);
  assert.match(lean, /tell the user first that it moves their pointer/i);
  assert.match(lean, /ask the user to run `bin\/sleight-mcp --doctor` from the plugin folder/);
  assert.match(lean, /the latest screenshot of that window/);
  assert.match(lean, /press Cmd\+Z in that window/);
  assert.match(lean, /Use only documented methods/);
  assert.match(lean, /leave tabs in the background/i);
  assert.match(lean, /stop if the user declines a browser approval/i);
  assert.match(lean, /brings the app forward for about two seconds/);
  assert.match(lean, /the engine's confirmation policy/);
  assert.match(lean, /Before `hover`, try `Help:`/);
});

test('nosavestop changes only the final stop clause and keeps the default prompt hashes', () => {
  assert.equal(hash(batchingDescription(firstRule, true)), baseline.batch);
  assert.equal(hash(batchingDescription(firstRule, 'merge')), baseline.merge);
  const clause = ', but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.';
  for (const prompt of [undefined, 'lean']) {
    const normal = batchingDescription(firstRule, true, prompt);
    assert.ok(normal.endsWith(clause));
    const expected = normal.slice(0, -clause.length) + '. sleight waits for the sheet a shortcut opens.';
    assert.equal(batchingDescription(firstRule, 'nosavestop', prompt), expected);
    assert.equal(batchingDescription('different engine wording', 'nosavestop', prompt), 'different engine wording');
  }
});

test('the launcher selects nosavestop without changing default, disabled or merge settings', async () => {
  const { firstCallBatchSetting } = await import('../plugins/sleight/lib/relay.mjs');
  for (const [value, expected] of [['nosavestop', 'nosavestop'], ['merge', 'merge'], ['0', false],
    [undefined, true], ['1', true], ['NOSAVESTOP', true]]) {
    assert.equal(firstCallBatchSetting?.(value), expected);
  }
});

test('only lean selects shorter text and every default prompt stays byte-identical', { skip }, () => {
  assert.ok(leanSkill().length < skillRules(skillPath, {}).length);
  assert.equal(hash(JSON.stringify(noticeInventory().map(e => e.text))), baseline.notices);
  for (const env of [{}, { SLEIGHT_PROMPT: 'default' }, { SLEIGHT_PROMPT: 'LEAN' }]) {
    assert.equal(hash(skillRules(skillPath, env)), baseline.skill);
    assert.equal(hash(JSON.stringify(localToolDefinitions(env))), baseline.tools);
    assert.equal(hash(batchingDescription(firstRule, true, env.SLEIGHT_PROMPT)), baseline.batch);
    assert.equal(hash(batchingDescription(firstRule, 'merge', env.SLEIGHT_PROMPT)), baseline.merge);
  }
  const stripDescriptions = value => Array.isArray(value) ? value.map(stripDescriptions) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, stripDescriptions(item)])) : value;
  assert.deepEqual(stripDescriptions(localToolDefinitions({ SLEIGHT_PROMPT: 'lean' })), stripDescriptions(localToolDefinitions({})));
});

test('lean retains the skill safety passages verbatim and removes named examples', { skip }, () => {
  const lean = leanSkill();
  assert.ok(lean.length < skillRules(skillPath, {}).length);
  for (const passage of baseline.skillSafety) assert.ok(lean.includes(passage), passage);
  const withoutSafety = baseline.skillSafety.reduce((text, passage) => text.replace(passage, ''), lean);
  const texts = [withoutSafety, batchingDescription(firstRule, true, 'lean'), batchingDescription(firstRule, 'merge', 'lean')];
  for (const variant of [true, 'merge']) assert.ok(batchingDescription(firstRule, variant, 'lean').includes('sleight acquires the app and checks its window before they run.'));
  assert.ok(batchingDescription(firstRule, true, 'lean').includes('but end the call after a shortcut that opens or names a window (Cmd+N, Cmd+O, or Cmd+S on an untitled document): sleight stops the rest of a call when its window changes.'));
  for (const tool of localToolDefinitions({ SLEIGHT_PROMPT: 'lean' })) {
    const safety = baseline.toolSafety[tool.name] ?? [];
    for (const passage of safety) assert.ok(tool.description.includes(passage), `${tool.name}: ${passage}`);
    texts.push(safety.reduce((text, passage) => text.replace(passage, ''), JSON.stringify(tool)));
  }
  assert.doesNotMatch(texts.join('\n'), /Calculator|TextEdit|Chess|Safari|Helium|iPhone|Simulator|Slack|Chrome|ChatGPT|Codex|Atlas|Terminal|iTerm2/);
  const [normalHover] = localToolDefinitions({}).filter(t => t.name === 'hover');
  const [leanHover] = localToolDefinitions({ SLEIGHT_PROMPT: 'lean' }).filter(t => t.name === 'hover');
  assert.equal(leanHover.inputSchema.properties.windowTitle.description, normalHover.inputSchema.properties.windowTitle.description);
  const sharedLean = sharedNoticeInventory('lean').map(e => e.text).join('\n');
  for (const entry of sharedNoticeInventory()) {
    for (const sentence of entry.text.split(/(?<=[.!?])\s+/)) {
      if (/^(?:Stop|Ask|Tell|Read|Before|Restarting|Never|Use|The user|Its settings|A yes)\b/.test(sentence)) assert.ok(sharedLean.includes(sentence), sentence);
    }
  }
});

test('lean changes relay additions without changing engine text or safety refusals', t => {
  function reply(prompt) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const output = [];
    clientOut.on('data', bytes => output.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, prompt, changeReview: false, firstCallBatch: true });
    t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'js', description: `ENGINE BEFORE ${firstRule} ENGINE AFTER` }] } }) + '\n');
    const description = output.at(-1).result.tools[0].description;
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [
      { type: 'text', text: 'ENGINE TEXT, including Calculator, stays unchanged.' },
      { type: 'image', data: 'same', mimeType: 'image/png' }, { type: 'image', data: 'same', mimeType: 'image/png' },
    ] } }) + '\n');
    const content = output.at(-1).result.content;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'app.click(1); app.typeText("x")' } } }) + '\n');
    return { description, content, refusal: output.at(-1).result };
  }
  const normal = reply(), lean = reply('lean');
  assert.ok(lean.description.length < normal.description.length);
  assert.match(lean.description, /^ENGINE BEFORE .* ENGINE AFTER$/);
  assert.deepEqual(lean.content.slice(0, 2), normal.content.slice(0, 2));
  assert.ok(lean.content.at(-1).text.length < normal.content.at(-1).text.length);
  assert.equal(lean.refusal.isError, true);
  assert.equal(normal.refusal.isError, true);
  assert.match(lean.refusal.content[0].text, /stopped this call before it ran:.*Add await and send it again\./);
});

// Lean was 30% under the default until both gained the same browser lines (29.7%, 2026-10-12).
test('the offline budget command measures all sources and stays about 30 percent under', { skip }, () => {
  const result = spawnSync(process.execPath, ['bench/prompt-budget.mjs', '--json'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.rows.some(row => row.source === 'skill'));
  assert.ok(report.rows.some(row => row.source === 'js rewrite'));
  assert.ok(report.rows.some(row => row.source === 'relay notices'));
  assert.ok(report.rows.some(row => row.source === 'tool descriptions'));
  assert.ok(report.rows.some(row => row.source === 'shared notices'));
  assert.ok(report.total.lean.characters <= report.total.default.characters * 0.71, JSON.stringify(report.total));
});
