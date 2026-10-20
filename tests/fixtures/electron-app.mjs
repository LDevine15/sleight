// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import assert from 'node:assert/strict';
// Shared fakes for the Electron identity, consent and context tests. Nothing here launches an app or opens a window.
// A missing module is the expected failure against the old web-only join.
export const api = await import('../../plugins/sleight/lib/direct-browser/electron-identity.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; return {};
});
export const instance = { name: 'Fixture App', bundleId: 'invalid.fixture.app', signer: 'TEAM123456', version: '1.2.3', runtime: 'electron/39.0.0',
  profile: `${MAC_USERS}fixture/Library/Application Support/FixtureApp`, temporary: false, pid: 4242, pidBirth: '1760000000.25',
  executable: '/Applications/Fixture.app/Contents/MacOS/Fixture', cdhash: 'a'.repeat(40) };
export const recipe = { schemes: ['fixture'], fileRoots: ['/Applications/Fixture.app/Contents/Resources/app'] };
export const frame = (url, parent = null) => ({ url: () => url, parentFrame: () => parent });
export const file = name => frame('file:///Applications/Fixture.app/Contents/Resources/app/' + name);
export const live = { value: true };
export function bind(overrides = {}) {
  assert.equal(typeof api.createAppBinding, 'function', 'typed app-document binding is required');
  return api.createAppBinding({ instance, window: { id: 7, epoch: 1 }, brokerEpoch: 3, recipe,
    authority: { id: 'grant1', session: 'session', turn: null, current: () => live.value }, ...overrides });
}
