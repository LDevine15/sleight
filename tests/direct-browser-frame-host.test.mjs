import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createScopedAdapter } from '../plugins/sleight/lib/direct-browser/scoped-adapter.mjs';
import { fixedFormInspectors } from '../plugins/sleight/lib/direct-browser/forms.mjs';
import { formFixture } from './direct-browser-safety-review-fixture.mjs';

const hostTags = ['iframe', 'frame', 'object', 'embed'];
const inputs = [{ op: 'click' }, { op: 'key', key: 'Enter' }, { op: 'scroll', dy: 100 }, { op: 'hover' },
  { op: 'select', value: 'Example' }];
for (const tag of hostTags) for (const input of inputs) test(`${tag} host refuses ${input.op} before every actuator`, async t => {
  const f = formFixture(t, [{ kind: 'custom', tag, frameLocal: false, submit: false, payment: false }]);
  const result = await f.form.act({ ...input, ref: f.handles[0] }, { operation: tag + '-' + input.op });
  assert.equal(f.calls.some(call => call.method.startsWith('Input.') || call.operation?.kind !== 'read'), false,
    JSON.stringify({ result, calls: f.calls.map(call => ({ method: call.method, kind: call.operation?.kind })) }));
  assert.equal(result.effect, 'none'); assert.equal(result.completed, 0); assert.equal(result.untouched, 1);
  assert.equal(result.observation.code, 'FRAME_UNQUALIFIED');
});
for (const tag of hostTags) test(`${tag} host refuses boolean fill before custom descendant preparation`, async t => {
  const f = formFixture(t, [{ kind: 'custom', tag, frameLocal: false }]);
  const result = await f.form.fill([{ ref: f.handles[0], value: true }], { operation: tag + '-fill' });
  assert.equal(result.effect, 'none'); assert.equal(result.completed, 0); assert.equal(result.untouched, 1);
  assert.equal(result.observation.code, 'FRAME_UNQUALIFIED');
  assert.equal(f.calls.some(call => call.method.startsWith('Input.') || call.operation?.kind !== 'read'), false);
});
for (const tag of hostTags) test(`${tag} metadata and visibility waits remain read-only`, async t => {
  const lease = { target: 'target', cdpSessionId: 'page', frame: 'parent', origin: 'https://fixture.invalid', document: 1, epoch: 1 };
  const adapter = createScopedAdapter({ helpers: {}, checkLease: () => true,
    nodeBinding: id => [1, 2].includes(id) ? { ...lease, backendNodeId: id } : null,
    session: { sessionId: 'root', on() {}, off() {}, async send(method) {
      assert.equal(method, 'DOM.getDocument');
      return { root: { backendNodeId: 1, nodeType: 9, children: [{ backendNodeId: 2, nodeType: 1,
        localName: tag, frameId: ['iframe', 'frame'].includes(tag) ? 'child' : 'parent',
        contentDocument: { backendNodeId: 99, frameId: 'child' } }] } };
    } } });
  t.after(() => adapter.disconnect());
  const read = await adapter.forLease(lease).send('DOM.getDocument', { depth: 1, pierce: false });
  assert.equal(read.root.children[0].localName, tag); assert.equal(read.root.children[0].contentDocument, undefined);
  const f = formFixture(t, [{ kind: 'custom', tag, frameLocal: false }]);
  const waited = await f.form.act({ op: 'wait', ref: f.handles[0], state: 'visible' }, { operation: 'wait-' + tag });
  assert.equal(waited.effect, 'verified'); assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false);
});

function parentState(tag) {
  return runInNewContext(`
    class Element {
      localName='div'; isConnected=true; textContent=''; parentNode=null;
      getAttribute() { return null; }
      getBoundingClientRect() { return {x:1,y:2,width:30,height:20}; }
      matches() { return false; } closest() { return null; } getRootNode() { return document; }
    }
    class HTMLInputElement {} class HTMLTextAreaElement {} class HTMLSelectElement {}
    class HTMLButtonElement {} class HTMLOptionElement {}
    const window={}; window.top=window;
    const parent=new Element(), child=new Element(); child.localName=tag; child.parentNode=parent;
    const document={activeElement:null,elementFromPoint:()=>child};
    const getComputedStyle=()=>({visibility:'visible',display:'block'});
    eval('('+source+')').call(parent,'');
  `, { tag, source: fixedFormInspectors['form-state'].source });
}
for (const tag of hostTags) test(`a parent container cannot send input through its ${tag} center hit`, async t => {
  const state = parentState(tag);
  assert.equal(state.tag, 'div'); assert.equal(state.frameLocal, false);
  const f = formFixture(t, [state]);
  const result = await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'parent-' + tag });
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false, JSON.stringify(result));
  assert.equal(result.effect, 'none'); assert.equal(result.observation.code, 'FRAME_UNQUALIFIED');
});
test('an ordinary parent control retains its verified click and typed select', async t => {
  const f = formFixture(t, [{ kind: 'checkbox', tag: 'input', frameLocal: false, value: false },
    { kind: 'select', tag: 'select', frameLocal: false, value: '', options: [{ value: 'ja', label: 'Japan', disabled: false }] }]);
  const clicked = await f.form.act({ op: 'click', ref: f.handles[0] }, { operation: 'ordinary-click' });
  assert.equal(clicked.effect, 'verified'); assert.equal(f.states.get(2).value, true);
  const selected = await f.form.act({ op: 'select', ref: f.handles[1], value: 'Japan' }, { operation: 'ordinary-select' });
  assert.equal(selected.effect, 'verified'); assert.equal(f.states.get(3).value, 'ja');
});
test('semantic reorder keeps parent-owned items even when the list center hits an embedded preview', async t => {
  const f = formFixture(t, [{ kind: 'reorder', tag: 'ol', frameLocal: false, frameInput: true,
    items: ['B', 'A'], value: ['B', 'A'] }]);
  const result = await f.form.fill([{ ref: f.handles[0], value: ['A', 'B'] }], { operation: 'preview-order' });
  assert.equal(result.effect, 'verified', JSON.stringify(result)); assert.equal(result.completed, 1);
  assert.deepEqual(f.states.get(2).value, ['A', 'B']);
  assert.equal(f.calls.some(call => call.method.startsWith('Input.')), false);
  assert.ok(f.calls.some(call => call.operation?.kind === 'select'));
});
