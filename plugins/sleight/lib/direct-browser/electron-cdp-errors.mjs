// Fixed CDP reasons preserve Playwright's protocol handling without forwarding app text,
// paths, object ids or execution-context ids. Match the whole message, never a substring.
const reasons = new Set([
  'Could not find object with given id', 'Cannot find object with given id',
  'Could not find node with given id', 'No node with given id found',
  'Cannot find context with specified id', 'Cannot find execution context with given id',
  'Cannot find default execution context', 'Execution context was destroyed.',
  'Argument should belong to the same JavaScript world as target object',
  'DOM agent is not enabled',
]);
export const cdpReason = message => reasons.has(message) ? message : 'CDP_COMMAND_FAILED';
export const protocolCode = code => Number.isSafeInteger(code) && code >= -(2 ** 31) && code < 2 ** 31 ? code : undefined;

// Only expired DOM references permit the app preflight to request a fresh delivered read.
// World, session, transport and unknown failures keep their original refusal.
export const staleDOMReference = message => /^Protocol error \(DOM\.(?:describeNode|resolveNode)\): (?:Could not find object with given id|Cannot find object with given id|Could not find node with given id|No node with given id found)$/.test(message);
