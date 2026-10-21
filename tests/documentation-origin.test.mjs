import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as module from '../plugins/sleight/lib/documentation-origin.mjs';
const docs = readFileSync(new URL('fixtures/native-api-docs.txt', import.meta.url), 'utf8');
const item = () => ({ type: 'text', text: docs });
const request = (id = 'private') => ({ id, method: 'tools/call', params: { name: 'js', arguments: { code: 'fixed setup' } } });
const reply = (id = 'private') => ({ id, result: { content: [item(), { type: 'text', text: '[sleight:guard-ready]\n' }] } });
function fixture() {
  assert.equal(typeof module.documentationOrigin, 'function', 'owned capture must exist');
  const origin = module.documentationOrigin();
  const req = request(); origin.begin(req, 'kernel', { appFree: true }); origin.sent(req, 'kernel');
  const msg = reply(); origin.reply(msg, 'kernel');
  return { origin, msg };
}
test('isolated ownership removes exactly 201 characters, preserving outside bytes and clones', () => {
  const { origin, msg } = fixture(), original = msg.result.content[0];
  const projected = origin.project([{ ...original }], { context: 'kernel' });
  assert.equal(docs.length - projected.content[0].text.length, 201);
  const fence = /```typescript\n([\s\S]*?)\n```/.exec(docs);
  const at = docs.indexOf(fence[1]);
  assert.equal(projected.content[0].text.slice(0, at), docs.slice(0, at));
  assert.ok(projected.content[0].text.endsWith(docs.slice(at + fence[1].length)));
  assert.equal(original.text, docs);
  assert.deepEqual(origin.project([item()], { context: 'kernel' }).content, [item()]);
  assert.deepEqual(origin.project([JSON.parse(JSON.stringify(original))], { context: 'kernel' }).content, [item()]);
});
test('string metadata, exact printed copies, changed declarations and unknown shapes stay whole', () => {
  const { origin, msg } = fixture();
  for (const c of [item(), { ...item(), _meta: { source: 'cua.core' }, trusted: true },
    { ...msg.result.content[0], text: docs.replace('type Vec2', 'type Vec3') }]) {
    assert.equal(origin.project([c], { context: 'kernel' }).content[0].text, c.text);
  }
});
test('only a successful complete owned response can acquire origin', () => {
  for (const change of [m => { m.error = { message: 'failed' }; }, m => { m.result.isError = true; },
    m => { m.result.content.push({ type: 'image', data: 'AA==' }); }, m => { m.result.truncated = true; },
    m => { m.result._meta = { truncated: true }; },
    m => { m.result.content.push({ type: 'text', text: 'unexpected output' }); }]) {
    const origin = module.documentationOrigin(), req = request();
    origin.begin(req, 'kernel', { appFree: true }); origin.sent(req, 'kernel');
    const msg = reply(); change(msg); origin.reply(msg, 'kernel');
    assert.equal(origin.project([msg.result.content[0]], { context: 'kernel' }).content[0].text, docs);
  }
});
test('prior and concurrent engine tools, reset, context change, prompt and expiration invalidate capture', () => {
  for (const mode of ['prior', 'concurrent-js', 'concurrent-file', 'reset', 'context', 'prompt', 'expired', 'not-app-free']) {
    const origin = module.documentationOrigin(), req = request();
    if (mode === 'prior') origin.sent(request('earlier'), 'kernel');
    origin.begin(req, 'kernel', { appFree: mode !== 'not-app-free' }); origin.sent(req, 'kernel');
    if (mode.startsWith('concurrent')) origin.sent({ ...request('other'), params: { name: mode === 'concurrent-js' ? 'js' : 'open_file' } }, 'kernel');
    if (['reset', 'expired', 'prompt'].includes(mode)) origin.invalidate();
    const msg = reply(); origin.reply(msg, mode === 'context' ? 'other' : 'kernel');
    assert.equal(origin.project([msg.result.content[0]], { context: 'kernel' }).content[0].text, docs, mode);
  }
});
test('duplicate and late responses never acquire a second marker', () => {
  const { origin } = fixture(), duplicate = reply(); origin.reply(duplicate, 'kernel');
  assert.equal(origin.project(duplicate.result.content, { context: 'kernel' }).content[0].text, docs);
});
test('full docs, error delivery and a different context preserve the whole reference', () => {
  const { origin, msg } = fixture();
  for (const options of [{ full: true }, { isError: true }, { context: 'different' }]) {
    assert.equal(origin.project(msg.result.content, { context: 'kernel', ...options }).content[0].text, docs);
  }
});
test('write receipts consume only delivered projections, failed writes and cap failures retain full guidance', () => {
  const { origin, msg } = fixture();
  const first = origin.project(msg.result.content, { context: 'kernel' });
  assert.equal(origin.settle(first, { content: first.content }, new Error('write failed'))[0].text, docs);
  const retry = origin.project(msg.result.content, { context: 'kernel' });
  assert.equal(docs.length - retry.content[0].text.length, 201);
  assert.equal(origin.settle(retry, { isError: true, content: [] })[0].text, docs);
  const delivered = origin.project(msg.result.content, { context: 'kernel' });
  assert.deepEqual(origin.settle(delivered, { content: delivered.content }), []);
  assert.equal(origin.project(msg.result.content, { context: 'kernel' }).content[0].text, docs);
});
test('concurrent deliveries reserve one projection and retain a full copy for failed caps', () => {
  const { origin, msg } = fixture();
  const first = origin.project(msg.result.content, { context: 'kernel' });
  assert.equal(origin.full(first.content[0]).text, docs);
  assert.equal(origin.project(msg.result.content, { context: 'kernel' }).content[0].text, docs);
  origin.settle(first, { content: [] });
  assert.equal(docs.length - origin.project(msg.result.content, { context: 'kernel' }).content[0].text.length, 201);
});
test('observed execution timing metadata permits origin without changing its bytes', () => {
  for (const duration of [0, 1.25]) {
    const origin = module.documentationOrigin(), req = request(), msg = reply();
    const meta = { 'codex/nodeReplExecutionDurationMs': duration }; msg.result._meta = meta;
    const wire = JSON.stringify(msg.result);
    origin.begin(req, 'kernel', { appFree: true }); origin.sent(req, 'kernel'); origin.reply(msg, 'kernel');
    assert.equal(JSON.stringify(msg.result), wire);
    assert.equal(msg.result._meta, meta);
    assert.equal(docs.length - origin.project(msg.result.content, { context: 'kernel' }).content[0].text.length, 201);
  }
});
test('unknown, nonfinite and malformed timing metadata never establish origin', () => {
  const key = 'codex/nodeReplExecutionDurationMs';
  for (const meta of [null, [], 3, 'timing', new Date(), { [key]: -1 }, { [key]: NaN }, { [key]: Infinity },
    { [key]: -Infinity }, { [key]: undefined }, { [key]: null }, { [key]: '0' }, { [key]: {} }, { [key]: [] },
    { [key]: 0, extra: true }, Object.assign(Object.create({ inherited: true }), { [key]: 0 })]) {
    const origin = module.documentationOrigin(), req = request(), msg = reply(); msg.result._meta = meta;
    origin.begin(req, 'kernel', { appFree: true }); origin.sent(req, 'kernel'); origin.reply(msg, 'kernel');
    assert.equal(origin.project(msg.result.content, { context: 'kernel' }).content[0].text, docs);
  }
});
test('the observed Notes heading keeps its entire body and policy suffix byte for byte', () => {
  const notes = '\n## Notes\n\nLiteral note: `a  b`.\n  Preserve indentation and Unicode: café.\n\n';
  const full = docs.replace('\n# Computer Use Confirmations Policy', notes + '\n# Computer Use Confirmations Policy');
  const origin = module.documentationOrigin(), req = request(), msg = reply();
  msg.result.content[0].text = full;
  msg.result._meta = { 'codex/nodeReplExecutionDurationMs': 1.25 };
  origin.begin(req, 'kernel', { appFree: true }); origin.sent(req, 'kernel'); origin.reply(msg, 'kernel');
  const projected = origin.project(msg.result.content, { context: 'kernel' }).content[0].text;
  assert.equal(full.length - projected.length, 201);
  assert.equal(projected.slice(projected.indexOf('\n## Notes\n')), full.slice(full.indexOf('\n## Notes\n')));
});
test('observed Notes acceptance does not admit other unknown heading names', () => {
  for (const heading of ['Note', 'Notes extra', 'Instructions']) {
    const full = docs.replace('\n# Computer Use Confirmations Policy', `\n## ${heading}\n\nKeep full output.\n\n# Computer Use Confirmations Policy`);
    const origin = module.documentationOrigin(), req = request(), msg = reply(); msg.result.content[0].text = full;
    origin.begin(req, 'kernel', { appFree: true }); origin.sent(req, 'kernel'); origin.reply(msg, 'kernel');
    assert.equal(origin.project(msg.result.content, { context: 'kernel' }).content[0].text, full);
  }
});
