import { serveV3Worker } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
serveV3Worker({ channel: process, browser: 'bfixture', async begin(message) {
  return { async call(request) {
    if (request.name !== 'browser_read') throw Error('unsupported fixture method');
    return { text: 'fork read for ' + message.turn, isError: false };
  }, delivered: () => true, async end() { return { revoked: true, cleanup: [] }; } };
} }).ready();
