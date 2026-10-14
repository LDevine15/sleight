// FowlBrowser takeover.mjs (MIT, 8b689249ba4e33d2626487aad930605c62e2c6a7)
// informed the parking model. No source copied. Physical input is unqualified:
// a page isTrusted flag or a dispatch timestamp is never host authority.
export class TakeoverControls {
  #lifecycle;
  constructor(lifecycle) { this.#lifecycle = lifecycle; }

  pageInput() { return { automaticTakeover: false, status: 'unqualified', next: 'native Pause' }; }

  async handle(action, proof) {
    if (!['pause', 'disconnect', 'takeover'].includes(action)) throw new Error('UNSUPPORTED_CONTROL');
    const before = this.#lifecycle.state;
    const accepted = await this.#lifecycle.authorize(proof, { action, browser: before.browser, fence: before.fence });
    if (!accepted || before.fence !== this.#lifecycle.state.fence) return { accepted: false, code: 'PERMISSION_REQUIRED' };
    if (action === 'disconnect') return { accepted: true, ...await this.#lifecycle.disconnect() };
    else this.#lifecycle.pause(action === 'pause' ? 'native-pause' : 'trusted-host-takeover');
    return { accepted: true, ...this.#lifecycle.state };
  }
}
