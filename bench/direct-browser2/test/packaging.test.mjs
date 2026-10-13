import test from 'node:test';
import assert from 'node:assert/strict';
import { packageReadiness, versionHandshake } from '../perf.mjs';

const build = 'a'.repeat(40);
const hello = () => ({ protocol: 1, bundle: build, helpers: build });
const plan = () => ({ extensionInstall: false, nativeHostRegistration: false, launchAtLogin: false,
  ownerProfileMutation: false, idleLifetime: 'until-disconnect', nativeHost: 'sleight-local-ui',
  hostOutsidePage: true, hostSessionBound: true, hostOperationBound: true,
  ownerAccepted: true, peerCredentialsQualified: true, assemblyQualified: true,
  dependencies: [{ name: 'prototype', version: build, license: 'MIT', bundled: true, notice: 'included' }] });
test('unknown owner choices and missing assembly keep packaging unqualified', () => {
  const result = packageReadiness({ ...plan(), idleLifetime: null, nativeHost: null, assemblyQualified: false });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ['idleLifetime', 'nativeHost', 'assemblyQualified']);
});
test('extension registration, login services and profile mutation are not package prerequisites', () => {
  assert.equal(packageReadiness(plan()).ready, true);
  for (const field of ['extensionInstall', 'nativeHostRegistration', 'launchAtLogin', 'ownerProfileMutation']) {
    assert.throws(() => packageReadiness({ ...plan(), [field]: true }), /PACKAGE_SCOPE/);
  }
});
test('dependency versions and redistribution notices are explicit', () => {
  for (const key of ['version', 'license', 'notice']) {
    const p = plan(); delete p.dependencies[0][key];
    assert.equal(packageReadiness(p).ready, false);
  }
});
test('a dependency inventory containing only a hole cannot be ready', () => {
  const result = packageReadiness({ ...plan(), dependencies: Array(1) });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ['dependencies']);
  assert.equal(result.releaseAuthorized, false);
});
test('a valid dependency followed by a hole cannot be a complete inventory', () => {
  const p = plan(); p.dependencies.length = 2;
  const result = packageReadiness(p);
  assert.equal(result.ready, false);
  assert.deepEqual(result.missing, ['dependencies']);
  assert.equal(result.releaseAuthorized, false);
});
test('packaging follows the settled owner lifetime and local UI decisions', () => {
  for (const idleLifetime of ['last-session', 'silent-idle-reconnect']) {
    assert.deepEqual(packageReadiness({ ...plan(), idleLifetime }).missing, ['idleLifetime']);
  }
  for (const nativeHost of ['page-overlay', 'model-approval', 'qualified-host']) {
    assert.deepEqual(packageReadiness({ ...plan(), nativeHost }).missing, ['nativeHost']);
  }
  assert.equal(packageReadiness(plan()).releaseAuthorized, false);
});
test('local UI metadata requires outside-page, session and exact-operation binding', () => {
  for (const field of ['hostOutsidePage', 'hostSessionBound', 'hostOperationBound']) {
    const p = plan(); delete p[field];
    assert.deepEqual(packageReadiness(p).missing, [field]);
    assert.deepEqual(packageReadiness({ ...plan(), [field]: false }).missing, [field]);
  }
});
test('handshake never mixes protocol, bundle or helper generations', () => {
  assert.equal(versionHandshake(hello(), hello()).compatible, true);
  for (const field of ['protocol', 'bundle', 'helpers']) {
    const changed = hello(); changed[field] = field === 'protocol' ? 2 : 'b'.repeat(40);
    assert.equal(versionHandshake(hello(), changed).compatible, false);
  }
  assert.equal(versionHandshake(hello(), null).compatible, false);
  assert.equal(versionHandshake({ ...hello(), protocol: 2 }, { ...hello(), protocol: 2 }).compatible, false);
});
test('broker restart truthfully loses acceptance and requests deliberate reconnection', () => {
  const result = versionHandshake(hello(), hello(), { restarted: true, inFlight: true });
  assert.equal(result.needsConsent, true);
  assert.equal(result.effect, 'unknown');
  assert.equal(result.autoReconnect, false);
});
