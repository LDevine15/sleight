import { immutableJSON, FRAME_LIMIT } from './ipc.mjs';

// Independent host validator for P3's reviewed closed BP-8 four-verb grammar.
// No descriptions or evaluate/CDP/approval fields cross this host boundary.
const invalid = () => { throw Error('INVALID_ARGUMENT'); };
const keys = (value, allowed, required = allowed) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k)) ||
      required.some(k => !Object.hasOwn(value, k))) invalid();
};
const handle = (value, prefix) => { if (typeof value !== 'string' || !new RegExp('^' + prefix + '[A-Za-z0-9_-]{1,63}$').test(value)) invalid(); };
const text = (value, nonempty = false) => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 65536 || nonempty && !value) invalid();
};
const strings = value => {
  if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length) invalid();
  value.forEach(item => text(item));
};
function fieldValue(value) {
  if (typeof value === 'string') return text(value);
  if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) return strings(value);
  if (value && Object.hasOwn(value, 'date')) {
    keys(value, ['date']);
    if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) invalid();
    const date = new Date(value.date + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.date) invalid();
  } else {
    keys(value, ['files']);
    if (!Array.isArray(value.files) || !value.files.length || value.files.length > 100 || new Set(value.files).size !== value.files.length) invalid();
    value.files.forEach(value => handle(value, 'f'));
  }
}
function action(value) {
  const shapes = { click: ['ref'], hover: ['ref'], key: ['ref', 'key'], select: ['ref', 'value'],
    scroll: ['ref', 'dx', 'dy'], drag: ['ref', 'to'], wait: ['ref', 'state'], dialog: ['dialog', 'action', 'value'] };
  if (!value || !Object.hasOwn(shapes, value.op)) invalid();
  const required = ['op', ...shapes[value.op].filter(k => value.op === 'scroll' ? !['dx', 'dy'].includes(k) : value.op !== 'dialog' || k !== 'value')];
  keys(value, ['op', ...shapes[value.op], 'expect'], required);
  for (const key of ['ref', 'to']) if (Object.hasOwn(value, key)) handle(value[key], 'r');
  if (value.op === 'key') text(value.key, true);
  if (value.op === 'select') Array.isArray(value.value) ? strings(value.value) : text(value.value);
  if (value.op === 'scroll') {
    if (!Object.hasOwn(value, 'dx') && !Object.hasOwn(value, 'dy')) invalid();
    for (const key of ['dx', 'dy']) if (Object.hasOwn(value, key) && !Number.isFinite(value[key])) invalid();
  }
  if (value.op === 'wait' && !['visible', 'hidden', 'enabled', 'disabled'].includes(value.state)) invalid();
  if (value.op === 'dialog') {
    handle(value.dialog, 'd');
    if (!['accept', 'dismiss'].includes(value.action) || value.action === 'dismiss' && Object.hasOwn(value, 'value')) invalid();
    if (Object.hasOwn(value, 'value')) text(value.value);
  }
  if (Object.hasOwn(value, 'expect')) {
    keys(value.expect, ['ref', 'state']); handle(value.expect.ref, 'r');
    if (!['visible', 'hidden', 'enabled', 'disabled', 'changed'].includes(value.expect.state)) invalid();
  }
}
export function validateHostRequest(input) {
  const frame = immutableJSON(input);
  keys(frame, ['id', 'operation', 'args']);
  if (typeof frame.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(frame.id) ||
      !['browser_open', 'browser_read', 'browser_act', 'browser_fill'].includes(frame.operation) ||
      Buffer.byteLength(JSON.stringify(frame)) > FRAME_LIMIT) invalid();
  const a = frame.args;
  if (frame.operation === 'browser_open') {
    keys(a, ['browser', 'url', 'timeout_ms'], ['browser', 'url']); handle(a.browser, 'b'); text(a.url, true);
    let url; try { url = new URL(a.url); } catch { invalid(); }
    if (!/^https?:\/\//.test(a.url) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) invalid();
  } else {
    handle(a?.tab, 't');
    if (frame.operation === 'browser_read') {
      keys(a, ['tab', 'scope', 'max_bytes', 'timeout_ms'], ['tab']);
      if (Object.hasOwn(a, 'scope')) handle(a.scope, 'r');
      if (Object.hasOwn(a, 'max_bytes') && (!Number.isInteger(a.max_bytes) || a.max_bytes < 1024 || a.max_bytes > 64000)) invalid();
    } else if (frame.operation === 'browser_fill') {
      keys(a, ['tab', 'fields', 'timeout_ms'], ['tab', 'fields']);
      if (!Array.isArray(a.fields) || !a.fields.length || a.fields.length > 50) invalid();
      for (const field of a.fields) { keys(field, ['ref', 'value']); handle(field.ref, 'r'); fieldValue(field.value); }
      if (new Set(a.fields.map(field => field.ref)).size !== a.fields.length) invalid();
    } else if (Object.hasOwn(a, 'steps')) {
      keys(a, ['tab', 'steps', 'timeout_ms'], ['tab', 'steps']);
      if (!Array.isArray(a.steps) || !a.steps.length || a.steps.length > 16) invalid();
      a.steps.forEach(action);
    } else {
      keys(a, ['tab', 'timeout_ms', 'op', 'ref', 'to', 'key', 'value', 'dx', 'dy', 'state', 'dialog', 'action', 'expect'], ['tab', 'op']);
      const { tab, timeout_ms, ...step } = a; action(step);
    }
  }
  if (Object.hasOwn(a, 'timeout_ms') && (!Number.isInteger(a.timeout_ms) || a.timeout_ms < 1 || a.timeout_ms > 30000)) invalid();
  // Broker validators return their exact already-immutable input identity.
  return input;
}
