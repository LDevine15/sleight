import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { immutableJSON } from './ipc.mjs';
import { validateHostRequest } from './request-schema.mjs';
import { isTrustedUi } from './host.mjs';
import { isAuthority, revokeAuthoritySession } from './authority.mjs';
import { isBroker } from './broker.mjs';
import { isTransportOwner } from './transport-owner.mjs';

const packages = new WeakSet();
// The fixed installed loader selects the root and accepted receipt outside model
// and project input. Test inventories do not accept a package for a real user.
export function createPackageInventory({ root = fileURLToPath(new URL('../..', import.meta.url)), receipt }) {
  const manifest = immutableJSON(receipt), minimum = ['host.mjs', 'native/peer-host.c', 'native/consent-host.swift', 'playwright-files.json'];
  if (!isAbsolute(root) || normalize(root) !== root || !manifest || Object.keys(manifest).some(k =>
    !['accepted', 'protocol', 'node', 'helperMode', 'files'].includes(k)) || manifest.accepted !== true || manifest.protocol !== 1 ||
    manifest.helperMode !== 'source' || manifest.node !== process.version || !Array.isArray(manifest.files) || !manifest.files.length ||
    manifest.files.length > 4096) throw Error('DISTRIBUTION_ACCEPTANCE_REQUIRED');
  const paths = new Set();
  for (const file of manifest.files) {
    if (!file || Object.keys(file).length !== 3 || typeof file.path !== 'string' || !file.path || isAbsolute(file.path) ||
        normalize(file.path) !== file.path || file.path.split('/').some(p => ['..', '.', ''].includes(p)) ||
        paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw Error('HOST_PACKAGE_MISMATCH');
    paths.add(file.path);
  }
  if (minimum.some(name => ![...paths].some(path => path === name || path.endsWith('/' + name)))) throw Error('HOST_PACKAGE_MISMATCH');
  let identity;
  const current = () => {
    try {
      const dir = lstatSync(root), uid = process.getuid?.();
      if (!dir.isDirectory() || dir.isSymbolicLink() || realpathSync(root) !== root || dir.mode & 0o022 ||
          uid !== undefined && dir.uid !== uid && dir.uid !== 0 || identity && (dir.dev !== identity.dev || dir.ino !== identity.ino)) return false;
      const actual = [];
      const walk = (folder, prefix = '') => {
        for (const name of readdirSync(folder)) {
          const relative = prefix + name, path = join(folder, name), stat = lstatSync(path);
          if (stat.isSymbolicLink() || stat.mode & 0o022 || uid !== undefined && stat.uid !== uid && stat.uid !== 0) throw Error();
          if (stat.isDirectory()) walk(path, relative + '/');
          else if (stat.isFile()) actual.push(relative); else throw Error();
        }
      };
      walk(root);
      if (actual.length !== paths.size || actual.some(path => !paths.has(path))) return false;
      for (const file of manifest.files) {
        const bytes = readFileSync(join(root, file.path));
        if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) return false;
      }
      identity ??= { dev: dir.dev, ino: dir.ino };
      return process.version === manifest.node;
    } catch { return false; }
  };
  const inventory = Object.freeze({ current }); packages.add(inventory); return inventory;
}

export function createSessionHost({ session, client, ui, packageInventory, status, redact, revoke, cleanup, timeoutMs = 30000 }) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(session) || typeof client?.request !== 'function' ||
      !isTrustedUi(ui) || !packages.has(packageInventory) || [status, redact, revoke, cleanup].some(f => typeof f !== 'function') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw Error('TRUSTED_ROUTE_REQUIRED');
  const proofs = new WeakMap(); let ended = false, revoked = false, sequence = 0, ending;
  const packageCurrent = () => packageInventory.current() === true;
  const snapshot = () => immutableJSON(status());
  const safe = value => immutableJSON(redact(immutableJSON(value ?? null)));
  function requestDecision(kind) {
    if (ended || !packageCurrent()) return Promise.reject(Error('TRUSTED_ROUTE_REQUIRED'));
    const before = snapshot(), choices = kind === 'opt-in' ? ['enable', 'cancel'] : ['resume', 'cancel'];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('TRUSTED_UI_UNAVAILABLE')), timeoutMs);
      try {
        ui.present('session-' + session + '-' + (++sequence), { kind, session, epoch: before.epoch }, choices, event => {
          clearTimeout(timer);
          if (ui.authenticate(event) !== true || event.choice !== choices[0] || ended || !packageCurrent() ||
              snapshot().epoch !== before.epoch) return resolve(null);
          const proof = Object.freeze({}); proofs.set(proof, { kind, epoch: before.epoch }); resolve(proof);
        });
      } catch { clearTimeout(timer); reject(Error('TRUSTED_UI_UNAVAILABLE')); }
    });
  }
  function verify(proof, kind) {
    const record = proof && proofs.get(proof);
    if (!record || record.kind !== kind) return false;
    proofs.delete(proof);
    try { return !ended && packageCurrent() && snapshot().epoch === record.epoch; } catch { return false; }
  }
  return Object.freeze({ packageCurrent, status: () => snapshot().state, redact: safe,
    requestOptIn: () => requestDecision('opt-in'), requestResume: () => requestDecision('resume'),
    verifyOptIn: proof => verify(proof, 'opt-in'), verifyResume: proof => verify(proof, 'resume'),
    client: Object.freeze({ async request(input) {
      const frame = immutableJSON(input); validateHostRequest(frame);
      if (ended) throw Error('LEASE_LOST');
      if (!packageCurrent()) throw Error('VERSION_MISMATCH');
      const response = immutableJSON(await client.request(frame));
      if (ended) throw Error('LEASE_LOST');
      if (!packageCurrent()) throw Error('VERSION_MISMATCH');
      if (!response || Array.isArray(response)) throw Error('INVALID_RECEIPT');
      const result = { ...response };
      if (Object.hasOwn(result, 'observation')) result.observation = safe(result.observation);
      if (Object.hasOwn(result, 'results')) {
        if (!Array.isArray(result.results) || result.results.length > 50) throw Error('INVALID_RECEIPT');
        result.results = result.results.map(row => ({ ...row, observation: safe(row.observation) }));
      }
      if (result.error?.observation !== undefined) result.error = { ...result.error, observation: safe(result.error.observation) };
      return immutableJSON(result);
    } }),
    endSession() {
      ended = true;
      // This entry fences requests and revokes before returning its promise.
      if (!revoked) try {
        const result = revoke(session);
        if (result?.then) Promise.resolve(result).catch(() => {});
        else revoked = result === true;
      } catch {}
      if (ending) return ending;
      let timer;
      ending = Promise.race([Promise.resolve().then(() => cleanup(session)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('CLEANUP_UNPROVED')), timeoutMs);
      })]).then(result => {
        const value = immutableJSON(result);
        if (!value || !Array.isArray(value.cleanup)) throw Error('CLEANUP_UNPROVED');
        return immutableJSON({ revoked, cleanup: value.cleanup });
      }).catch(() => ({ revoked, cleanup: [{ status: 'retained', code: 'CLEANUP_UNPROVED' }] }))
        .finally(() => { clearTimeout(timer); ending = undefined; });
      return ending;
    },
  });
}

// Concrete in-host join: attach authentic IPC identity to the actual broker,
// branded authority and persistent semantic owner. No permissive lifecycle
// callback is needed. IPC consumers use the matching authenticated client.
export function createBrokerSessionHost({ broker, identity, authority, transportOwner, ui, packageInventory, redact, timeoutMs = 30000 }) {
  if (!isAuthority(authority) || !isBroker(broker) || !isTransportOwner(transportOwner)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const client = broker.attach(identity);
  return createSessionHost({ session: identity.session, client, ui, packageInventory, status: broker.status, redact, timeoutMs,
    revoke(session) {
      revokeAuthoritySession(authority, session);
      transportOwner.revokeSession(session);
      client.disconnect();
      return true;
    },
    async cleanup(session) {
      const resources = await transportOwner.cleanupSession(session), state = broker.status();
      return { cleanup: [...resources.cleanup, ...(state.cleanup?.pending || state.cleanup?.connecting ?
        [{ resource: 'browser-connection', status: 'retained', pending: state.cleanup.pending, connecting: state.cleanup.connecting }] : [])] };
    },
  });
}
