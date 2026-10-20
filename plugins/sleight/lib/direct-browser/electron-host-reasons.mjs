// Only fixed host strings may enter qualification receipts or park diagnostics.
const reasons = new Set([
  'pipe queue full', 'authorization queue full', 'client queue full', 'pipe unavailable', 'pipe queue timeout', 'pipe write failed',
  'pipe timeout; effect unknown', 'cancelled; effect unknown', 'cancelled before dispatch',
  'pipe EOF', 'inbound frame too large', 'outbound frame too large', 'invalid pipe message',
  'invalid pipe reply', 'invalid pipe event', 'child exited', 'adapter lost', 'host restarted',
  'route bank full', 'grant bank full', 'app identity changed', 'incomplete process census',
  'descendant incarnation missing', 'app identity changed during authorization',
  'authority changed in flight; effect unknown', 'broker parked', 'broker parked during preparation',
  'broker parked during authorization', 'revoked', 'user revoked', 'user quit', 'disconnect',
  'debugger grant revoked', 'host failure', 'collection', 'owned app collected',
]);
const pipeErrno = /^(read|write) (EPIPE|ECONNRESET|ECONNABORTED|ENOTCONN|EBADF|ETIMEDOUT)(?:$|[\s:])/;
export const hostReason = reason => reasons.has(reason) ? reason :
  typeof reason === 'string' && pipeErrno.test(reason) ? reason.match(pipeErrno).slice(1, 3).join(' ') :
  typeof reason === 'string' && reason.startsWith('debugger grant revoked: ') ? 'debugger grant revoked' : 'host failure';
export const parkedReceipt = parked => parked ? { reason: hostReason(parked.reason), resumable: parked.resumable === true } : null;
