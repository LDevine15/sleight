export { BrowserFailure } from '../direct-browser/errors.mjs';
const states = {
  setting_off: ['SETTING_OFF', 'Enable the browser setting through trusted setup.'],
  unsupported: ['CONNECTION_UNSUPPORTED', 'Choose supported browser control through trusted setup.'],
  approval_pending: ['CONNECTION_APPROVAL_PENDING', 'Review the pending browser consent request.'],
  declined: ['CONNECTION_DECLINED', 'Connect again only through an explicit trusted user choice.'],
  stale_instance: ['STALE_INSTANCE', 'Select and reconnect the current browser instance.'],
  disconnected: ['DISCONNECTED', 'Reconnect through trusted setup, then read fresh state.'],
};
export const CONNECTION_STATES = new Set(['ready', ...Object.keys(states)]);
export function connectionError(state, { effect = 'none', completed = 0 } = {}) {
  const [code, message] = states[state] ?? states.disconnected;
  return { code, phase: 'connection', effect, completed,
    next: { kind: 'user', action: state === 'approval_pending' ? 'review_connection' : 'connect' }, observation: null, message };
}
export function surfaceError(code, { tab, effect = 'none', completed = 0, phase = 'policy' } = {}) {
  const messages = {
    RECOVERY_READ_REQUIRED: 'Read fresh state before requesting more input.',
    PERMISSION_REQUIRED: 'Use the trusted user control for this operation.',
    CAPABILITY_UNAVAILABLE: 'Use the supported handoff through trusted user control.',
    HISTORY_FULL: 'Resolve retained unknown operations through trusted control.',
  };
  const next = code === 'RECOVERY_READ_REQUIRED' && tab ? { tool: 'browser_read', arguments: { tab } }
    : { kind: 'user', action: 'authorize' };
  return { code, phase, effect, completed, next, observation: null, message: messages[code] ?? messages.CAPABILITY_UNAVAILABLE };
}
