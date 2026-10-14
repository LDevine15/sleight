import { canonical } from './authority.mjs';
import { immutableJSON } from './ipc.mjs';

const owners = new WeakSet();
export const isRemoteResources = value => !!value && owners.has(value);
// Fixed host only. This separate channel can release exactly an acquired remote
// object after action authority has gone. It has no read, input or generic send.
export function createRemoteResources({ session, timeoutMs = 1000 }) {
  if (!session || typeof session.send !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000)
    throw Error('RESOURCE_OWNER_REQUIRED');
  const records = new Map();
  const key = (lease, id) => canonical([lease.cdpSessionId, id]);
  function admit(input, id) {
    const lease = immutableJSON(input);
    if (typeof id !== 'string' || !id || id.length > 1024 || typeof lease.cdpSessionId !== 'string') throw Error('OBJECT_LOST');
    const k = key(lease, id), prior = records.get(k);
    if (prior) throw Error('OBJECT_LOST');
    records.set(k, { lease, id, owner: canonical(lease) });
  }
  function forget(lease, id) {
    const record = records.get(key(lease, id));
    if (!record || record.owner !== canonical(lease)) throw Error('OBJECT_LOST');
    records.delete(key(lease, id));
  }
  function release(lease, id) {
    const record = records.get(key(lease, id));
    if (!record || record.owner !== canonical(lease)) return Promise.resolve(false);
    if (record.pending) return record.pending;
    // The one fixed command and route come from the private acquisition record.
    // Neither model input nor a new lease can select another remote resource.
    record.pending = Promise.resolve().then(() => session.send('Runtime.releaseObject',
      { objectId: record.id }, record.lease.cdpSessionId)).then(result => {
      if (!result || result.error || result.exceptionDetails) return false;
      records.delete(key(record.lease, record.id)); return true;
    }, () => false).finally(() => { record.pending = undefined; });
    return record.pending;
  }
  const receipt = session => [...records.values()].filter(record => session === undefined || record.lease.clientSession === session).map(record => ({ target: record.lease.target, frame: record.lease.frame,
    document: record.lease.document, status: 'retained', resource: 'remote-object' }));
  const owner = Object.freeze({ admit, forget, release, receipt,
    async cleanup(session) {
      const pending = Promise.all([...records.values()].filter(record => session === undefined || record.lease.clientSession === session)
        .map(record => release(record.lease, record.id)));
      let timer;
      try { await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
      finally { clearTimeout(timer); }
      const cleanup = receipt(session);
      return { closed: cleanup.length === 0, cleanup };
    },
  });
  owners.add(owner); return owner;
}
