import { createHash } from 'node:crypto';
import { documentationOrigin } from '../../plugins/sleight/lib/documentation-origin.mjs';
import { replSetupCode } from '../../plugins/sleight/lib/repl-warmup.mjs';
import { openClient } from './client.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
export const diagnosticEnvironment = env => ({ ...env, SLEIGHT_TURBO: '0', SLEIGHT_HAND: '0',
  SLEIGHT_SURFACES: 'computer', CUA_REPL_ENABLED_SURFACES: 'computer' });
export const collectionCertain = receipt => receipt?.childCollected === true && receipt?.groupCollected === true;
const uncertain = () => ({ childCollected: false, groupCollected: false });
const apiFence = text => typeof text === 'string' && /## API\n\n```typescript\n([\s\S]*?)\n```/.exec(text);
const apiFullHash = '646ebda5cf3d1536b0502c6291b59c2a13d1b50b98fc4e0f5fe6d5bb5fc490ab';
const apiDisplayHash = 'd82309fba5a612014cff93cc768131adb35481eea1006c3fc8867bbfcb152541';

// Return only a closed category. Error text and paths are inspected locally and
// never copied into the report, even for an unknown error or a native code.
function errorKind(error) {
  const texts = (error?.content ?? []).filter(item => item?.type === 'text' && typeof item.text === 'string' &&
    !/^(?:## Computer Use|# Computer Use Confirmations Policy|# Other Browser APIs|# Browser Safety)\n/.test(item.text))
    .map(item => item.text.slice(0, 16000));
  const value = [typeof error?.code === 'string' ? error.code : '',
    typeof error?.message === 'string' ? error.message.slice(0, 16000) : '', ...texts].join('\n');
  if (/^Input lease: a bundle ID and full window header are required\. Missing target identity: bundle ID, full window header\./m.test(value))
    return 'input-lease-target-missing';
  if (/\bEPERM\b|operation[- ]not[- ]permitted/i.test(value)) return 'operation-not-permitted';
  if (/\bEACCES\b|permission[- ]denied/i.test(value)) return 'permission-denied';
  if (/\bsandbox\b/i.test(value)) return 'sandbox';
  if (/\bkernel\b/i.test(value)) return 'kernel';
  if (typeof error?.code === 'number' || /\b(?:native error code|error code|errno|OSStatus)\s*[:=]?\s*-?\d+\b/i.test(value)) return 'native-error-code';
  return 'unclassified';
}

// These describe the private reply's format, not its provenance. Unknown heading
// values become a fixed enum; document and policy text never enter the report.
function documentationStructure(result, includeUnknownHeadingTitles = false) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const native = item => item?.type === 'text' && typeof item.text === 'string' && item.text.startsWith('## Computer Use\n');
  const docs = content.filter(native), text = docs.length === 1 ? docs[0].text : '';
  const fences = [...text.matchAll(/## API\n\n```typescript\n([\s\S]*?)\n```/g)];
  const body = fences.length === 1 ? fences[0][1] : undefined;
  const policy = text.indexOf('\n# Computer Use Confirmations Policy\n');
  const allowed = new Set(['Computer Use', 'API', 'Native apps', 'Workflow', 'Output', 'Notes']);
  const titles = [...text.slice(0, policy < 0 ? text.length : policy).matchAll(/^#{1,6} (.+)$/gm)].map(match => match[1]);
  const headings = titles.map(title => allowed.has(title) ? title : 'unknown-heading');
  const markers = content.filter(item => !native(item));
  const marker = item => item?.type === 'text' && /^\[sleight:guard-ready\]\n?$/.test(item.text ?? '');
  const structure = {
    nativeItemCount: docs.length, contentTextOnly: content.every(item => item?.type === 'text' && typeof item.text === 'string'),
    itemKeysKnown: content.every(item => Object.keys(item ?? {}).every(key => ['type', 'text'].includes(key))),
    apiFenceCount: fences.length, apiBodyCharacters: body?.length ?? null,
    apiBodySha256: body === undefined ? null : sha(body), expectedApiHashMatches: body !== undefined && sha(body) === apiFullHash,
    policyBoundaryPresent: policy >= 0, headingsBeforePolicy: headings.slice(0, 32), headingsAllowed: !headings.includes('unknown-heading'),
    guardReadyCount: markers.filter(marker).length, guardMarkerMatch: markers.every(marker), formatReasons: [],
  };
  for (const [valid, reason] of [[docs.length === 1, 'native-document-count'], [structure.contentTextOnly, 'non-text-item'],
    [structure.itemKeysKnown, 'item-keys'], [fences.length === 1, 'api-fence-count'],
    [structure.expectedApiHashMatches, 'api-body-hash'], [structure.policyBoundaryPresent, 'policy-boundary-missing'],
    [structure.headingsAllowed, 'heading-before-policy'], [structure.guardMarkerMatch, 'guard-marker-mismatch']]) {
    if (!valid) structure.formatReasons.push(reason);
  }
  if (includeUnknownHeadingTitles === true) {
    structure.unknownHeadingTitlesAvailable = !result?.isError && docs.length === 1 && structure.contentTextOnly &&
      structure.itemKeysKnown && structure.expectedApiHashMatches && structure.policyBoundaryPresent && structure.guardMarkerMatch;
    structure.unknownHeadingTitles = structure.unknownHeadingTitlesAvailable
      ? titles.filter(title => !allowed.has(title)).slice(0, 4).map(title => title.slice(0, 120)) : [];
  }
  return structure;
}

function compareDelivered(full, changed) {
  const fence = apiFence(full), display = apiFence(changed);
  const at = fence && fence.index + fence[0].indexOf(fence[1]);
  const policy = full?.indexOf('\n# Computer Use Confirmations Policy\n') ?? -1;
  return {
    removedCharacters: typeof full === 'string' && typeof changed === 'string' ? full.length - changed.length : 0,
    apiExact: !!fence && !!display && sha(fence[1]) === apiFullHash && sha(display[1]) === apiDisplayHash,
    policyUnchanged: policy >= 0 && changed?.endsWith(full.slice(policy)) === true,
    outsideFenceUnchanged: !!fence && changed?.slice(0, at) === full.slice(0, at) && changed.endsWith(full.slice(at + fence[1].length)),
  };
}
function projection(result) {
  const origin = documentationOrigin();
  const request = { id: 'documentation-check', method: 'tools/call' };
  origin.begin(request, 'isolated', { appFree: true }); origin.sent(request, 'isolated');
  const reply = { id: request.id, result }; origin.reply(reply, 'isolated');
  const out = origin.project(reply.result?.content ?? [], { context: 'isolated' });
  const full = result?.content?.find(item => item.type === 'text' && item.text?.startsWith('## Computer Use\n'))?.text;
  const changed = out.content.find(item => item.type === 'text' && item.text?.startsWith('## Computer Use\n'))?.text;
  const fence = full && /## API\n\n```typescript\n([\s\S]*?)\n```/.exec(full);
  const at = fence && fence.index + fence[0].indexOf(fence[1]);
  const policy = full?.indexOf('\n# Computer Use Confirmations Policy\n') ?? -1;
  return { removedCharacters: full && changed ? full.length - changed.length : 0,
    policyUnchanged: policy >= 0 && changed?.endsWith(full.slice(policy)) === true,
    outsideFenceUnchanged: !!fence && changed?.slice(0, at) === full.slice(0, at) && changed.endsWith(full.slice(at + fence[1].length)) };
}

// Static checks establish format compatibility, never the origin of a live reply.
export function checkDocumentationFormat(text) {
  const measured = projection({ content: [{ type: 'text', text }] });
  return { id: 'documentation-format', status: measured.removedCharacters === 201 ? 'pass' : 'warn', ...measured,
    reason: measured.removedCharacters === 201 ? 'the owned documentation API fence can remove 201 characters'
      : 'documentation format changed; the origin projection leaves the response whole' };
}

// A fresh raw client, one fixed app-free warmup, then owned-child cleanup. No inventory or app query.
export async function documentationBootstrapChecks(server, env, { open = openClient, signal, includeUnknownHeadingTitles = false } = {}) {
  const started = performance.now(); let client, prompts = 0, output, cleanup, attempted = false;
  const abort = () => { void client?.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    attempted = true;
    client = await open({ command: server.command, args: server.args, env: diagnosticEnvironment({ ...env, ...server.env }),
      turnMeta: true, name: 'sleight-documentation-bootstrap', timeoutMs: 6000, startupTimeoutMs: 6000, requireGroupCollection: true,
      approve: () => { prompts++; return { action: 'decline' }; } });
    signal?.throwIfAborted();
    const reply = await client.call('js', { code: replSetupCode(), title: 'Prepare sleight REPL', timeout_ms: 5000 }, 6000);
    signal?.throwIfAborted();
    const measured = projection(reply);
    output = { id: 'documentation-bootstrap', status: !prompts && !reply?.isError && measured.removedCharacters === 201 ? 'pass' : 'warn',
      completed: true, prompts, ...measured, structure: documentationStructure(reply, includeUnknownHeadingTitles), resultKeys: Object.keys(reply ?? {}).sort(),
      metadataShape: Object.fromEntries(Object.entries(reply?._meta ?? {}).map(([key, value]) => [key,
        value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value])),
      items: (reply?.content ?? []).map(item => ({
        type: item?.type, keys: Object.keys(item ?? {}).sort(),
        ...(typeof item?.text === 'string' ? { characters: item.text.length, sha256: sha(item.text) } : {}),
      })) };
    if (prompts || reply?.isError) {
      output.status = 'fail'; output.reason = prompts ? 'unexpected prompt declined' : 'the warmup returned an error';
      if (reply?.isError) output.errorKind = errorKind(reply);
    }
    else if (output.status !== 'pass') output.reason = 'the warmup did not return the known isolated documentation shape; projection stays off';
  } catch (error) {
    cleanup = error.cleanupReceipt;
    output = { id: 'documentation-bootstrap', status: 'error', completed: false, prompts,
      errorKind: errorKind(error), reason: 'the bounded app-free warmup did not complete' };
  } finally {
    signal?.removeEventListener('abort', abort);
    if (client) {
      await client.close().catch(() => false);
      cleanup = client.cleanupReceipt?.();
    }
    cleanup ??= attempted ? uncertain() : { started: false, childCollected: true, groupCollected: true };
    output = { ...output, cleanup };
    if (!collectionCertain(cleanup))
      output = { ...output, status: 'fail', reason: 'owned engine child or process-group collection was not confirmed' };
  }
  return { ...output, ms: Math.round(performance.now() - started) };
}

// These values come from the launcher's actual parsed JSON replies, never a local
// projection. The standalone inventory read does not acquire or drive an app.
export async function documentationRelayChecks(launcher, env, { open = openClient, signal } = {}) {
  const started = performance.now(), sessions = [], receipts = [];
  let client, prompts = 0, output, attempted = false;
  const abort = () => { void client?.close(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const name of ['baseline', 'candidate']) {
      const selected = { ...diagnosticEnvironment(env), SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_WARM_REPL: '1', SLEIGHT_WARM_ENGINE: '0' };
      delete selected.SLEIGHT_ENGINE_DOCS;
      if (name === 'baseline') selected.SLEIGHT_ENGINE_DOCS = 'full';
      signal?.throwIfAborted();
      let result, cleanup;
      try {
        attempted = true;
        client = await open({ command: launcher, env: selected, name: 'sleight-documentation-relay', requireGroupCollection: true,
          timeoutMs: 8000, startupTimeoutMs: 6000, approve: () => { prompts++; return { action: 'decline' }; } });
        signal?.throwIfAborted();
        result = await client.call('js', { code: 'await cua.getState({emit:false});',
          title: 'Check native documentation delivery', timeout_ms: 5000 }, 8000);
        signal?.throwIfAborted();
      } catch (error) { cleanup = error.cleanupReceipt; throw error; }
      finally {
        if (client) { await client.close().catch(() => false); cleanup = client.cleanupReceipt?.(); client = undefined; }
        receipts.push(cleanup ?? uncertain());
      }
      sessions.push({ name, result });
      if (!collectionCertain(receipts.at(-1))) break;
    }
    const nativeDoc = result => {
      const items = result?.content?.filter(item => item.type === 'text' && item.text?.startsWith('## Computer Use\n')) ?? [];
      return items.length === 1 ? items[0].text : undefined;
    };
    const baseline = nativeDoc(sessions[0]?.result), candidate = nativeDoc(sessions[1]?.result);
    const measured = compareDelivered(baseline, candidate);
    const passed = sessions.length === 2 && !prompts && sessions.every(session => !session.result?.isError) &&
      measured.removedCharacters === 201 && measured.apiExact && measured.policyUnchanged && measured.outsideFenceUnchanged;
    output = { id: 'documentation-relay', status: passed ? 'pass' : 'fail', completed: sessions.length === 2, prompts, ...measured,
      sessions: sessions.map(({ name, result }) => ({ name, serializedBytes: Buffer.byteLength(JSON.stringify(result ?? null)),
        documentationCharacters: nativeDoc(result)?.length ?? 0, isError: !!result?.isError,
        ...(result?.isError ? { errorKind: errorKind(result) } : {}) })) };
    if (!passed) output.reason = 'actual relay replies did not prove the exact documentation cut with unchanged policy and surrounding text';
  } catch (error) {
    output = { id: 'documentation-relay', status: 'error', completed: false, prompts,
      errorKind: errorKind(error), reason: 'the bounded relay delivery check did not complete' };
  } finally {
    signal?.removeEventListener('abort', abort);
    const cleanup = { childCollected: receipts.length > 0 ? receipts.every(receipt => receipt.childCollected === true) : !attempted,
      groupCollected: receipts.length > 0 ? receipts.every(receipt => receipt.groupCollected === true) : !attempted, receipts };
    output = { ...output, cleanup };
    if (!collectionCertain(cleanup)) output = { ...output, status: 'fail', reason: 'relay child or process-group collection is unproved' };
  }
  return { ...output, ms: Math.round(performance.now() - started) };
}
