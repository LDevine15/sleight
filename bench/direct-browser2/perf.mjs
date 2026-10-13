// Offline packaging/measurement review helpers. These accept fixture or collector
// metadata, never grants. They do not connect, launch, install, dispatch or qualify
// a browser. Real identity/authentication and release approval stay outside them.
const hash = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;

export function packageReadiness(plan) {
  if (!plan || typeof plan !== 'object') throw Error('INVALID_PACKAGE_PLAN');
  for (const field of ['extensionInstall', 'nativeHostRegistration', 'launchAtLogin', 'ownerProfileMutation']) {
    if (plan[field] !== false) throw Error('PACKAGE_SCOPE');
  }
  const missing = [];
  // LEDGER BROWSER DECISIONS, owner 2026-10-13: these choices are settled.
  // The declarations below still do not authenticate a host or grant an action.
  if (plan.idleLifetime !== 'until-disconnect') missing.push('idleLifetime');
  if (plan.nativeHost !== 'sleight-local-ui') missing.push('nativeHost');
  for (const field of ['hostOutsidePage', 'hostSessionBound', 'hostOperationBound']) if (plan[field] !== true) missing.push(field);
  for (const field of ['ownerAccepted', 'peerCredentialsQualified', 'assemblyQualified']) if (plan[field] !== true) missing.push(field);
  const dependencies = plan.dependencies;
  if (!Array.isArray(dependencies) || !dependencies.length) missing.push('dependencies');
  else for (let i = 0; i < dependencies.length; i++) {
    const d = dependencies[i];
    // Array.some skips holes; each declared slot needs its own inventory entry.
    if (!Object.hasOwn(dependencies, i) || !d || ['name', 'version', 'license', 'notice']
      .some(k => typeof d[k] !== 'string' || !d[k].trim()) || typeof d.bundled !== 'boolean') {
      missing.push('dependencies'); break;
    }
  }
  return { ready: missing.length === 0, missing, releaseAuthorized: false };
}

export function versionHandshake(frontend, broker, { restarted = false, inFlight = false } = {}) {
  const valid = value => value && value.protocol === 1 && hash(value.bundle) && hash(value.helpers);
  const compatible = Boolean(valid(frontend) && valid(broker) && ['protocol', 'bundle', 'helpers'].every(k => frontend[k] === broker[k]));
  return { compatible, code: compatible ? restarted ? 'CONNECTION_APPROVAL_REQUIRED' : 'VERSION_MATCH' : 'VERSION_MISMATCH',
    needsConsent: !compatible || restarted, autoReconnect: false, effect: inFlight ? 'unknown' : 'none' };
}

const sampleKeys = new Set(['client', 'processIncarnation', 'trial', 'concurrency', 'workload', 'stage', 'wallMs', 'queueMs',
  'outcome', 'policyEnabled', 'unrelatedEffects', 'cleanupConfirmed', 'cpuMs', 'rssBytes']);
const stages = new Set(['human-consent', 'machine-attach', 'policy-adapter-initialization', 'warm-complete-tool']);
const outcomes = new Set(['verified', 'failed', 'refused', 'timeout', 'unknown']);

export function summarizeCell(input, { concurrency, trials, evidence = 'synthetic' } = {}) {
  if (![1, 4, 13].includes(concurrency) || !Number.isSafeInteger(trials) || trials < 1 || trials > 1000 ||
    !['synthetic', 'host'].includes(evidence) || !Array.isArray(input) || input.length > 13000) throw Error('INVALID_CELL');
  if (Object.getPrototypeOf(input) !== Array.prototype) throw Error('INVALID_CELL');
  const entries = Object.getOwnPropertyDescriptors(input), records = [];
  if (Reflect.ownKeys(entries).length !== input.length + 1) throw Error('INVALID_CELL');
  for (let i = 0; i < input.length; i++) {
    if (!Object.hasOwn(entries, i) || !('value' in entries[i])) throw Error('INVALID_CELL');
    records.push(entries[i].value);
  }
  const samples = records.map(row => {
    if (!row || Object.getPrototypeOf(row) !== Object.prototype) throw Error('INVALID_SAMPLE');
    const descriptors = Object.getOwnPropertyDescriptors(row);
    if (Reflect.ownKeys(descriptors).some(k => !sampleKeys.has(k) || !('value' in descriptors[k]))) throw Error('INVALID_SAMPLE');
    const result = {};
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.value !== null && !['string', 'number', 'boolean'].includes(typeof descriptor.value)) throw Error('INVALID_SAMPLE');
      result[key] = descriptor.value;
    }
    if (['workload', 'processIncarnation'].some(k => typeof result[k] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(result[k])) ||
      !stages.has(result.stage) || !outcomes.has(result.outcome) || !Number.isSafeInteger(result.client) || result.client < 0 ||
      result.client >= concurrency || !Number.isSafeInteger(result.trial) || result.trial < 0 || result.trial >= trials) throw Error('INVALID_SAMPLE');
    return result;
  });
  const first = samples[0];
  if (samples.some(r => r.concurrency !== concurrency || r.workload !== first.workload || r.stage !== first.stage)) throw Error('MIXED_CELL');
  const keys = new Set(samples.map(r => `${r.client}:${r.trial}`));
  const processes = new Map();
  for (const row of samples) {
    if (!processes.has(row.client)) processes.set(row.client, new Set());
    processes.get(row.client).add(row.processIncarnation);
  }
  const incarnations = new Set(samples.map(r => r.processIncarnation));
  const complete = samples.length === concurrency * trials && keys.size === samples.length && processes.size === concurrency &&
    [...processes.values()].every(ids => ids.size === 1) && incarnations.size === concurrency;
  const clocksComplete = samples.every(r => finite(r.wallMs) && finite(r.queueMs));
  const controlsComplete = samples.every(r => r.policyEnabled === true && r.unrelatedEffects === 0 && r.cleanupConfirmed === true);
  const passing = samples.filter(r => r.outcome === 'verified');
  const passingClocks = passing.every(r => finite(r.wallMs));
  const walls = passingClocks ? passing.map(r => r.wallMs) : [];
  const all = field => samples.length && samples.every(r => finite(r[field]));
  return { evidence, concurrency, trials, expected: concurrency * trials, received: samples.length, complete,
    qualified: false, eligibleForHostReview: evidence === 'host' && complete && clocksComplete && controlsComplete && passing.length === samples.length,
    failures: samples.length - passing.length, totalMs: all('wallMs') ? samples.reduce((sum, r) => sum + r.wallMs, 0) : null,
    p50Ms: percentile(walls, 0.5), p90Ms: percentile(walls, 0.9),
    queueP90Ms: all('queueMs') ? percentile(samples.map(r => r.queueMs), 0.9) : null,
    cpuMs: all('cpuMs') ? samples.reduce((sum, r) => sum + r.cpuMs, 0) : null,
    rssBytes: all('rssBytes') ? Math.max(...samples.map(r => r.rssBytes)) : null,
    samples };
}
