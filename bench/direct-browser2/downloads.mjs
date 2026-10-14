import { bounded, granted, receipt, sameScope, validScope } from './attachment.mjs';

// Semantic reference only: FowlBrowser MIT 8b689249ba4e33d2626487aad930605c62e2c6a7,
// mcp/src/browserData.mjs. CDP GUIDs are not extension download IDs.
// Default observation deliberately sends no Browser.setDownloadBehavior command.
export class DownloadObserver {
  constructor({ session, authorize, timeoutMs = 1000, redactFilename = () => 'download' }) {
    this.session = session;
    this.authorize = authorize;
    this.timeoutMs = timeoutMs;
    this.redactFilename = redactFilename;
    this.operations = new Map();
    this.records = new Map();
    this.onBegin = event => this.begin(event);
    this.onProgress = event => this.progress(event);
    session.on('Browser.downloadWillBegin', this.onBegin);
    session.on('Browser.downloadProgress', this.onProgress);
  }
  async start({ mode = 'observe-default', contextId, downloadPath, proveOwnedContext } = {}) {
    if (mode === 'observe-default') {
      this.contextId = undefined;
      return { state: 'event-only', qualification: 'event-delivery-unknown', policyChanged: false };
    }
    if (mode !== 'allowAndName' || typeof contextId !== 'string' || !contextId || !downloadPath?.startsWith('/') ||
      typeof proveOwnedContext !== 'function' || await bounded(() => proveOwnedContext(contextId, downloadPath), this.timeoutMs) !== true) throw Error('owned non-default context required');
    await bounded(() => this.session.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName', browserContextId: contextId, downloadPath, eventsEnabled: true,
    }), this.timeoutMs);
    this.contextId = contextId;
    return { state: 'owned-context', policyChanged: true };
  }
  async arm(scope, { frameId, causalToken }) {
    const contextId = this.contextId;
    if (!validScope(scope) || frameId !== scope.frameId || !causalToken || this.operations.has(causalToken)) throw Error('INVALID_DOWNLOAD_OPERATION');
    if (!await granted(this.authorize, scope, 'download-observe', this.timeoutMs)) throw Error('PERMISSION_REQUIRED');
    if (this.operations.has(causalToken)) throw Error('INVALID_DOWNLOAD_OPERATION');
    this.operations.set(causalToken, { scope: Object.freeze({ ...scope }), frameId, contextId });
  }
  begin(event) {
    if (typeof event.guid !== 'string' || !event.guid || this.records.has(event.guid)) return;
    // Browser events are socket-wide. Ignore observations outside armed, granted frames.
    let origin;
    try { origin = new URL(event.url).origin; } catch {}
    if (![...this.operations.values()].some(operation => operation.frameId === event.frameId && operation.scope.origin === origin)) return;
    const filename = String(event.suggestedFilename ?? 'download').split(/[\\/]/).at(-1)
      .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) || 'download';
    this.records.set(event.guid, { frameId: event.frameId, filename, guid: event.guid,
      origin, state: 'inProgress', receipt: receipt(null, 'observed', 'unknown', 'unattributed') });
  }
  async attribute(guid, scope, { causalToken, trusted } = {}) {
    const record = this.records.get(guid);
    const operation = this.operations.get(causalToken);
    // trusted is an INTERNAL broker correlation verdict, never a page/model argument.
    if (!record || trusted !== true || !operation || !sameScope(scope, operation.scope) ||
      record.frameId !== operation.frameId || record.origin !== scope.origin || record.scope || operation.guid) return receipt(scope, 'prepared', 'none', 'unattributed');
    if (!await granted(this.authorize, scope, 'download-attribute', this.timeoutMs, { guid })) return receipt(scope, 'prepared', 'none', 'permission-required');
    if (record.scope || operation.guid) return receipt(scope, 'prepared', 'none', 'unattributed');
    record.scope = operation.scope;
    record.contextId = operation.contextId;
    operation.guid = guid;
    record.receipt = receipt(scope, 'observed', 'unknown', record.state === 'completed' ? 'verify-artifact' : null);
    return this.get(guid);
  }
  progress(event) {
    const record = this.records.get(event.guid);
    if (!record || !['inProgress', 'completed', 'canceled'].includes(event.state) || record.state !== 'inProgress') return;
    record.state = event.state;
    // CDP filePath is optional and is never an authorized regular-file proof.
    record.receipt.next = record.scope ? event.state === 'completed' ? 'verify-artifact' : event.state === 'canceled' ? 'download-canceled' : null : 'unattributed';
  }
  get(guid) {
    const record = this.records.get(guid);
    return record ? { ...structuredClone(record.receipt), guid,
      filename: record.scope ? this.redactFilename(record.filename, record.scope) : 'download', state: record.state } : null;
  }
  async cancel(guid, scope) {
    const record = this.records.get(guid);
    if (!record?.scope || !sameScope(record.scope, scope) || !await granted(this.authorize, scope, 'download-cancel', this.timeoutMs, { guid })) return receipt(scope, 'prepared', 'none', 'permission-required');
    try {
      // cancelDownload's omitted context is default; only exact causally attributed GUIDs reach it.
      await bounded(() => this.session.send('Browser.cancelDownload', { guid,
        ...(record.contextId ? { browserContextId: record.contextId } : {}),
      }), this.timeoutMs);
      return receipt(scope, 'dispatched', 'unknown', 'await-terminal-event');
    } catch { return receipt(scope, 'dispatched', 'unknown', 'reconcile-before-retry'); }
  }
  nativeSave(scope) { return receipt(scope, 'prepared', 'none', 'native-save-handoff'); }
  dispose() {
    this.session.off('Browser.downloadWillBegin', this.onBegin);
    this.session.off('Browser.downloadProgress', this.onProgress);
  }
}
