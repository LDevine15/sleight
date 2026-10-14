const recovery = {
  CONNECTION_UNSUPPORTED: ['Choose supported browser control through trusted setup.', 'connect'],
  VERSION_MISMATCH: ['Package changed; reconnect through trusted setup.', 'connect'],
  RECOVERY_READ_REQUIRED: ['Read complete fresh state before requesting more input.', 'read'],
  HISTORY_FULL: ['Resolve retained unknown operations through trusted control.', 'authorize'],
  CLIENT_DISCONNECTED: ['The session has ended.', 'connect'],
  TIMEOUT: ['The broker deadline expired; read fresh state before more input.', 'read'],
  BACKPRESSURE: ['The broker is at its request limit; wait for pending work.', 'wait'],
  DUPLICATE_MISMATCH: ['The operation id was already used for different input.', 'correct'],
  NO_EFFECT: ['The requested effect was not proved; read fresh state.', 'read'],
  INVALID_ARGUMENT: ['Use the documented tool shape.', 'correct'],
  FOREIGN_REF: ['Read this session tab before acting.', 'read'],
  STALE_REF: ['Read fresh refs before acting.', 'read'],
  AMBIGUOUS_VALUE: ['Read the available choices; choose an exact value.', 'read'],
  COVERED: ['Read the blocker before an authorized action.', 'read'],
  READONLY_PICKER: ['Read the picker controls before selecting.', 'read'],
  VALUE_PROTECTED: ['The protected write has proof; continue without refilling.', 'continue'],
  STATE_UNVERIFIABLE: ['Read the state before deciding what to do.', 'read'],
  DIALOG_OPEN: ['Review the dialog and its required confirmation.', 'review_dialog'],
  EFFECT_UNKNOWN: ['Read the expected effect before deciding whether to retry.', 'read'],
  PERMISSION_REQUIRED: ['Review the exact action in the trusted permission UI.', 'authorize'],
  USER_TAKEOVER: ['Resume through the trusted user control, then read fresh state.', 'resume'],
  LEASE_LOST: ['Rebind through the trusted user control, then read fresh state.', 'rebind'],
  BACKGROUND_UNAVAILABLE: ['Use the supported handoff through the trusted user control.', 'handoff'],
  SETTING_OFF: ['Enable the browser setting and connect through trusted setup.', 'connect'],
  CONNECTION_APPROVAL_PENDING: ['Review the pending browser connection request.', 'review_connection'],
  CONNECTION_DECLINED: ['Reconnect only through an explicit trusted user choice.', 'connect'],
  STALE_INSTANCE: ['Select and reconnect the current browser instance.', 'connect'],
  DISCONNECTED: ['Reconnect through trusted setup, then read fresh state.', 'connect'],
};
export const EFFECTS = new Set(['none', 'verified', 'unchanged', 'protected', 'unverifiable', 'unknown']);
export class BrowserFailure extends Error {
  constructor(code, { phase = 'dispatch', effect = 'unknown', observation } = {}) {
    const known = Object.hasOwn(recovery, code);
    super(known ? code : 'EFFECT_UNKNOWN');
    this.code = known ? code : 'EFFECT_UNKNOWN';
    this.phase = ['validate', 'policy', 'dispatch', 'proof', 'connection'].includes(phase) ? phase : 'dispatch';
    this.effect = EFFECTS.has(effect) ? effect : 'unknown';
    this.observation = observation;
  }
}
// Only trusted adapter failures enter here. Raw exceptions never become model text.
export function browserError(failure, { tab, completed = 0, observation = null } = {}) {
  const error = failure instanceof BrowserFailure ? failure : new BrowserFailure('EFFECT_UNKNOWN');
  const [message, action] = recovery[error.code];
  const next = action === 'read' && tab ? { tool: 'browser_read', arguments: { tab } }
    : { kind: action === 'continue' ? 'continue' : 'user', action };
  return { code: error.code, phase: error.phase, effect: error.effect, completed, next, observation, message };
}
