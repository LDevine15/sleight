import { readCode } from './document-scope.mjs';

export const replSetupCode = () => readCode('void 0;', { acknowledge: true });

export class ReplWarmup {
  constructor({ enabled, request, resume, refuse }) {
    Object.assign(this, { request, resume, refuse });
    this.state = enabled ? 'cold' : 'off';
    this.waiting = [];
    this.docs = [];
  }

  hold(msg) {
    if (msg.method === 'initialize') this.initializeId = msg.id;
    if (msg.method !== 'tools/call' || !['js', 'js_reset'].includes(msg.params?.name)) return false;
    // In-process callers without MCP initialization keep the ordinary first-call path.
    if (this.state === 'cold') this.state = 'used';
    if (this.state !== 'warming') return false;
    this.waiting.push(msg);
    return true;
  }

  sent(msg) {
    if (msg.method === 'notifications/initialized') { this.notified = true; this.start(); }
  }

  reply(msg) {
    if (this.initializeId === undefined || msg.id !== this.initializeId || msg.method !== undefined) return;
    this.ready = !!msg.result && !msg.error && !msg.result.isError;
    if (this.ready) this.start();
  }

  start() {
    if (this.state !== 'cold' || !this.ready || !this.notified) return;
    this.state = 'warming';
    try { Promise.resolve(this.request(replSetupCode())).then(reply => this.finish(reply), () => this.finish({})); }
    catch { this.finish({}); }
  }

  finish(reply) {
    if (this.state !== 'warming') return;
    this.state = 'done';
    this.retainDocs(reply);
    for (const msg of this.waiting.splice(0)) this.resume(msg);
  }

  retainDocs(reply) {
    if (this.state === 'cancelled') return;
    // A private call can consume the engine's first-call docs even if setup fails.
    // Deliver every docs block to the first real JS result, through the normal policy path.
    this.docs.push(...(reply.result?.content ?? []).filter(c => c.type === 'text' && /(?:^|\n)#{1,6} /.test(c.text)));
  }

  attach(msg) {
    if (!this.docs.length || !Array.isArray(msg.result?.content)) return;
    msg.result.content = [...this.docs.splice(0), ...msg.result.content];
  }

  cancel() {
    this.state = 'cancelled';
    this.docs = [];
    for (const msg of this.waiting.splice(0)) this.refuse(msg);
  }
}
