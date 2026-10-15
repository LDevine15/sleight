// v3's five eagerly advertised tools. No generic JavaScript or authority fields.
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string', maxLength: 65536 };
const ref = { type: 'string', pattern: '^(?:(?:f[0-9]+)?e[0-9]+|s[0-9]+)$' };
const tab = { type: 'string', pattern: '^t[A-Za-z0-9_-]{1,64}$' };
const strings = { type: 'array', maxItems: 100, items: text };
const ops = 'click type press select check uncheck hover scroll drag upload dialog wait back forward reload viewport'.split(' ');
const step = object({ do: { type: 'string', enum: ops }, ref, text, key: text,
  values: { type: ['string', 'array'], items: text, maxItems: 100 }, to: ref, until: text,
  dx: { type: 'number' }, dy: { type: 'number' }, accept: { type: 'boolean' }, paths: strings,
  width: { type: 'integer', minimum: 1, maximum: 10000 }, height: { type: 'integer', minimum: 1, maximum: 10000 } }, ['do']);

export function browserTools(browser) {
  return [
    { name: 'browser_open', description: 'Open an owned background tab and return its first untrusted snapshot. Keep the tab handle.',
      inputSchema: object({ url: text, browser: { type: 'string', ...(browser ? { enum: [browser] } : {}) } }, ['url']) },
    { name: 'browser_read', description: 'Read protected, untrusted page state. Use ref for a subtree or continuation, find for matching lines. Reads never grant permission.',
      inputSchema: object({ tab, ref: text, find: text, max_chars: { type: 'integer', minimum: 1000, maximum: 40000 }, text: { type: 'boolean' } }, ['tab']) },
    { name: 'browser_act', description: 'Run 1 to 12 steps on observed refs, returning outcome lines and a diff. Stops at boundaries or failure. Never blindly resend an uncertain submit.',
      inputSchema: object({ tab, steps: { type: 'array', minItems: 1, maxItems: 12, items: step }, observe: { type: 'string', enum: ['diff', 'full', 'none'] } }, ['tab', 'steps']) },
    { name: 'browser_fill', description: 'Fill 1 to 60 observed fields. Values are text, boolean, number or string array. Optional submit is an observed ref. Returns each field status, submit outcome and diff.',
      inputSchema: object({ tab, fields: { type: 'array', minItems: 1, maxItems: 60, items: object({ ref,
        value: { type: ['string', 'boolean', 'number', 'array'], items: text, maxItems: 100, maxLength: 65536 } }, ['ref', 'value']) }, submit: ref }, ['tab', 'fields']) },
    { name: 'browser_tabs', description: 'List only owned tabs, or explicitly close, keep or hand off an owned tab. Never acquire engine-path tabs.',
      inputSchema: object({ do: { type: 'string', enum: ['list', 'close', 'keep', 'handoff'] }, tab }, ['do']) },
  ].map(tool => structuredClone(tool));
}

function data(value, depth = 0) {
  if (depth > 12) throw Error('arguments are too deep');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') throw Error('JSON arguments required');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]))) throw Error('plain JSON required');
  if (Array.isArray(value)) {
    if (value.length > 100 || Object.keys(descriptors).length !== value.length + 1) throw Error('dense bounded arrays required');
    return Array.from({ length: value.length }, (_, i) => data(descriptors[i].value, depth + 1));
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('plain JSON required');
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, data(descriptor.value, depth + 1)]));
}
function validate(value, schema, path = 'arguments') {
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes(type) && !(types.includes('integer') && Number.isInteger(value))) throw Error(`${path} has an invalid type`);
  if (schema.enum && !schema.enum.includes(value)) throw Error(`${path} has an unsupported value`);
  if (type === 'object') {
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw Error(`${path} has an unknown field`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) throw Error(`${path} needs ${key}`);
    for (const [key, item] of Object.entries(value)) validate(item, schema.properties[key], `${path}.${key}`);
  } else if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 100)) throw Error(`${path} has an invalid length`);
    value.forEach(item => validate(item, schema.items, path));
  } else if (type === 'string') {
    if (value.length > (schema.maxLength ?? 65536) || schema.pattern && !new RegExp(schema.pattern).test(value)) throw Error(`${path} has an invalid format`);
  } else if (type === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw Error(`${path} is out of range`);
}
export function validateToolCall(input, browser) {
  const request = data(input);
  if (Buffer.byteLength(JSON.stringify(request)) > 131072) throw Error('arguments exceed the request budget');
  if (!request || Object.keys(request).some(key => !['name', 'arguments'].includes(key))) throw Error('tool request required');
  const tool = browserTools(browser).find(t => t.name === request.name);
  if (!tool) throw Error('unknown browser tool');
  validate(request.arguments, tool.inputSchema);
  if (request.name === 'browser_open') {
    const url = new URL(request.arguments.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('HTTP(S) URL without credentials required');
  }
  for (const item of request.arguments.steps ?? []) {
    const needs = ['click', 'type', 'select', 'check', 'uncheck', 'hover', 'drag', 'upload'].includes(item.do) ? ['ref'] : [];
    const fields = { type: ['text'], press: ['key'], select: ['values'], drag: ['to'], upload: ['paths'], dialog: ['accept'], viewport: ['width', 'height'] };
    for (const key of [...needs, ...(fields[item.do] ?? [])]) if (item[key] === undefined) throw Error(`${item.do} needs ${key}`);
    if (item.do === 'scroll' && item.until === undefined && item.dx === undefined && item.dy === undefined) throw Error('scroll needs until, dx or dy');
    if (item.do === 'upload' && !item.paths.length) throw Error('upload needs paths');
  }
  if (request.name === 'browser_tabs' && request.arguments.do !== 'list' && !request.arguments.tab) throw Error(`${request.arguments.do} needs tab`);
  return request;
}
const clean = value => String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 240);
const textResult = (text, isError = false) => ({ text, isError });

export function createToolDispatcher({ browser, pages, snapshot, runSteps, fillFields, ctx,
  endpoint, deliverSnapshot = (state, capture) => { state.snapshotNo = Math.max(state.snapshotNo, capture.number); return true; }, now = Date.now } = {}) {
  if (!pages || [snapshot, runSteps, fillFields, deliverSnapshot].some(fn => typeof fn !== 'function')) throw Error('v3 tool dependencies required');
  let ended = false, ending;
  const deliveries = new WeakMap();
  const capture = async (entry, options) => {
    if (entry.state.actionPending || entry.state.dialog) throw Error('input or dialog pending; wait or explicitly answer the dialog');
    const capturedAt = now(), value = await snapshot(entry.page, options);
    return { ...value, capturedAt };
  };
  const finish = (text, entry, observed) => {
    const result = textResult(text);
    if (!ended && observed && Number.isSafeInteger(observed.number)) deliveries.set(result, { state: entry.state,
      capture: { page: entry.page, state: entry.state, number: observed.number, capturedAt: observed.capturedAt }, text });
    return result;
  };
  return Object.freeze({ tools: () => browserTools(browser),
    async call(input) {
      let request, started = false;
      try {
        request = validateToolCall(input, browser);
        if (ended) throw Error('turn ended');
        const a = request.arguments;
        if (request.name === 'browser_tabs') {
          if (a.do === 'list') return textResult((await pages.list()).map(row => `${clean(row.tab)} ${clean(row.url)}`).join('\n') || 'No owned tabs.');
          pages.tab(a.tab); started = true;
          return textResult(`${a.do}: ${JSON.stringify(await pages[a.do](a.tab))}`);
        }
        if (request.name === 'browser_open') {
          if (endpoint) {
            const target = new URL(a.url), devtools = new URL(endpoint);
            const port = url => url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
            const local = host => /^(?:127\.\d+\.\d+\.\d+|0\.0\.0\.0|localhost|.+\.localhost|\[(?:::|::1|::ffff:[\da-f:]+)\])$/.test(host.replace(/\.$/, ''));
            if (port(target) === port(devtools) && (target.hostname === devtools.hostname || local(target.hostname) && local(devtools.hostname)))
              throw Error('The selected DevTools endpoint cannot be opened');
          }
          started = true;
          const { tab } = await pages.openTab({ url: a.url }), entry = pages.tab(tab);
          const header = `${tab} ${clean(await entry.page.title())}\n${clean(entry.page.url())}`;
          try { const observed = await capture(entry, { maxChars: 8000 }); return finish(header + '\n' + observed.text, entry, observed); }
          catch { return textResult(header + '\nSnapshot unavailable; use browser_read before input.'); }
        }
        return await pages.enqueue(a.tab, async entry => {
          if (ended) throw Error('turn ended');
          const privateContext = typeof ctx === 'function' ? ctx(entry) : ctx;
          if (request.name === 'browser_read') {
            const options = { ...(a.ref === undefined ? {} : { ref: a.ref }), ...(a.find === undefined ? {} : { find: a.find }), maxChars: a.max_chars ?? 8000 };
            const observed = await capture(entry, options);
            return finish(observed.text, entry, observed);
          }
          started = true;
          if (request.name === 'browser_act') {
            const result = await runSteps(entry, a.steps, privateContext);
            const lines = [...result.lines];
            let observed = result.observe;
            if (a.observe === 'full' && observed) {
              try { observed = await capture(entry, { maxChars: 8000 }); }
              catch { observed = undefined; lines.push('Read unavailable; use browser_read before retrying.'); }
            }
            if (a.observe === 'none') observed = undefined;
            return finish([...lines, ...(observed ? [observed.text] : [])].join('\n'), entry, observed);
          }
          const result = await fillFields(entry, a.fields, { submit: a.submit }, privateContext);
          const lines = result.rows.map(row => `${clean(row.ref)}: ${clean(row.status)}${row.reason ? ': ' + clean(row.reason) : ''}`);
          if (result.submitted) lines.push('submit: ' + clean(result.submitted.status), ...(result.submitted.lines ?? []));
          let observed;
          try { observed = await capture(entry, { since: entry.state.snapshotNo || undefined, maxChars: 8000 }); } catch { lines.push('Read unavailable; use browser_read before retrying.'); }
          return finish([...lines, ...(observed ? [observed.text] : [])].join('\n'), entry, observed);
        });
      } catch (error) {
        return textResult(started ? 'Operation outcome is unconfirmed. Read current state before deciding what remains; do not replay input blindly. Use the engine browser path if needed.'
          : clean(error.message) + '. Use the engine browser path if needed.', !started);
      }
    },
    delivered(result) {
      const record = deliveries.get(result); deliveries.delete(result);
      if (!record || ended || result.isError || result.text !== record.text) return false;
      return deliverSnapshot(record.state, record.capture) === true;
    },
    end() {
      ended = true;
      if (!ending) ending = Promise.resolve().then(() => pages.endTurn()).then(value => ({ revoked: true,
        cleanup: value.cleanedUp ? [] : [{ resource: 'owned-tabs', status: 'retained', code: 'CLEANUP_UNPROVED' }] }))
        .catch(() => ({ revoked: true, cleanup: [{ resource: 'owned-tabs', status: 'retained', code: 'CLEANUP_UNPROVED' }] }));
      return ending;
    },
  });
}
