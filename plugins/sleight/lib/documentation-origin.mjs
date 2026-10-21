import { createHash } from 'node:crypto';

// This hash checks format only. The private transaction below establishes origin.
const API_SHA = '646ebda5cf3d1536b0502c6291b59c2a13d1b50b98fc4e0f5fe6d5bb5fc490ab';
const OWNED = Symbol('sleight documentation origin');
const FULL = Symbol('sleight full documentation');
const API = /## API\n\n```typescript\n([\s\S]*?)\n```/g;
function compact(text) {
  const fences = [...text.matchAll(API)];
  if (fences.length !== 1) return text;
  const match = fences[0], body = match[1];
  if (createHash('sha256').update(body).digest('hex') !== API_SHA) return text;
  const kept = body.split('\n').filter(line => line.trim()).map(line =>
    line.includes('//') || line.includes('/*') ? line : line.replace(/^[ \t]+/, '')).join('\n');
  const at = match.index + match[0].indexOf(body);
  return text.slice(0, at) + kept + text.slice(at + body.length);
}
function known(item) {
  if (item?.type !== 'text' || typeof item.text !== 'string' ||
      Object.keys(item).some(key => !['type', 'text'].includes(key))) return false;
  if (!item.text.startsWith('## Computer Use\n') || compact(item.text) === item.text) return false;
  const policy = item.text.indexOf('\n# Computer Use Confirmations Policy\n');
  if (policy < 0) return false;
  return [...item.text.slice(0, policy).matchAll(/^#{1,6} (.+)$/gm)]
    .every(match => ['Computer Use', 'API', 'Native apps', 'Workflow', 'Output', 'Notes'].includes(match[1]));
}

function knownMetadata(meta) {
  if (meta === undefined) return true;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  try {
    const prototype = Object.getPrototypeOf(meta);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(meta);
    if (!keys.length) return true;
    if (keys.length !== 1 || keys[0] !== 'codex/nodeReplExecutionDurationMs') return false;
    const field = Object.getOwnPropertyDescriptor(meta, keys[0]);
    return field.enumerable && Object.hasOwn(field, 'value') && Number.isFinite(field.value) && field.value >= 0;
  } catch { return false; }
}

export function documentationOrigin() {
  let used = false, active, captured, delivered = false, inFlight;
  const ids = new Set();
  const invalidate = () => { active = undefined; if (captured) captured.valid = false; };
  return {
    invalidate,
    owns: id => ids.has(id),
    begin(request, context, { appFree = false } = {}) {
      ids.add(request.id);
      if (!used && !active && appFree) active = { request, context };
    },
    sent(request, context) {
      if (request.method !== 'tools/call') return;
      if (active && (request !== active.request || context !== active.context)) invalidate();
      used = true;
    },
    reply(msg, context) {
      if (!active || msg.method !== undefined || msg.id !== active.request.id) return;
      const owner = active; active = undefined;
      const content = msg.result?.content;
      if (context !== owner.context || msg.error || msg.result?.isError || !Array.isArray(content) ||
          Object.keys(msg.result).some(key => !['content', 'isError', '_meta'].includes(key)) ||
          !knownMetadata(msg.result._meta) ||
          content.filter(known).length !== 1 || content.some(item => !known(item) &&
            !(item?.type === 'text' && /^\[sleight:guard-ready\]\n?$/.test(item.text) &&
              Object.keys(item).every(key => ['type', 'text'].includes(key))))) return;
      captured = { context, valid: true };
      msg.result.content = content.map(item => known(item) ? { ...item, [OWNED]: captured } : item);
    },
    project(content, { context, full = false, isError = false } = {}) {
      const copies = [];
      const out = content.map(item => {
        if (full || isError || delivered || inFlight || !captured?.valid || item[OWNED] !== captured || context !== captured.context) return item;
        const text = compact(item.text);
        if (text === item.text) return item;
        const projected = { ...item, text, [FULL]: item };
        copies.push({ full: item, projected });
        return projected;
      });
      const ticket = { content: out, copies };
      if (copies.length) inFlight = ticket;
      return ticket;
    },
    full: item => item[FULL] ?? item,
    settle(ticket, result, error) {
      if (!ticket?.copies.length) return [];
      if (inFlight === ticket) inFlight = undefined;
      const received = !error && !result?.isError && ticket.copies.every(({ projected }) =>
        result?.content?.some(item => item.type === 'text' && item.text === projected.text));
      if (received) { delivered = true; return []; }
      return ticket.copies.map(copy => copy.full);
    },
  };
}
