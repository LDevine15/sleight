// CC6 (codex-vs-cc-1019): a trailing getAXState() after an action costs no second engine read, and the engine's Workflow
// lines that ask for one are rewritten on the computer surface (workflow-docs.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { guardedCode, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/document-scope.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { rewriteWorkflow, WORKFLOW_PINS } from '../plugins/sleight/lib/workflow-docs.mjs';
import { checkWorkflowRewrite } from '../bench/compat/contract.mjs';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

// Synthetic engine lines stand in for the pinned ones, so OpenAI's text stays out of the repo.
const ASK = 'Read after every action.', BATCH = '- Batch actions and the read.', LEAD = '  Act, then read:', READ = 'await target.getAXState();';
const pins = { [sha(ASK)]: 'Results hold the state.', [sha(BATCH)]: '- End on the action.', [sha(LEAD)]: '  Act:', [sha(READ)]: null };
const doc = (workflow = [ASK, '', BATCH, '- Other rule.', LEAD, '', '```typescript', 'await target.click(42);', READ, '```'].join('\n')) =>
  `## Computer Use\n\nIntro ${READ}\n\n## Workflow\n\n${workflow}\n\n## Output\n\n${READ}\n`;

test('the Workflow rewrite replaces every pinned line once and leaves the rest of the document alone', () => {
  const { text, status } = rewriteWorkflow(doc(), pins);
  assert.equal(status, 'rewritten');
  assert.equal(text, `## Computer Use\n\nIntro ${READ}\n\n## Workflow\n\nResults hold the state.\n\n- End on the action.\n- Other rule.\n  Act:\n\n` +
    '```typescript\nawait target.click(42);\n```\n\n## Output\n\n' + READ + '\n');
});

test('a missing, repeated or changed pinned line keeps the engine text whole', () => {
  const cases = [doc([ASK, BATCH, LEAD].join('\n')), doc([ASK, BATCH, BATCH, LEAD, READ].join('\n')),
    doc([ASK.replace('every', 'each'), BATCH, LEAD, READ].join('\n')), doc().replace('## Workflow', '## Flow'), 'no docs', undefined];
  for (const text of cases) assert.deepEqual(rewriteWorkflow(text, pins), { text, status: 'unmatched' });
  // A pinned line outside the Workflow section doesn't count: here the example's read sits under Output only.
  const outside = doc([ASK, BATCH, LEAD].join('\n'));
  assert.equal(rewriteWorkflow(outside, pins).status, 'unmatched');
});

test('the shipped pins are four whole-line hashes with one-line replacements', () => {
  assert.equal(Object.keys(WORKFLOW_PINS).length, 4);
  for (const hash of Object.keys(WORKFLOW_PINS)) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(Object.values(WORKFLOW_PINS).filter(value => value === null).length, 1);
  for (const text of Object.values(WORKFLOW_PINS).filter(Boolean)) assert.doesNotMatch(text, /\n|—/);
});

// ENGINE_CORE_DOC names the engine's tinysky-alt-core-cua-repl.md (26.1013.40934), for this check on a Mac.
const coreDoc = process.env.ENGINE_CORE_DOC;
test('with the engine\'s own document, the rewrite applies and no line asks for a trailing read', { skip: !(coreDoc && existsSync(coreDoc)) && 'no ENGINE_CORE_DOC' }, () => {
  const engine = readFileSync(coreDoc, 'utf8');
  const { text, status } = rewriteWorkflow(engine);
  assert.equal(status, 'rewritten');
  assert.doesNotMatch(text, /and the resulting `getAXState\(\)`/);
  assert.doesNotMatch(text, /call `getAXState\(\)` before deciding/);
  assert.ok(text.length < engine.length);
  assert.deepEqual(checkWorkflowRewrite([engine]), [{ id: 'workflow-rewrite', status: 'pass' }]);
});

test('the compatibility check warns when the rewrite no longer applies', () => {
  assert.equal(checkWorkflowRewrite([doc()])[0].status, 'warn');
  assert.match(checkWorkflowRewrite(['Invalid app: x'])[0].reason, /no result item starts/);
});

// The guard's own read after a call that ends on an action is the one a trailing getAXState() replaces, so both forms make
// the same engine operations and return the same tree. Reads cost 110 ms here, so a second read would show as more than 0.1 s.
const READ_MS = 110, CLICK_MS = 5;
function engineApp({ app, title, rows }) {
  const window = { title, app, url: null };
  let version = 0;
  const tree = () => `Window: ${JSON.stringify(title)}, App: ${app}.\n0 standard window\n${rows(version)}`;
  const ops = [], output = [];
  const raw = {
    async getAXState() { await sleep(READ_MS); ops.push('read'); return tree(); },
    async click(n) { await sleep(CLICK_MS); ops.push('click'); version++; return n; },
  };
  const context = { app: raw, setTimeout, cua: { getApp: async () => raw, listApps: async () => [] }, nodeRepl: { write: value => output.push(value), emitImage: async () => {} } };
  const run = code => runInNewContext(`(async () => { ${guardedCode(code, window, 'changed window', undefined, { focused: true })} })()`, context);
  return { run, ops, output, tree };
}
const apps = [
  { app: 'TextEdit', title: 'notes.txt', rows: v => `\t1 button Bold, ID: bold\n\t2 text area (settable) Value: draft ${v}` },
  { app: 'Firefox', title: 'Book a trip', rows: v => `\t1 button Next month\n\t2 button December ${14 + v % 5}, 2026\n\t3 text Chosen ${v}` },
];

test('click(n); getAXState() matches click(n) within 0.1 s over 20 calls in two apps, with the same reads and tree', async () => {
  const CALLS = 20;
  const measure = async (spec, code) => {
    const f = engineApp(spec), times = [], trees = [], sequences = [];
    for (let i = 0; i < CALLS; i++) {
      const from = f.ops.length, start = performance.now();
      await f.run(code);
      times.push(performance.now() - start);
      sequences.push(f.ops.slice(from).join(','));
      const last = f.output.at(-1);
      assert.ok(last.startsWith(GUARD_MARK) && last.endsWith(GUARD_END), 'the call ends with one full guard read');
      trees.push(last.slice(GUARD_MARK.length, -GUARD_END.length));
      // The tree is the one after this call's click, never the one before it.
      assert.equal(trees.at(-1), f.tree());
    }
    return { times, trees, sequences, mean: times.reduce((a, b) => a + b, 0) / CALLS };
  };
  await Promise.all(apps.map(async spec => {
    const [alone, trailing] = await Promise.all([measure(spec, 'await app.click(1);'), measure(spec, 'await app.click(1);\nawait app.getAXState();')]);
    assert.deepEqual(trailing.sequences, alone.sequences, spec.app);
    assert.ok(alone.sequences.every(sequence => sequence === 'read,click,read'), alone.sequences[0]);
    assert.deepEqual(trailing.trees, alone.trees, spec.app);
    assert.ok(Math.abs(trailing.mean - alone.mean) < 100, `${spec.app}: ${trailing.mean.toFixed(1)} ms against ${alone.mean.toFixed(1)} ms`);
  }));
});

test('a trailing read after a batch reads once, after the last action, and a read between actions stays a real read', async () => {
  const steady = { app: 'Firefox', title: 'Book a trip', rows: v => `\t1 button Next\n\t2 button Back\n\t3 text Chosen ${v}` };
  const f = engineApp(steady);
  await f.run('await app.click(1);\nawait app.click(2);\nawait app.getAXState();');
  assert.deepEqual(f.ops, ['read', 'click', 'read', 'click', 'read']);
  assert.equal(f.output.at(-1), GUARD_MARK + f.tree() + GUARD_END);
  const g = engineApp(steady);
  await g.run('await app.click(1);\nawait app.getAXState();\nawait app.click(2);');
  // The mid-call read serves the second click's check; the call still ends on a read after that click.
  assert.deepEqual(g.ops, ['read', 'click', 'read', 'click', 'read']);
  assert.equal(g.output.at(-1), GUARD_MARK + g.tree() + GUARD_END);
});

// What Claude sees: a call that ends on the action gets the renumbered lines with current numbers, as a trailing read does.
test('an action result shows renumbered lines as a trailing read would, and no number goes stale', () => {
  const window = { title: 'list', app: 'Finder', url: null };
  const rows = names => [`Window: "list", App: Finder.`, '0 standard window list, Secondary Actions: Raise',
    ...names.map((name, i) => `\t${i + 1} row (selectable) Value: ${name}`)].join('\n');
  const before = Array.from({ length: 50 }, (_, i) => `File ${i}`);
  const after = [...before.slice(0, 46), 'File new', ...before.slice(46)];
  const result = (actionNumbers, code) => {
    const c = createReadCompactor({ actionNumbers });
    c.process([{ type: 'text', text: rows(before) }]);
    const [out] = c.process([{ type: 'text', text: GUARD_MARK + rows(after) + GUARD_END }], { code, action: c.beginAction(code) }).map(item => item.text);
    return { out, stale: c.staleIndex(window, 'await app.click(49);') };
  };
  const ended = result(true, 'await app.click(3);'), trailing = result(true, 'await app.click(3);\nawait app.getAXState();');
  assert.equal(ended.out, trailing.out);
  assert.match(ended.out, /\+ \t49 row \(selectable\) Value: File 47/);
  assert.equal(ended.stale, undefined);
  // SLEIGHT_WORKFLOW_DOCS=0: the action result counts the renumbered rows and the old number is refused.
  const baseline = result(false, 'await app.click(3);');
  assert.match(baseline.out, /other elements have new numbers/);
  assert.doesNotMatch(baseline.out, /\+ \t49 row/);
  assert.deepEqual(baseline.stale, { number: 49 });
});

test('an unawaited last action finishes before the call reads, so the tree is the one after it', async () => {
  const f = engineApp(apps[0]);
  await f.run('app.click(1);');
  assert.deepEqual(f.ops, ['read', 'click', 'read']);
  assert.equal(f.output.at(-1), GUARD_MARK + f.tree() + GUARD_END);
});

// The relay rewrites the docs only on the computer surface, with the guard on, unless SLEIGHT_WORKFLOW_DOCS=0.
const leaseDir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-workflow-docs-')));
after(() => removeTemp(leaseDir));
async function firstResult(t, { description, docs, workflowDocs, lease = true }) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = [], traces = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(line => JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, trace: (direction, msg) => traces.push({ direction, ...msg }),
    ...(lease ? { inputLease: new InputLease({ directory: leaseDir, holder: 'workflow-docs-test' }) } : {}),
    ...(workflowDocs === undefined ? {} : { workflowDocs }) });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'tools/list' }) + '\n'); await tick();
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 'list', result: { tools: [{ name: 'js', description }] } }) + '\n'); await tick();
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } }) + '\n'); await tick();
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: docs }, { type: 'text', text: 'Window: "notes.txt", App: TextEdit.\n0 standard window' }],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } }) + '\n'); await tick();
  const text = replies.find(row => row.id === 1).result.content.map(item => item.text ?? '').join('\n');
  return { text, statuses: traces.filter(row => row.direction === 'workflow-docs').map(row => row.status) };
}
const COMPUTER = 'Control native apps.\n\nBrowser APIs are disabled.\n\nUse cua.getApp.';
const BROWSER = 'Control native apps and browsers.\n\nUse cua.getTab or cua.getApp.';

test('the relay tries the rewrite only on the computer surface with the guard on, and SLEIGHT_WORKFLOW_DOCS=0 keeps the engine text', async t => {
  assert.deepEqual((await firstResult(t, { description: COMPUTER, docs: doc() })).statuses, ['unmatched']);
  assert.deepEqual((await firstResult(t, { description: BROWSER, docs: doc() })).statuses, []);
  assert.deepEqual((await firstResult(t, { description: COMPUTER, docs: doc(), workflowDocs: false })).statuses, []);
  assert.deepEqual((await firstResult(t, { description: COMPUTER, docs: doc(), lease: false })).statuses, []);
});

test('with the engine\'s own document, the relay delivers the rewritten Workflow on the computer surface only', { skip: !(coreDoc && existsSync(coreDoc)) && 'no ENGINE_CORE_DOC' }, async t => {
  const engine = readFileSync(coreDoc, 'utf8').trimEnd();
  const computer = await firstResult(t, { description: COMPUTER, docs: engine });
  assert.deepEqual(computer.statuses, ['rewritten']);
  assert.doesNotMatch(computer.text, /and the resulting `getAXState\(\)`/);
  assert.match(computer.text, /a trailing `getAXState\(\)` only repeats it/);
  const browser = await firstResult(t, { description: BROWSER, docs: engine });
  assert.match(browser.text, /and the resulting `getAXState\(\)`/);
});
