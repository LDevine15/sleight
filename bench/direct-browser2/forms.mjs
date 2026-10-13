// BP2-7 form coordinator. Independently written from the v2/v1 form design.
// Design references: FowlBrowser 8b689249 (MIT), mcp/src/tools.mjs fill_form;
// Playwright e8149b825 (Apache-2.0), tools/backend/form.ts. No source copied.
// The trusted BP2-5/6 adapter owns read policy, protected proof, actionability and
// scoped CDP sessions (send/on/off/sessionId). The broker owns dedupe/queues and
// durable unknown receipts. This module never exposes CDP or grants to the model.
// dispatch(intent, fence) MUST await fence immediately before sending input,
// without another asynchronous preparation step. Missing adapters fail closed.

const identityKeys = ['browserIncarnation', 'brokerEpoch', 'clientSession', 'turn',
  'leaseGeneration', 'target', 'frame', 'document', 'origin'];
const failures = new WeakMap(), cleanupRecovery = new WeakMap();
function fail(reason) {
  const error = new Error(reason);
  failures.set(error, reason);
  throw error;
}

// Trusted broker handle, kept in memory outside model serialization. Retrying
// this handle performs only cleanup, never input or the rest of a form batch.
export async function retryFormCleanup(handle, timeoutMs = 3000) {
  const record = cleanupRecovery.get(handle);
  const pending = () => ({ cleaned: false, cleanupRequired: true });
  if (!record || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return pending();
  if (record.cleaned) {
    cleanupRecovery.delete(handle);
    return { cleaned: true, cleanupRequired: false };
  }
  if (record.running) return pending();
  record.running = true;
  const work = Promise.resolve().then(record.cleanup);
  work.then(() => { record.running = false; record.cleaned = true; }, () => { record.running = false; });
  let timer;
  try {
    await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('cleanup deadline')), timeoutMs);
    })]);
    cleanupRecovery.delete(handle);
    return { cleaned: true, cleanupRequired: false };
  } catch { return pending(); }
  finally { clearTimeout(timer); }
}
function sameIdentity(actual, expected) {
  return identityKeys.every(k => expected?.[k] !== undefined && actual?.[k] === expected[k]);
}
function usable(observation, identity, ref) {
  if (!sameIdentity(observation, identity) || observation.ref !== ref) fail('stale-ref');
  if (!['http:', 'https:'].includes(new URL(observation.origin).protocol)) fail('unsupported-origin');
  if (!Number.isInteger(observation.node) || observation.node <= 0) fail('missing-node');
  if (observation.visible !== true) fail('hidden');
  if (observation.enabled !== true) fail('disabled');
  if (!['native', 'ax', 'page-reported'].includes(observation.source)) fail('unreadable-state');
}
function optionsValue(o, value) {
  const wanted = Array.isArray(value) ? value : [value];
  if (!o.multiple && wanted.length !== 1) fail('single-select');
  if (!Array.isArray(o.options) || o.optionsComplete === false || wanted.some(v => typeof v !== 'string'))
    fail('incomplete-options');
  const values = wanted.map(v => {
    const exact = o.options.filter(x => x.value === v);
    const matches = exact.length ? exact : o.options.filter(x => x.label === v);
    if (matches.length !== 1 || matches[0].disabled) fail('ambiguous-or-disabled-option');
    return matches[0].value;
  });
  if (new Set(values).size !== values.length) fail('duplicate-option');
  return o.multiple ? values : values[0];
}
function dateValue(intent) {
  const value = intent && typeof intent === 'object' && !Array.isArray(intent) ? intent.date : undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('date-needs-iso-day');
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail('invalid-date');
  return value;
}
function plan(o, value) {
  let action, normalized;
  switch (o.kind) {
    case 'text':
      if (typeof value !== 'string' || o.readonly) fail('not-editable-text');
      action = 'fill'; normalized = value; break;
    case 'checkbox': case 'radio': case 'switch':
      if (typeof value !== 'boolean' || typeof o.value !== 'boolean' || o.readonly) fail('unknown-checked-state');
      if (o.kind === 'switch' && !o.strategies?.includes('setChecked')) fail('missing-switch-semantics');
      action = 'setChecked'; normalized = value; break;
    case 'select': case 'listbox':
      if (o.readonly || (o.kind === 'listbox' && !o.strategies?.includes('chooseOptions'))) fail('missing-list-semantics');
      action = o.kind === 'select' ? 'select' : 'chooseOptions'; normalized = optionsValue(o, value); break;
    case 'date':
      normalized = dateValue(value); action = o.readonly ? 'pickDate' : 'fill';
      if (o.readonly && !o.strategies?.includes(action)) fail('picker-needs-observation');
      if ((o.min && normalized < o.min) || (o.max && normalized > o.max)) fail('date-out-of-range');
      break;
    case 'number': case 'range': {
      if (typeof value !== 'number' || !Number.isFinite(value) || o.readonly) fail('number-needs-finite-number');
      if ((o.min !== undefined && value < o.min) || (o.max !== undefined && value > o.max)) fail('number-out-of-range');
      if (o.step && o.step !== 'any') {
        const steps = (value - (o.min ?? 0)) / o.step;
        if (!Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > 1e-9) fail('number-step-mismatch');
      }
      if (o.kind === 'range' && !o.strategies?.includes('fill')) fail('range-needs-qualified-strategy');
      action = 'fill'; normalized = value; break;
    }
    case 'file':
      if (!value?.fileCapability || o.readonly) fail('file-capability-required');
      action = 'setFiles'; normalized = value.fileCapability; break;
    default: fail('unsupported-field');
  }
  return { action, value: normalized };
}
function equal(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length &&
    new Set(actual).size === actual.length && expected.every(v => actual.includes(v));
  return actual === expected;
}
function fingerprint(o) {
  // Page strings are private comparison data, never serialized in receipts.
  return JSON.stringify([o.node, o.kind, o.readonly, o.multiple, o.min, o.max, o.step, o.options, o.strategies, o.protected]);
}
const safeReasons = new Set(['stale-ref', 'unsupported-origin', 'missing-node', 'hidden', 'disabled', 'unreadable-state',
  'single-select', 'incomplete-options', 'ambiguous-or-disabled-option', 'duplicate-option', 'date-needs-iso-day',
  'invalid-date', 'not-editable-text', 'unknown-checked-state', 'missing-switch-semantics', 'missing-list-semantics',
  'picker-needs-observation', 'date-out-of-range', 'number-needs-finite-number', 'number-out-of-range',
  'number-step-mismatch', 'range-needs-qualified-strategy', 'file-capability-required', 'unsupported-field',
  'authority-required', 'field-changed', 'file-changed', 'adapter-missing']);

export async function fillForm(adapter, request) {
  if (!request || typeof request.operation !== 'string' || !Array.isArray(request.fields) ||
      request.fields.length > 100 || request.fields.some(f => typeof f?.ref !== 'string' || !/^r[\w-]{1,64}$/.test(f.ref)) ||
      new Set(request.fields.map(f => f.ref)).size !== request.fields.length)
    throw new Error('Invalid form request');
  // Capture input: a caller cannot change an authorized value during an await.
  const fields = request.fields.map(f => ({ ref: f.ref, value: Array.isArray(f.value) ? [...f.value] :
    f.value && typeof f.value === 'object' ? { ...f.value } : f.value }));
  const identity = Object.freeze({ ...request.identity });
  const budget = request.timeoutMs ?? 3000;
  if (!Number.isInteger(budget) || budget < 1 || budget > 30_000) throw new Error('Invalid form deadline');
  const deadline = Date.now() + budget;
  let finished = false;
  async function bounded(fn) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), Math.max(0, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  }
  const receipt = { operation: request.operation, phase: 'prepared', effect: 'none', completed: 0,
    fields: fields.map(f => ({ ref: f.ref, status: 'notAttempted', reason: 'untouched-suffix' })) };
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]; let dispatched = false, sent = false, intent, upload;
    try {
      if (!adapter || ['observe', 'authorize', 'dispatch', 'waitForDependencies'].some(k => typeof adapter[k] !== 'function'))
        fail('adapter-missing');
      const before = await bounded(() => adapter.observe(f.ref, { identity }));
      usable(before, identity, f.ref);
      const p = plan(before, f.value);
      intent = { ...identity, operation: `${request.operation}:${i}`, ref: f.ref, node: before.node,
        action: p.action, value: p.value, protected: before.protected === true, transmission: true };
      // This is exact data authority before any oninput/autosave can receive it.
      if ((await bounded(() => adapter.authorize(intent)))?.verdict !== 'allow') fail('authority-required');
      if (!before.protected && p.action !== 'setFiles' && equal(before.value, p.value)) {
        receipt.fields[i] = { ref: f.ref, status: 'unchanged', reason: 'observed-current-state' };
        receipt.completed++;
        await bounded(() => adapter.waitForDependencies(intent));
        continue;
      }
      let fileSnapshot;
      const fence = async () => {
        if (sent || finished || Date.now() >= deadline) fail('field-changed');
        const fresh = await bounded(() => adapter.observe(f.ref, { identity }));
        usable(fresh, identity, f.ref);
        if (fingerprint(fresh) !== fingerprint(before)) fail('field-changed');
        if ((await bounded(() => adapter.authorize(intent)))?.verdict !== 'allow') fail('authority-required');
        if (finished || Date.now() >= deadline) fail('field-changed');
        if (p.action === 'setFiles') {
          if (!adapter.files) fail('file-capability-required');
          upload = adapter.files.stage(p.value, intent);
          intent.paths = upload.paths;
          // A path-backed browser File can outlive this operation. Transfer
          // approved bytes into browser-owned File storage before returning.
          intent.filePayloads = upload.payloads;
          fileSnapshot = upload.snapshot;
        }
        sent = true; dispatched = true;
      };
      await bounded(() => adapter.dispatch(intent, fence));
      if (!sent) fail('adapter-missing');
      receipt.phase = 'dispatched'; receipt.effect = 'unknown';
      const after = await bounded(() => adapter.observe(f.ref, { identity }));
      usable(after, identity, f.ref);
      if (fingerprint(after) !== fingerprint(before)) fail('field-changed');
      let matched, source = after.source;
      if (before.protected) {
        const proof = await bounded(() => adapter.proveProtected?.(intent));
        matched = proof?.matched === true; source = proof?.source;
      } else if (p.action === 'setFiles') {
        matched = adapter.files.unchanged(fileSnapshot) && Array.isArray(after.files) &&
          after.files.length === intent.paths.length && after.files.every((file, index) =>
            file.name === intent.paths[index].split('/').at(-1) && file.size === Number(fileSnapshot[index].signature.split(':')[2]));
      } else matched = equal(after.value, p.value) && after.valid !== false;
      receipt.phase = 'observed';
      if (!matched || !['native', 'ax'].includes(source)) {
        receipt.fields[i] = { ref: f.ref, status: 'unverifiable', reason: matched ? 'page-reported-only' : 'postcondition-unproved',
          phase: 'observed', effect: 'unknown' }; break;
      }
      receipt.fields[i] = { ref: f.ref, status: before.protected ? 'protected' : 'verified',
        reason: before.protected ? 'operation-bound-proof' : 'observed-postcondition', phase: 'verified', effect: 'verified' };
      receipt.completed++; receipt.effect = 'verified';
      await bounded(() => adapter.waitForDependencies(intent));
    } catch (error) {
      if (['verified', 'protected', 'unchanged'].includes(receipt.fields[i].status)) {
        // The dependency barrier failed after proof. Keep that proof and stop
        // before touching another field, rather than rewriting history.
        receipt.phase = 'observed';
        receipt.effect = receipt.effect === 'none' ? 'none' : 'verified';
        receipt.pending = 'dependencies';
        break;
      }
      receipt.fields[i] = { ref: f.ref, status: dispatched ? 'unverifiable' : 'blocked',
        reason: safeReasons.has(failures.get(error)) ? failures.get(error) : 'observation-or-dispatch-failed',
        phase: dispatched ? 'dispatched' : 'prepared', effect: dispatched ? 'unknown' : 'none' };
      receipt.phase = dispatched ? 'dispatched' : 'prepared';
      receipt.effect = dispatched ? 'unknown' : receipt.completed ? 'verified' : 'none';
      break;
    } finally {
      // Release transient expected values; trusted adapters must do likewise.
      if (intent) { intent.value = undefined; intent.paths = undefined; intent.filePayloads = undefined; }
      if (upload) {
        const record = { cleanup: () => upload.cleanup(), running: true, cleaned: false };
        const work = Promise.resolve().then(record.cleanup);
        work.then(() => { record.running = false; record.cleaned = true; }, () => { record.running = false; });
        try { await bounded(() => work); }
        catch {
          const handle = Object.freeze({});
          cleanupRecovery.set(handle, record);
          receipt.cleanupRequired = true;
          receipt.pending = 'cleanup';
          receipt.cleanupRecovery = handle;
        }
      }
      f.value = undefined;
    }
    if (receipt.cleanupRequired) break;
  }
  finished = true;
  if (receipt.completed === fields.length && !receipt.cleanupRequired) receipt.phase = 'verified';
  return receipt;
}
