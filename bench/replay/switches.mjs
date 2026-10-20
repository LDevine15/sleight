export const replaySwitches = Object.freeze(['SLEIGHT_DP1', 'SLEIGHT_DP2', 'SLEIGHT_DP7', 'SLEIGHT_CK2', 'SLEIGHT_CK3', 'SLEIGHT_MC1', 'SLEIGHT_LB12']);

export function parseEnv(text = '') {
  const env = {};
  for (const entry of text ? text.split(',') : []) {
    const match = /^(SLEIGHT_[A-Z][A-Z0-9_]*)=([01])$/.exec(entry);
    if (!match || !replaySwitches.includes(match[1])) throw Error(`Expected a documented boolean SLEIGHT replay switch: ${entry}`);
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
