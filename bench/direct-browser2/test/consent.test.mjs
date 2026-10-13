import test from 'node:test';

// Qualification inventory, not fake browser UX evidence. These cases require a
// separately dispatched owned-window/native host harness. This lane forbids app
// driving and screenshots. No launch occurs by importing or running this file.
// Do not replace these gates with ordinary remote-debugging-port/pipe tests:
// those flags bypass the consent mechanism being qualified.
export const consentQualification = Object.freeze({
  products: ['Google Chrome 144+', 'Helium'],
  requiredIdentity: ['Browser.getVersion product/version/revision', 'application bundle/version', 'owned process incarnation', 'owned temporary user-data-root'],
  cases: ['toggle on and off', 'prompt buttons and no remember choice', 'connected indicator and one-second asynchronous hookup',
    'prompt Cancel and close', 'infobar dismissal is not revocation', 'last-socket close',
    'broker restart needs new consent', 'browser restart needs new consent and identity', 'setting-off fences queued dispatch'],
  evidence: ['exact consent counts', 'no silent acceptance', 'focus changes limited to explicit setup', 'state table',
    'first-run recording of owned windows', 'exact cleanup', 'CfT absent automation strip remains unknown'],
});

for (const product of consentQualification.products) {
  for (const scenario of consentQualification.cases) {
    test(`${product}: ${scenario}`, { skip: 'Release qualification: native host choice and separate headed owned-window dispatch required; no browser/runtime UX measured' }, () => {});
  }
}
