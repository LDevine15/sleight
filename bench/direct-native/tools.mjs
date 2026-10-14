// Offline, opt-in schemas. Registration and a production route belong to NP-8.
const string = { type: 'string', minLength: 1, maxLength: 4096 };
const ref = { type: 'string', pattern: '^e[1-9][0-9]*$', maxLength: 32 };
const app = { type: 'string', pattern: '^a[1-9][0-9]*$', maxLength: 32 };
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const predicate = object({ ref, role: string, name: string, state: string, title: string });
predicate.minProperties = 1;
const action = { oneOf: [
  object({ click: ref }, ['click']),
  object({ type: { type: 'string', maxLength: 16384 } }, ['type']),
  object({ key: string }, ['key']),
  object({ set: object({ ref, value: { type: 'string', maxLength: 16384 } }, ['ref', 'value']) }, ['set']),
  object({ scroll: object({ ref, direction: { enum: ['up', 'down', 'left', 'right'] },
    amount: { type: 'number', exclusiveMinimum: 0, maximum: 16 } }, ['ref', 'direction', 'amount']) }, ['scroll']),
] };
const actions = { type: 'array', minItems: 1, maxItems: 16, items: action };
const timeout = { type: 'integer', minimum: 1, maximum: 30000 };
const view = { scope: { enum: ['window', 'sheet', 'region'] },
  query: object({ ref, role: string, name: string, id: string }), since: string,
  budget: { type: 'integer', minimum: 1, maximum: 64000 }, image: { type: 'boolean' } };
export const nativeTools = [
  { name: 'native_open', description: 'Acquire one running app through the guarded route; retain its first state.',
    inputSchema: object({ app: string, window: string, actions, timeout }, ['app']) },
  { name: 'native_read', description: 'Read authorized native state. Scopes limit delivery; they do not grant access.',
    inputSchema: object({ app, ...view, timeout }, ['app']) },
  { name: 'native_act', description: 'Execute known steps in order through the full relay. Stop with the unfinished suffix.',
    inputSchema: object({ app, actions, expect: predicate, timeout }, ['app', 'actions']) },
  { name: 'native_wait', description: 'Wait for an exact native condition with fresh evidence and one deadline.',
    inputSchema: object({ app, until: predicate, timeout }, ['app', 'until']) },
];
