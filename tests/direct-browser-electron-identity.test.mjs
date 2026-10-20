// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_USERS = ['', 'Users', ''].join('/');
import { existsSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsentUi, escapeLabel } from '../plugins/sleight/lib/direct-browser/consent-ui.mjs';
import { createUserFileProvider } from '../plugins/sleight/lib/direct-browser/files.mjs';
import { createFileAuthority } from '../plugins/sleight/lib/direct-browser/host-files.mjs';
import { api, instance, frame, file, live, bind } from './fixtures/electron-app.mjs';

test('equal opaque null origins on different files are different documents', () => {
  const app = bind(), a = app.classify(file('a.html'), 'null'), b = app.classify(file('b.html'), 'null');
  assert.notEqual(a.origin, b.origin);
  assert.equal(app.classify(file('a.html'), 'null').origin, a.origin);
  assert.equal(app.classify(file('a.html'), 'file://').origin, a.origin, 'Chromium reports file:// for a file origin');
  assert.match(a.origin, /^app-document:v1:[0-9a-f]{64}$/); assert.equal(a.principal.kind, 'app-document');
  assert.equal(a.principal.path, '/Applications/Fixture.app/Contents/Resources/app/a.html');
});
test('the same file differs across window epoch, PID and build', () => {
  const base = bind().classify(file('a.html'), 'null').origin;
  assert.notEqual(bind({ window: { id: 7, epoch: 2 } }).classify(file('a.html'), 'null').origin, base);
  assert.notEqual(bind({ window: { id: 8, epoch: 1 } }).classify(file('a.html'), 'null').origin, base);
  assert.notEqual(bind({ instance: { ...instance, pid: 4243 } }).classify(file('a.html'), 'null').origin, base);
  assert.notEqual(bind({ instance: { ...instance, pidBirth: '1760000001.5' } }).classify(file('a.html'), 'null').origin, base);
  assert.notEqual(bind({ instance: { ...instance, version: '1.2.4' } }).classify(file('a.html'), 'null').origin, base);
  assert.notEqual(bind({ instance: { ...instance, profile: `${MAC_USERS}fixture/Other` } }).classify(file('a.html'), 'null').origin, base);
  assert.notEqual(bind({ brokerEpoch: 4 }).incarnation, bind().incarnation);
  assert.notEqual(bind({ authority: { id: 'grant2', session: 'session', turn: null, current: () => true } }).incarnation, bind().incarnation);
});
test('a custom scheme listed in the recipe is an app document at its host', () => {
  const app = bind(), a = app.classify(frame('fixture://main/index.html?x=1#y'), 'fixture://main'), b = app.classify(frame('fixture://main/other.html'), 'null');
  assert.equal(a.origin, b.origin); assert.equal(a.principal.host, 'main'); assert.equal(a.principal.scheme, 'fixture');
  assert.notEqual(app.classify(frame('fixture://settings/'), 'null').origin, a.origin);
});
for (const [label, url, observed] of [
  ['an unlisted custom scheme', 'other://main/x', 'null'], ['a data document', 'data:text/html,hi', 'null'], ['a blob document', 'blob:https://x.invalid/1', 'https://x.invalid'],
  ['about:blank', 'about:blank', 'null'], ['an extension page', 'chrome-extension://abc/page.html', 'null'], ['plain http', 'http://x.invalid/', 'http://x.invalid'],
  ['a file outside the recipe roots', `file://${MAC_USERS}fixture/secret.html`, 'null'], ['a file path climbing out of the root', 'file:///Applications/Fixture.app/Contents/Resources/app/../../../../secret.html', 'null'],
  ['a file with an encoded slash', 'file:///Applications/Fixture.app/Contents/Resources/app/a%2f..%2f..%2fb.html', 'null'],
  ['a remote file host', 'file://server/Applications/Fixture.app/Contents/Resources/app/a.html', 'null'],
  ['credentials in a remote origin', 'https://user:pass@pay.invalid/', 'https://pay.invalid'],
  ['a file whose page reports a web origin', 'file:///Applications/Fixture.app/Contents/Resources/app/a.html', 'https://pay.invalid'],
  ['a custom scheme whose page reports another origin', 'fixture://main/x', 'https://pay.invalid'],
  ['a remote frame whose page reports another origin', 'https://pay.invalid/', 'https://other.invalid'],
]) test('classification refuses ' + label, () => assert.throws(() => bind().classify(frame(url), observed), /APP_DOCUMENT_UNSUPPORTED/));
test('a recipe cannot list a scheme that is never an app document, or a file root of /', () => {
  for (const schemes of [['data'], ['blob'], ['javascript'], ['https'], ['file'], ['app-document'], ['Fixture'], ['a b']])
    assert.throws(() => bind({ recipe: { schemes, fileRoots: [] } }), /INVALID_APP_RECIPE/, JSON.stringify(schemes));
  for (const fileRoots of [['/'], ['relative/root'], ['/a/../b']]) assert.throws(() => bind({ recipe: { schemes: [], fileRoots } }), /INVALID_APP_RECIPE/);
  assert.throws(() => bind({ recipe: { schemes: [], fileRoots: [] } }).classify(file('a.html'), 'null'), /APP_DOCUMENT_UNSUPPORTED/, 'files need a recipe root');
});
test('a remote HTTPS child frame keeps its real origin and is bound to the app instance', () => {
  const app = bind(), parent = file('index.html'), child = app.classify(frame('https://pay.invalid/checkout', parent), 'https://pay.invalid');
  assert.equal(child.origin, 'https://pay.invalid'); assert.equal(child.principal.kind, 'web-in-app');
  assert.equal(child.principal.incarnation, app.incarnation);
  assert.notEqual(bind({ instance: { ...instance, pid: 1 } }).incarnation, app.incarnation, 'the incarnation field of the identity carries the app instance');
});
test('an app document hosted under a remote page is refused', () => {
  const remote = frame('https://pay.invalid/');
  assert.throws(() => bind().classify(frame('fixture://main/x', remote), 'null'), /APP_DOCUMENT_UNSUPPORTED/);
  assert.throws(() => bind().classify(frame('about:blank', file('index.html')), 'null'), /APP_DOCUMENT_UNSUPPORTED/);
  assert.equal(bind().classify(frame('fixture://main/x', file('index.html')), 'null').principal.kind, 'app-document');
});
test('a revoked or ended authority refuses classification', () => {
  const app = bind(); assert.equal(app.current(), true);
  live.value = false; try { assert.equal(app.current(), false); assert.throws(() => app.classify(file('a.html'), 'null'), /APP_DOCUMENT_UNSUPPORTED/); } finally { live.value = true; }
  const throwing = bind({ authority: { id: 'g', session: 'session', turn: null, current() { throw Error('boom'); } } });
  assert.equal(throwing.current(), false);
});
test('only the trusted adapter mints a binding, and the shape is closed', () => {
  assert.equal(api.isAppBinding(bind()), true);
  for (const forged of [{}, { kind: 'app-document' }, { ...bind() }, JSON.parse(JSON.stringify(bind())), null, 'app']) assert.equal(api.isAppBinding(forged), false);
  for (const bad of [{ instance: { ...instance, approved: true } }, { instance: { ...instance, profile: 'relative' } }, { instance: { ...instance, pid: 0 } },
    { instance: { ...instance, bundleId: 'x y' } }, { instance: { ...instance, temporary: 'no' } }, { window: { id: 1 } }, { brokerEpoch: 0 },
    { authority: { id: 'g', session: 'bad session', turn: null, current: () => true } }, { authority: { id: 'g', session: 'session', current: () => true } }])
    assert.throws(() => bind(bad), /INVALID_APP_(?:INSTANCE|BINDING)/, JSON.stringify(Object.keys(bad)));
});
test('the persistent app key follows build and profile, never the process', () => {
  const key = api.appKey(instance);
  assert.equal(api.appKey({ ...instance, pid: 1, pidBirth: 'other' }), key);
  for (const change of [{ version: '1.2.4' }, { signer: 'OTHERTEAM' }, { runtime: 'electron/40.0.0' }, { profile: `${MAC_USERS}fixture/Other` }, { bundleId: 'invalid.fixture.other' },
    { cdhash: 'b'.repeat(40) }, { cdhash: 'c'.repeat(64) }, { executable: '/Applications/Other.app/Contents/MacOS/Fixture' }])
    assert.notEqual(api.appKey({ ...instance, ...change }), key, JSON.stringify(change));
  for (const bad of [{ cdhash: 'A'.repeat(40) }, { cdhash: 'a'.repeat(39) }, { executable: 'Fixture' }, { executable: '/Applications/../x' }]) assert.throws(() => api.appKey({ ...instance, ...bad }), /INVALID_APP_INSTANCE/);
  const { executable, ...missing } = instance;
  assert.throws(() => api.appKey(missing), /INVALID_APP_INSTANCE/, 'consent is bound to code: no executable, no key');
});

// What codesign -dvvv prints for a Developer ID signed Electron app (shape only; names are made up).
const codesignText = `Executable=/Applications/Fixture.app/Contents/MacOS/Fixture
Identifier=invalid.fixture.app
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded
CandidateCDHash sha256=${'d'.repeat(40)}
CDHash=${'a'.repeat(40)}
Authority=Developer ID Application: Fixture Corp (TEAM123456)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=TEAM123456
`;
test('the app instance comes from the code signature and bundle plists, never from caller strings', async () => {
  assert.deepEqual(api.parseCodesign(codesignText), { executable: '/Applications/Fixture.app/Contents/MacOS/Fixture', identifier: 'invalid.fixture.app',
    cdhash: 'a'.repeat(40), team: 'TEAM123456', authority: 'Developer ID Application: Fixture Corp (TEAM123456)' });
  assert.throws(() => api.parseCodesign(codesignText.replace(/^CDHash=.*$/m, '')), /CODE_IDENTITY_UNAVAILABLE/);
  const facts = { verified: true, codesign: api.parseCodesign(codesignText), info: { CFBundleIdentifier: 'invalid.fixture.app', CFBundleName: 'Fixture App',
    CFBundleShortVersionString: '1.2.3' }, electron: { CFBundleVersion: '39.0.0' } };
  const process = { bundle: '/Applications/Fixture.app', executable: '/Applications/Fixture.app/Contents/MacOS/Fixture',
    profile: `${MAC_USERS}fixture/Library/Application Support/FixtureApp`, temporary: false, pid: 4242, pidBirth: '1760000000.25' };
  const seen = [];
  const derived = api.deriveAppInstance(process, { inspect: bundle => { seen.push(bundle); return facts; } });
  assert.deepEqual(seen, ['/Applications/Fixture.app']);
  assert.deepEqual({ ...derived }, { name: 'Fixture App', bundleId: 'invalid.fixture.app', signer: 'TEAM123456', version: '1.2.3', runtime: 'electron/39.0.0',
    profile: process.profile, pid: 4242, pidBirth: '1760000000.25', executable: process.executable, cdhash: 'a'.repeat(40), temporary: false });
  assert.equal(api.appKey(derived), api.appKey(instance));
  for (const [label, change] of [['unverified', { verified: false }], ['other executable', { codesign: { ...facts.codesign, executable: '/tmp/evil' } }],
    ['identifier mismatch', { info: { ...facts.info, CFBundleIdentifier: 'invalid.other' } }], ['not electron', { electron: undefined }],
    ['unsigned', { codesign: { ...facts.codesign, team: undefined } }]])
    assert.throws(() => api.deriveAppInstance(process, { inspect: () => ({ ...facts, ...change }) }), /CODE_IDENTITY_UNAVAILABLE/, label);
  assert.throws(() => api.deriveAppInstance({ ...process, signer: 'TEAM123456' }, { inspect: () => facts }), /INVALID_APP_PROCESS/, 'a caller cannot supply the signer');
  assert.throws(() => api.deriveAppInstance({ ...process, executable: '/Applications/Other.app/Contents/MacOS/Fixture' }, { inspect: () => facts }), /INVALID_APP_PROCESS/,
    'the executable must be inside the bundle');
});

// The shared consent now speaks app documents. Web checks stay as they were.
function operation(app, overrides = {}) {
  const { origin, principal } = app.classify(file('a.html'), 'null');
  return { browserIncarnation: app.incarnation, brokerEpoch: 1, clientSession: 'session', turn: 'turn', leaseGeneration: 1, target: 'd1', frame: 'd1', document: 'd1',
    sequence: 1, origin, action: 'click', args: { ref: 'e1', key: null, accept: null }, destination: origin + '/',
    payment: { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop', method: 'Fixture card' }, principal, ...overrides };
}
function consentFixture() {
  const events = new WeakSet(), presented = [];
  const ui = createConsentUi({ authenticate: event => events.delete(event), present: (view, op) => presented.push({ view, op }), checkCurrent: () => true });
  return { ui, events, presented };
}
test('native consent names an app document as one and carries the typed principal', () => {
  const app = bind(), f = consentFixture(), op = operation(app);
  f.ui.request(op);
  assert.equal(f.presented[0].view.documentKind, 'app-document');
  assert.match(f.presented[0].view.origin, /^file:\/\/\/Applications\/Fixture\.app/); assert.doesNotMatch(f.presented[0].view.origin, /^https?:/);
  assert.match(f.presented[0].view.app, /Fixture App 1\.2\.3 \(pid 4242\)/);
  assert.equal(f.presented[0].op.principal.kind, 'app-document');
});
test('a child HTTPS frame in an app shows its real origin as a web destination', () => {
  const app = bind(), f = consentFixture(), { origin, principal } = app.classify(frame('https://pay.invalid/c', file('index.html')), 'https://pay.invalid');
  f.ui.request(operation(app, { origin, destination: origin + '/', principal }));
  assert.equal(f.presented[0].view.documentKind, 'web'); assert.equal(f.presented[0].view.origin, 'https://pay.invalid');
  assert.equal(f.presented[0].view.destinationOrigin, 'https://pay.invalid');
});
test('app labels are escaped before they reach the card', () => {
  const app = bind({ instance: { ...instance, name: 'Evil <b>"App"</b>' } }), f = consentFixture();
  f.ui.request(operation(app)); assert.doesNotMatch(f.presented[0].view.app, /[<>"]/);
  assert.equal(f.presented[0].view.app, escapeLabel('Evil <b>"App"</b> 1.2.3 (pid 4242)'));
});
test('the web-only join refuses an app origin, a missing principal and a forged principal', () => {
  const app = bind(), f = consentFixture(), op = operation(app), { principal, ...untyped } = op;
  assert.throws(() => f.ui.request(untyped), /INVALID_ORIGIN/, 'an app origin string is not a web origin');
  assert.throws(() => f.ui.request({ ...untyped, origin: 'https://pay.invalid', destination: 'https://pay.invalid/', principal: undefined }), /INVALID_OPERATION/);
  const forged = [
    { ...op, principal: { ...principal, path: '/Applications/Fixture.app/Contents/Resources/app/b.html' } },
    { ...op, principal: { ...principal, kind: 'web-in-app' } },
    { ...op, principal: { ...principal, app: { ...principal.app, pid: 1 } } },
    { ...op, principal: { ...principal, incarnation: 'app:v1:' + '0'.repeat(64) } },
    { ...op, principal: { ...principal, extra: true } },
    { ...op, destination: 'https://pay.invalid/' },
    { ...op, origin: 'https://pay.invalid', destination: 'https://pay.invalid/' },
    { ...op, principal: { ...principal, scheme: 'data', host: 'x', path: '' } },
  ];
  forged.forEach((value, index) => assert.throws(() => f.ui.request(value), /INVALID_(?:APP_PRINCIPAL|ORIGIN|OPERATION|DESTINATION)/, 'forged ' + index));
  assert.equal(f.presented.length, 0);
});
test('the web path still refuses every non-HTTP(S) origin and keeps its exact keys', () => {
  const f = consentFixture(), web = { browserIncarnation: 'b', brokerEpoch: 1, clientSession: 's', turn: 't', leaseGeneration: 1, target: 'd', frame: 'd', document: 'd',
    sequence: 1, origin: 'https://pay.invalid', action: 'click', args: { ref: 'e1' }, destination: 'https://pay.invalid/', payment: { amount: '1' } };
  assert.doesNotThrow(() => f.ui.request(web));
  for (const origin of ['null', 'file://', 'file:///a.html', 'fixture://main', 'app-document:v1:' + 'a'.repeat(64)])
    assert.throws(() => f.ui.request({ ...web, origin, destination: 'https://pay.invalid/' }), /INVALID_ORIGIN|Invalid URL/, origin);
  assert.throws(() => f.ui.request({ ...web, destination: 'file:///a.html' }), /INVALID_DESTINATION/);
});

// File bindings: the same checks, with a typed document in place of an HTTPS origin.
const binding = (app, name, extra = {}) => {
  const { origin } = app.classify(file(name), 'null');
  return { browserIncarnation: app.incarnation, brokerEpoch: 1, clientSession: 'session', turn: 'turn', leaseGeneration: 1, target: 'd1', frame: 'd1', document: 'd1', origin, ...extra };
};
test('the file authority binds exact bytes to one app document and refuses a look-alike origin', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'epv3-file-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'resume.txt'); writeFileSync(path, 'fixture bytes');
  const app = bind(), authority = createFileAuthority({ now: () => 100, approve: () => true }), forgedOrigin = 'app-document:v1:' + 'b'.repeat(64);
  const exact = { ...binding(app, 'a.html'), operation: 'upload', ref: 'e1' };
  await assert.rejects(authority.issue([path], { ...exact, origin: forgedOrigin }), /Unsupported file destination/);
  await assert.rejects(authority.issue([path], { ...exact, origin: 'null' }));
  await assert.rejects(authority.issue([path], { ...exact, origin: 'file:///a.html' }), /Unsupported file destination/);
  const capability = await authority.issue([path], exact), other = { ...exact, origin: app.classify(file('b.html'), 'null').origin };
  assert.throws(() => authority.stage(capability, other), /Invalid file capability/, 'same null origin, different file');
});
test('the user file provider keeps two app files apart even though both report the null origin', t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'epv3-file-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'resume.txt'); writeFileSync(path, 'fixture bytes');
  const app = bind(), user = {}; let current = binding(app, 'a.html');
  const provider = createUserFileProvider({ now: () => 100, current: () => current,
    readUserMessage: event => event === user ? { session: 'session', text: `Upload "${path}" to Resume` } : null,
    resolveInput: ref => ref === 'e1' ? { ...binding(app, 'a.html'), ref, name: 'Resume' } : null });
  const handle = provider.offer(user, [path], 'e1'); assert.match(handle, /^f/);
  current = binding(app, 'b.html');
  const other = createUserFileProvider({ now: () => 100, current: () => current, readUserMessage: () => ({ session: 'session', text: `Upload "${path}" to Resume` }),
    resolveInput: ref => ({ ...binding(app, 'a.html'), ref, name: 'Resume' }) });
  assert.throws(() => other.offer({}, [path], 'e1'), /USER_NAMED_FILE_REQUIRED/);
});

test('the production inspection reads a real signature without launching anything', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/codesign') ? 'needs macOS codesign' : false }, () => {
  const facts = api.inspectCode('/System/Applications/Calculator.app');
  assert.equal(facts.verified, true);
  assert.match(facts.codesign.cdhash, /^[0-9a-f]{40}$/);
  assert.equal(facts.codesign.identifier, facts.info.CFBundleIdentifier);
  assert.equal(facts.electron, undefined);
  assert.throws(() => api.deriveAppInstance({ bundle: '/System/Applications/Calculator.app', executable: facts.codesign.executable, profile: '/tmp/p', temporary: true, pid: 1, pidBirth: '1' }),
    /CODE_IDENTITY_UNAVAILABLE/, 'not an Electron app');
});
