import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFillFields } from '../plugins/sleight/lib/direct-browser/fill.mjs';

for (const submit of [true, false]) for (const boundary of ['framenavigated', 'dialog', 'popup', 'close']) test(`${submit ? 'submit delegation' : 'authority consumption'} stops when ${boundary} arrives during final inspection`, async () => {
  const page = new EventEmitter(); let classified = 0, dispatched = 0, authorized = 0;
  const state = { snapshotNo: 1, submitUnconfirmed: false };
  const locator = { async evaluate(fn) {
    if (fn.name === 'inspect') return { kind: 'check', type: '', connected: true, checked: false, readonly: false };
    assert.equal(fn.name, 'inspectTarget');
    if (++classified === 2) page.emit(boundary);
    return { tag: 'button', kind: 'button', connected: true, visible: true, enabled: true,
      payment: false, formPayment: false, form: true, submit };
  } };
  page.getByRef = () => locator;
  const fill = createFillFields({ inspectElement: function inspectTarget() {}, check: () => { authorized++; return 'allow'; },
    runSteps: async () => { dispatched++; return { lines: ['1 click e1: input sent'], stoppedAt: null }; } });
  const result = await fill({ page, state }, [{ ref: 'e1', value: true }, { ref: 'e2', value: 'untouched' }], {}, {});
  assert.equal(authorized, 0, 'the boundary must not consume authority');
  assert.equal(dispatched, 0, JSON.stringify({ dispatched, result }));
  assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
  assert.match(result.stopped, /new document|dialog|popup|tab closed/);
  assert.equal(state.actionPending, undefined);
  assert.equal(state.submitUnconfirmed, false);
});

for (const boundary of ['framenavigated', 'dialog', 'popup', 'close']) test(`upload delegation stops when ${boundary} arrives during the prior inspection`, async () => {
  const page = new EventEmitter(); let dispatched = 0, authorized = 0;
  const state = { snapshotNo: 1, submitUnconfirmed: false };
  page.getByRef = () => ({ async evaluate(fn) {
    if (fn.name === 'inspect') return { kind: 'file', connected: true, readonly: false };
    assert.equal(fn.name, 'inspectTarget'); page.emit(boundary);
    return { tag: 'input', kind: 'file', connected: true, visible: true, enabled: true };
  } });
  const fill = createFillFields({ inspectElement: function inspectTarget() {}, check: () => { authorized++; return 'allow'; },
    runSteps: async () => { dispatched++; return { lines: ['1 upload: input sent'], stoppedAt: null }; } });
  const result = await fill({ page, state }, [{ ref: 'e1', value: ['/fixture/upload.txt'] }, { ref: 'e2', value: 'untouched' }], {}, {});
  assert.equal(dispatched, 0); assert.equal(authorized, 0);
  assert.deepEqual(result.rows.map(row => row.status), ['failed', 'not reached']);
  assert.match(result.stopped, /new document|dialog|popup|tab closed/);
});
