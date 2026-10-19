import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_MEMBERS, CUA_METHODS, MATCHED_ONLY, PROBE_CODE, apiBlock, checkApiContract, checkPolicyRewrite, checkReplProbe,
  checkToolSurface, membersOf, parseDeclarations, parseProbe } from '../bench/compat/contract.mjs';

const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const ts = fixture('engine-api-26.1007.71326.ts');
const policy = fixture('engine-confirmations-policy.txt');
const docs = (block = ts, tail = policy) => `## Computer Use\n\nControl apps.\n\n## API\n\n\`\`\`typescript\n${block}\`\`\`\n\n## Notes\n\n${tail}`;
const jsTool = (props = { code: { type: 'string' }, timeout_ms: { type: 'integer' }, title: { type: 'string' } }) =>
  ({ name: 'js', description: fixture('engine-js-description.txt').trimEnd(), inputSchema: { type: 'object', properties: props, required: ['code'] } });

test('the declarations parser reads members, one-line types and inherited methods', () => {
  const owners = parseDeclarations(ts);
  assert.deepEqual([...membersOf(owners, 'StateAndScreenshot')].sort(), ['screenshot', 'state']);
  assert.deepEqual([...membersOf(owners, 'StateOptions')].sort(), ['disableDiffing', 'emit']);
  const app = membersOf(owners, 'App');
  for (const name of ['getAXState', 'click', 'typeText', 'pressKey']) assert.ok(app.has(name), name);
  // A multi-line signature counts once, and its parameters are not members.
  assert.ok(!app.has('target') && !app.has('direction'));
  assert.ok(membersOf(owners, 'cua').has('createBrowserTab'));
  assert.equal(apiBlock(docs()), ts.replace(/\n$/, ''));
});

test('the recorded API passes, and a removed member sleight uses fails by name', () => {
  assert.deepEqual(checkApiContract(docs()).map(r => r.status), ['pass', 'pass']);
  const gone = checkApiContract(docs(ts.replace(/^\s*typeText\(text: string\): Promise<void>;\n/m, '')));
  assert.equal(gone[0].status, 'fail');
  assert.match(gone[0].reason, /App\.typeText/);
  const noState = checkApiContract(docs(ts.replace('type StateAndScreenshot = { state: string; screenshot?: Uint8Array };', 'type StateAndScreenshot = { image: string };')));
  assert.match(noState[0].reason, /StateAndScreenshot\.state, StateAndScreenshot\.screenshot/);
  assert.equal(checkApiContract('## Computer Use\n\nno API here').at(0).status, 'fail');
  assert.equal(checkApiContract(docs(ts, 'no policy')).at(1).status, 'warn');
});

test('the tool surface needs js with code, timeout_ms and title, and turn_ended', () => {
  const ok = checkToolSurface([jsTool(), { name: 'js_reset' }, { name: 'turn_ended' }]);
  assert.deepEqual(ok.map(r => [r.id, r.status]), [['tool-surface', 'pass'], ['js-description', 'pass']]);
  assert.match(checkToolSurface([jsTool(), { name: 'js_reset' }])[0].reason, /no turn_ended/);
  assert.match(checkToolSurface([jsTool({ code: { type: 'string' } }), { name: 'turn_ended' }])[0].reason, /timeout_ms.*title/);
  const changed = checkToolSurface([{ ...jsTool(), description: 'A new description.' }, { name: 'turn_ended' }]);
  assert.deepEqual(changed.map(r => r.status), ['pass', 'warn']);
  assert.equal(checkToolSurface(undefined)[0].status, 'fail');
});

test('the policy rewrite applies to the recorded policy and warns when the engine changes it', () => {
  assert.deepEqual(checkPolicyRewrite([docs(), 'Invalid app: x']).map(r => r.status), ['pass']);
  const changed = checkPolicyRewrite([docs(ts, policy.replace('Delete data', 'Remove data'))]);
  assert.equal(changed[0].status, 'warn');
  assert.match(changed[0].reason, /ask again/);
  assert.equal(checkPolicyRewrite(['Invalid app: x'])[0].status, 'warn');
  assert.match(checkPolicyRewrite(['Intro\n## Computer Use\n' + policy])[0].reason, /no result item starts/);
});

test('the probe code runs as written and its shapes pass the check', async () => {
  const written = [];
  const apps = [{ id: 'com.apple.calculator', displayName: 'Calculator', isRunning: true, windows: [{ id: 3, app: 'Calculator', title: 'Calculator' }] }, { id: 'com.apple.TextEdit' }];
  const cua = Object.fromEntries(CUA_METHODS.map(name => [name, async () => undefined]));
  cua.getState = async () => ({ apps, browsers: [] });
  cua.listApps = async () => apps;
  const nodeRepl = { write: text => written.push(text), emitImage: () => {} };
  await new (Object.getPrototypeOf(async () => {}).constructor)('cua', 'nodeRepl', PROBE_CODE)(cua, nodeRepl);
  const probe = parseProbe(written.join('\n'));
  assert.equal(probe.apps['[]'].windows['[]'].title, 'string');
  // Values never leave the engine: only key names and types.
  assert.ok(!JSON.stringify(probe).includes('Calculator'));
  assert.equal(checkReplProbe(probe)[0].status, 'pass');
  delete cua.getTab;
  written.length = 0;
  await new (Object.getPrototypeOf(async () => {}).constructor)('cua', 'nodeRepl', PROBE_CODE)(cua, nodeRepl);
  assert.match(checkReplProbe(parseProbe(written.join('\n')))[0].reason, /cua\.getTab is undefined/);
  assert.equal(checkReplProbe(undefined)[0].status, 'fail');
  assert.match(checkReplProbe({ ...probe, apps: { '[]': { id: 'string', windows: { '[]': { id: 'string' } } } } })[0].reason, /windows lack/);
});

test('every cua method sleight calls is in the contract', () => {
  const lib = fileURLToPath(new URL('../plugins/sleight/lib/', import.meta.url));
  const files = readdirSync(lib, { recursive: true }).filter(name => /\.m?js$/.test(name));
  const called = new Set();
  for (const name of files) for (const match of readFileSync(join(lib, name), 'utf8').matchAll(/\bcua\.([A-Za-z_]\w*)/g)) called.add(match[1]);
  const listed = new Set([...CUA_METHODS, ...MATCHED_ONLY]);
  assert.deepEqual([...called].filter(name => !listed.has(name)), []);
  assert.deepEqual(API_MEMBERS.cua, CUA_METHODS);
});
