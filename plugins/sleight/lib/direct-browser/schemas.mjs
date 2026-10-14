// Closed four-tool schema and JSON validator, internal BP-8 contract.
import { BrowserFailure } from './errors.mjs';

const handle = prefix => ({ type: 'string', pattern: '^' + prefix + '[A-Za-z0-9_-]{1,63}$' });
const text = { type: 'string', maxLength: 65536 };
const timeout = { type: 'integer', minimum: 1, maximum: 30000 };
const object = (properties, required = Object.keys(properties), extra = {}) => ({
  type: 'object', properties, required, additionalProperties: false, ...extra,
});
const strings = { type: 'array', maxItems: 100, uniqueItems: true, items: text };
const value = { oneOf: [text, { type: 'boolean' }, { type: 'number' }, strings,
  object({ date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }),
  object({ files: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: handle('f') } })] };
const expect = object({ ref: handle('r'), state: { enum: ['visible', 'hidden', 'enabled', 'disabled', 'changed'] } });
const actionShapes = [
  ['click', { ref: handle('r') }], ['hover', { ref: handle('r') }],
  ['key', { ref: handle('r'), key: { ...text, minLength: 1 } }],
  ['select', { ref: handle('r'), value: { oneOf: [text, strings] } }],
  ['scroll', { ref: handle('r'), dx: { type: 'number' }, dy: { type: 'number' } }],
  ['drag', { ref: handle('r'), to: handle('r') }],
  ['wait', { ref: handle('r'), state: { enum: ['visible', 'hidden', 'enabled', 'disabled'] } }],
  ['dialog', { dialog: handle('d'), action: { enum: ['accept', 'dismiss'] }, value: text }],
].map(([op, props]) => object({ op: { const: op }, ...props, expect },
  ['op', ...Object.keys(props).filter(key => op === 'scroll' ? !['dx', 'dy'].includes(key) : op !== 'dialog' || key !== 'value')],
  op === 'scroll' ? { anyOf: [{ required: ['dx'] }, { required: ['dy'] }] } : {}));
const action = { oneOf: actionShapes };
const definitions = [
  { name: 'browser_open', description: 'Open in the selected browser in the background. Returns a session tab handle and automatic proof; no silent transport fallback.',
    inputSchema: object({ browser: handle('b'), url: { type: 'string', format: 'uri', pattern: '^https?://' }, timeout_ms: timeout }, ['browser', 'url']) },
  { name: 'browser_read', description: 'Read this session tab, optionally at an observed scope ref. Returns bounded untrusted state and fresh refs; protected values stay redacted.',
    inputSchema: object({ tab: handle('t'), scope: handle('r'), max_bytes: { type: 'integer', minimum: 1024, maximum: 64000 }, timeout_ms: timeout }, ['tab']) },
  { name: 'browser_act', description: 'Act on fresh refs: one op, or op batch with up to 16 sequential steps. Automatic proof; stops at stale state, payment confirmation, dialog or unknown effect. Read before retrying an uncertain submit.',
    // Messages API accepts one object at the top level. Exact per-op rules stay
    // in validateCall; a batch is normalized to P1/P2's closed steps grammar.
    inputSchema: object({ tab: handle('t'), ...Object.assign({}, ...actionShapes.map(shape => shape.properties)),
      op: { type: 'string', enum: [...actionShapes.map(shape => shape.properties.op.const), 'batch'] },
      value: { oneOf: [text, strings] }, steps: { type: 'array', minItems: 1, maxItems: 16, items: action }, timeout_ms: timeout }, ['tab', 'op']) },
  { name: 'browser_fill', description: 'Fill 1 to 50 observed fields in order, without submit. Values: text, boolean, number, string array, {date:YYYY-MM-DD}, {files:[handle]}. Per-field proof; stops before the untouched suffix.',
    inputSchema: object({ tab: handle('t'), fields: { type: 'array', minItems: 1, maxItems: 50,
      items: object({ ref: handle('r'), value }) }, timeout_ms: timeout }, ['tab', 'fields']) },
];
export function browserTools() { return structuredClone(definitions); }
const invalid = () => { throw new BrowserFailure('INVALID_ARGUMENT', { phase: 'validate', effect: 'none' }); };
// Tool inputs are JSON data. Inspect descriptors before reading any property.
function copyJSON(input, depth = 0) {
  if (depth > 8) invalid();
  if (input === null || ['string', 'boolean'].includes(typeof input)) return input;
  if (typeof input === 'number') { if (!Number.isFinite(input)) invalid(); return input; }
  if (!input || typeof input !== 'object') invalid();
  if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]))) invalid();
  if (Array.isArray(input)) {
    if (Object.keys(descriptors).length !== input.length + 1 || input.length > 100) invalid();
    return Object.freeze(Array.from({ length: input.length }, (_, i) => copyJSON(descriptors[i]?.value, depth + 1)));
  }
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, copyJSON(descriptor.value, depth + 1)])));
}
function keys(input, allowed, required = allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) invalid();
}
function isHandle(input, prefix) { return typeof input === 'string' && new RegExp(handle(prefix).pattern).test(input); }
function checkHandle(input, prefix) { if (!isHandle(input, prefix)) invalid(); }
function checkText(input, nonempty = false) {
  if (typeof input !== 'string' || input.length > 65536 || nonempty && !input.length) invalid();
}
function checkStrings(input) {
  if (!Array.isArray(input) || input.length > 100 || new Set(input).size !== input.length) invalid();
  input.forEach(item => checkText(item));
}
function checkValue(input) {
  if (typeof input === 'string') return checkText(input);
  if (typeof input === 'boolean' || typeof input === 'number' && Number.isFinite(input)) return;
  if (Array.isArray(input)) return checkStrings(input);
  if (input && Object.hasOwn(input, 'date')) {
    keys(input, ['date']);
    if (typeof input.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) invalid();
    const parsed = new Date(input.date + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input.date) invalid();
  } else {
    keys(input, ['files']);
    if (!Array.isArray(input.files) || !input.files.length || input.files.length > 100 || new Set(input.files).size !== input.files.length) invalid();
    input.files.forEach(file => checkHandle(file, 'f'));
  }
}
function checkAction(input) {
  const shape = actionShapes.find(shape => shape.properties.op.const === input?.op);
  if (!shape) invalid();
  keys(input, Object.keys(shape.properties), shape.required);
  for (const key of ['ref', 'to']) if (Object.hasOwn(input, key)) checkHandle(input[key], 'r');
  if (input.op === 'key') checkText(input.key, true);
  if (input.op === 'select') Array.isArray(input.value) ? checkStrings(input.value) : checkText(input.value);
  if (input.op === 'scroll') {
    if (!Object.hasOwn(input, 'dx') && !Object.hasOwn(input, 'dy')) invalid();
    for (const key of ['dx', 'dy']) if (Object.hasOwn(input, key) && (typeof input[key] !== 'number' || !Number.isFinite(input[key]))) invalid();
  }
  if (input.op === 'wait' && !['visible', 'hidden', 'enabled', 'disabled'].includes(input.state)) invalid();
  if (input.op === 'dialog') {
    checkHandle(input.dialog, 'd');
    if (!['accept', 'dismiss'].includes(input.action) || input.action === 'dismiss' && Object.hasOwn(input, 'value')) invalid();
    if (Object.hasOwn(input, 'value')) checkText(input.value);
  }
  if (input.expect) {
    keys(input.expect, ['ref', 'state']); checkHandle(input.expect.ref, 'r');
    if (!['visible', 'hidden', 'enabled', 'disabled', 'changed'].includes(input.expect.state)) invalid();
  } else if (Object.hasOwn(input, 'expect')) invalid();
}
export function validateCall(request) {
  const data = copyJSON(request);
  keys(data, ['name', 'arguments']);
  if (!definitions.some(tool => tool.name === data.name)) invalid();
  const args = data.arguments;
  if (data.name === 'browser_open') {
    keys(args, ['browser', 'url', 'timeout_ms'], ['browser', 'url']); checkHandle(args.browser, 'b');
    checkText(args.url, true);
    let url; try { url = new URL(args.url); } catch { invalid(); }
    if (!/^https?:\/\//.test(args.url) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid();
  } else {
    checkHandle(args?.tab, 't');
    if (data.name === 'browser_read') {
      keys(args, ['tab', 'scope', 'max_bytes', 'timeout_ms'], ['tab']);
      if (Object.hasOwn(args, 'scope')) checkHandle(args.scope, 'r');
      if (Object.hasOwn(args, 'max_bytes') && (!Number.isInteger(args.max_bytes) || args.max_bytes < 1024 || args.max_bytes > 64000)) invalid();
    } else if (data.name === 'browser_fill') {
      keys(args, ['tab', 'fields', 'timeout_ms'], ['tab', 'fields']);
      if (!Array.isArray(args.fields) || !args.fields.length || args.fields.length > 50) invalid();
      for (const field of args.fields) { keys(field, ['ref', 'value']); checkHandle(field.ref, 'r'); checkValue(field.value); }
      if (new Set(args.fields.map(field => field.ref)).size !== args.fields.length) invalid();
    } else if (Object.hasOwn(args, 'steps')) {
      keys(args, ['tab', 'op', 'steps', 'timeout_ms'], ['tab', 'steps']);
      if (Object.hasOwn(args, 'op') && args.op !== 'batch') invalid();
      if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > 16) invalid();
      args.steps.forEach(checkAction);
    } else {
      const { tab, timeout_ms, ...step } = args;
      checkAction(step);
    }
  }
  if (Object.hasOwn(args, 'timeout_ms') && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1 || args.timeout_ms > 30000)) invalid();
  if (data.name === 'browser_act' && Object.hasOwn(args, 'steps') && Object.hasOwn(args, 'op')) {
    const { op, ...closed } = args;
    return Object.freeze({ ...data, arguments: Object.freeze(closed) });
  }
  return data;
}
