export function parseEnv(text = '') {
  const env = {};
  for (const entry of text ? text.split(',') : []) {
    const match = /^(SLEIGHT_[A-Z][A-Z0-9_]*)=([01])$/.exec(entry);
    if (!match || /(?:PAYMENT|APPROVAL|TURBO|SURFACES|HAND|IGNORE_HOLD|TRACE|FORBIDDEN|CONFIRM|LIVE|REPLAY)/.test(match[1])) throw Error(`Expected a boolean SLEIGHT feature switch: ${entry}`);
    if (match[1] in env) throw Error(`Duplicate switch: ${match[1]}`);
    env[match[1]] = match[2];
  }
  return env;
}

// Bench-only data envelope. It cannot forward credentials, loader controls or path settings.
export function workerSwitches(env) {
  if (!env.SLEIGHT_REPLAY_ENV) return {};
  const values = JSON.parse(env.SLEIGHT_REPLAY_ENV);
  if (!values || Array.isArray(values) || typeof values !== 'object') throw Error('Invalid replay switch envelope');
  return parseEnv(Object.entries(values).map(([key, value]) => `${key}=${value}`).join(','));
}
