import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight, main, createReviewedRunner, manifestFiles } from '../scripts/release-preflight.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40);
const identity = { home: '/home/private-fixture', username: 'private-fixture' };
function fixture(overrides = {}) {
  const files = new Map([
    ['README.md', '# sleight\nReady to install.\n'],
    ['CHANGELOG.md', '# Changelog\n\n## 1.4.1 (2026-10-21)\n\n- Fix release checks.\n\n## 1.4.0 (2026-10-20)\nOld notes.\n'],
    ...manifestFiles.map(file => [file, JSON.stringify(file.endsWith('marketplace.json')
      ? { name: 'sleight', plugins: [{ name: 'sleight' }] }
      : { name: 'sleight', version: '1.4.1' })]),
  ]);
  const calls = [];
  const runner = async request => {
    calls.push(request);
    if (overrides[request.step]) return overrides[request.step](request);
    const stdout = { head, base, tag: head, status: '', sources: '', ancestor: '',
      history: 'Release history scan: 0 added line(s) contain private identity data.\n',
      linux: JSON.stringify({ platform: 'linux', command: ['npm', 'test'], exitCode: 0, executed: true }) }[request.step];
    return { status: 0, stdout };
  };
  files.set('private-terms.json', '["Private Fixture Name"]');
  const options = { root: '/fixture', mode: 'release', tag: 'v1.4.1', identity, runner, privateTerms: ['Private Fixture Name'],
    readFile: async path => {
      const file = path.replace('/fixture/', '');
      if (!files.has(file)) throw Error('private missing path');
      return files.get(file);
    } };
  return { files, calls, options };
}
const steps = calls => calls.map(call => call.step);

test('actual release checks all manifests, tag, history and Linux, then rechecks identity', async () => {
  const { options, calls } = fixture();
  const result = await preflight(options);
  assert.equal(result.ok, true);
  assert.equal(result.releaseReady, true);
  assert.equal(result.head, head);
  assert.deepEqual(steps(calls), ['status', 'head', 'tag', 'base', 'ancestor', 'sources', 'history', 'linux', 'status', 'head', 'tag']);
  assert.equal(calls.find(c => c.step === 'history').range, `${base}..${head}`);
});

test('candidate check never queries or claims a tag and still requires Linux', async () => {
  const { options, calls } = fixture();
  const result = await preflight({ ...options, mode: 'candidate', tag: undefined, version: '1.4.1' });
  assert.equal(result.ok, true);
  assert.equal(result.releaseReady, false);
  assert.equal(result.mode, 'candidate');
  assert.equal(steps(calls).includes('tag'), false);
  assert.ok(steps(calls).includes('linux'));
});

test('every plugin manifest version is mandatory and must agree', async () => {
  for (const file of manifestFiles.filter(file => file.endsWith('/plugin.json'))) {
    for (const content of [{ name: 'sleight' }, { name: 'sleight', version: '1.4.0' }, null]) {
      const { files, calls, options } = fixture();
      files.set(file, JSON.stringify(content));
      assert.equal((await preflight(options)).ok, false, file);
      assert.deepEqual(calls, []);
    }
  }
});

test('marketplace version fields agree when present, with exactly one sleight entry', async () => {
  for (const file of manifestFiles.filter(file => file.endsWith('marketplace.json'))) {
    for (const content of [
      { version: '1.4.0', plugins: [{ name: 'sleight' }] },
      { metadata: { version: '1.4.0' }, plugins: [{ name: 'sleight' }] },
      { plugins: [{ name: 'sleight', version: '1.4.0' }] },
      { plugins: [] }, { plugins: [{ name: 'sleight' }, { name: 'sleight' }] },
    ]) {
      const { files, options, calls } = fixture();
      files.set(file, JSON.stringify(content));
      assert.equal((await preflight(options)).ok, false, JSON.stringify(content));
      assert.deepEqual(calls, []);
    }
    const { files, options } = fixture();
    files.set(file, JSON.stringify({ version: '1.4.1', metadata: { version: '1.4.1' }, plugins: [{ name: 'sleight', version: '1.4.1' }] }));
    assert.equal((await preflight(options)).ok, true);
  }
});

test('missing, invalid, mismatched and unreleased changelog headings fail before subprocesses', async () => {
  for (const text of ['', '## Unreleased\n\n## 1.4.1 (2026-10-21)', '## 1.4.0 (2026-10-21)',
    '## 1.4.1 (2026-02-30)', '## 1.4.1 (TBD)', '## 1.4.1 (2026-10-21)\n\n## 1.4.1 (2026-10-20)']) {
    const { files, options, calls } = fixture();
    files.set('CHANGELOG.md', text);
    assert.equal((await preflight(options)).ok, false, text);
    assert.deepEqual(calls, []);
  }
});

test('README and CHANGELOG placeholders fail, including comments and old release markers', async () => {
  for (const file of ['README.md', 'CHANGELOG.md']) {
    for (const marker of ['TODO(1.4.1-validation)', 'TBD', 'FIXME', 'CHANGEME', '<!-- GB14 pending -->',
      '<!-- GB12 -->', '<!-- cursor-row: pending -->', 'vX.Y.Z', '{{release_version}}', '[INSERT results]']) {
      const { files, options, calls } = fixture();
      files.set(file, files.get(file) + `\n${marker}\n`);
      const result = await preflight(options);
      assert.equal(result.ok, false, marker);
      assert.ok(result.failures.some(f => f.code === 'placeholder' && f.file === file));
      assert.deepEqual(calls, []);
    }
  }
});

test('notes reject private identity, home paths, emails, phones and supplied private terms without echoing them', async () => {
  for (const text of [identity.home, identity.username, ['', 'Users', 'some-person', 'doc'].join('/'), '/home/some-person/doc',
    'person@example.invalid', '+1 (212) 555-0199', 'Private Fixture Name']) {
    const { files, options, calls } = fixture();
    files.set('CHANGELOG.md', files.get('CHANGELOG.md').replace('- Fix release checks.', `- ${text}`));
    const result = await preflight({ ...options, privateTerms: ['Private Fixture Name'] });
    assert.equal(result.ok, false);
    const output = JSON.stringify(result);
    assert.ok(result.failures.some(f => f.code === 'private-notes' && f.file === 'CHANGELOG.md' && f.line === 5));
    assert.equal(output.includes(text), false);
    assert.deepEqual(calls, []);
  }
});

test('PII check covers only the notes for this release and allows public URLs and measured numbers', async () => {
  const { files, options } = fixture();
  files.set('CHANGELOG.md', files.get('CHANGELOG.md').replace('Old notes.', identity.home)
    .replace('- Fix release checks.', '- 11,073 tests, 242.3 s; https://example.invalid/releases/v1.4.1'));
  assert.equal((await preflight(options)).ok, true);
});

test('invalid modes, tags, refs and incomplete injection fail without commands or unsafe diagnostics', async () => {
  for (const extra of [{ tag: 'v1.4.2' }, { tag: undefined }, { tag: '--all' }, { tag: 'v01.4.1' },
    { mode: 'candidate', tag: 'v1.4.1', version: '1.4.1' }, { mode: 'plan' },
    { historyBase: '--all' }, { historyBase: 'HEAD..HEAD' }, { historyBase: 'HEAD@{1}' },
    { runner: undefined }, { privateTerms: [''] }, { privateTerms: [] }]) {
    const { options, calls } = fixture();
    assert.equal((await preflight({ ...options, ...extra })).ok, false, JSON.stringify(extra));
    assert.deepEqual(calls, []);
  }
});

test('missing or malformed source files fail with fixed locations, never exception text', async () => {
  for (const file of ['README.md', 'CHANGELOG.md', ...manifestFiles]) {
    const { files, options, calls } = fixture();
    files.delete(file);
    const result = await preflight(options);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes('private missing path'), false);
    assert.deepEqual(calls, []);
  }
  const { files, options } = fixture();
  files.set(manifestFiles[0], '{ private content');
  assert.equal(JSON.stringify(await preflight(options)).includes('private content'), false);
});

test('each command failure stops all subsequent execution and preserves its exit status', async () => {
  for (const step of ['status', 'head', 'tag', 'base', 'ancestor', 'sources', 'history', 'linux']) {
    const { options, calls } = fixture({ [step]: () => ({ status: 17, stdout: identity.home, stderr: identity.username }) });
    const result = await preflight(options);
    assert.equal(result.ok, false, step);
    assert.equal(result.failures.at(-1).exitCode, 17);
    assert.equal(calls.at(-1).step, step);
    assert.equal(JSON.stringify(result).includes(identity.home), false);
    assert.equal(JSON.stringify(result).includes(identity.username), false);
  }
});

test('dirty tree, tag at another commit, malformed SHA and runner exceptions fail closed', async () => {
  for (const [step, response] of [['status', { status: 0, stdout: '?? private-file' }],
    ['tag', { status: 0, stdout: base }], ['head', { status: 0, stdout: 'not a hash' }],
    ['linux', { status: null, signal: 'SIGTERM' }], ['history', { status: 0, stdout: 'unexpected' }]]) {
    const { options, calls } = fixture({ [step]: () => response });
    assert.equal((await preflight(options)).ok, false);
    assert.equal(calls.at(-1).step, step);
  }
  const { options } = fixture({ history: () => { throw Error(identity.home); } });
  assert.equal(JSON.stringify(await preflight(options)).includes(identity.home), false);
});

test('history findings stop before Linux even if a broken scanner exits zero', async () => {
  const { options, calls } = fixture({ history: () => ({ status: 0,
    stdout: `${identity.home}:7 private\nRelease history scan: 1 added line(s) contain private identity data.\n` }) });
  assert.equal((await preflight(options)).ok, false);
  assert.equal(steps(calls).includes('linux'), false);
});

test('Linux receipt must confirm Linux npm test success, not a plan or local Mac result', async () => {
  for (const receipt of [{}, { platform: 'darwin', command: ['npm', 'test'], exitCode: 0, executed: true },
    { platform: 'linux', command: ['npm', 'test'], exitCode: 1, executed: true },
    { platform: 'linux', command: ['npm', 'test', '--ignore-scripts'], exitCode: 0, executed: true },
    { platform: 'linux', command: ['npm', 'test'], exitCode: 0 },
    { platform: 'linux', command: ['npm', 'test'], exitCode: 0, executed: false }]) {
    const { options, calls } = fixture({ linux: () => ({ status: 0, stdout: JSON.stringify(receipt) }) });
    assert.equal((await preflight(options)).ok, false, JSON.stringify(receipt));
    assert.equal(calls.at(-1).step, 'linux');
  }
});

test('tree, HEAD and tag are checked again after Linux to catch changes during execution', async () => {
  for (const step of ['status', 'head', 'tag']) {
    let count = 0;
    const { options } = fixture({ [step]: () => ({ status: 0, stdout: ++count === 1
      ? (step === 'status' ? '' : head) : (step === 'status' ? ' M file' : base) }) });
    assert.equal((await preflight(options)).ok, false, step);
    assert.equal(count, 2);
  }
});

test('CLI returns one nonzero result for any failure and refuses ambiguous or extra arguments', async () => {
  for (const args of [[], ['--tag', 'v1.4.1', '--candidate', '1.4.1'], ['--tag', 'v1.4.1', '--skip-linux'],
    ['--tag', 'v1.4.1', '--tag', 'v1.4.1']]) {
    const output = [];
    assert.equal(await main(args, { log: value => output.push(value) }), 1);
    assert.equal(JSON.parse(output[0]).ok, false);
  }
  const { options } = fixture();
  const output = [];
  const terms = ['--private-terms', '/fixture/private-terms.json'];
  assert.equal(await main(['--tag', 'v1.4.1', ...terms], { ...options, log: value => output.push(value) }), 0);
  assert.equal(JSON.parse(output[0]).releaseReady, true);
  assert.equal(await main(['--candidate', '1.4.1', ...terms], { ...options, log: () => {} }), 0);
  assert.equal(await main(['--candidate', '1.4.2', ...terms], { ...options, log: () => {} }), 1);
  for (const value of ['[]', 'null', '[""]', 'private malformed json']) {
    const { files, options: bad } = fixture();
    files.set('private-terms.json', value);
    const output = [];
    assert.equal(await main(['--tag', 'v1.4.1', ...terms], { ...bad, log: value => output.push(value) }), 1);
    assert.equal(output.join('').includes('private malformed json'), false);
  }
});

test('reviewed runner rejects unknown operations and never spawns Linux tests on a Mac', async () => {
  const calls = [];
  const runner = createReviewedRunner('/fixture', { platform: 'darwin', execute: (...args) => { calls.push(args); } });
  await assert.rejects(runner({ step: 'push' }));
  await assert.rejects(runner({ step: 'tag', tag: '--all' }));
  await assert.rejects(runner({ step: 'history', range: 'HEAD..HEAD' }));
  assert.notEqual((await runner({ step: 'linux' })).status, 0);
  assert.deepEqual(calls, []);
});

test('reviewed runner owns fixed argv, no shell, offline environment and throwaway config cleanup', async () => {
  const { existsSync } = await import('node:fs');
  const calls = [];
  const runner = createReviewedRunner('/fixture', { platform: 'linux', execute: (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(existsSync(options.env.CLAUDE_CONFIG_DIR), true);
    return { status: 0, stdout: '' };
  } });
  for (const request of [{ step: 'status' }, { step: 'head' }, { step: 'tag', tag: 'v1.4.1' },
    { step: 'base', ref: 'origin/main' }, { step: 'ancestor', base, head }, { step: 'sources' },
    { step: 'history', range: `${base}..${head}` }, { step: 'linux' }]) await runner(request);
  assert.equal(calls.length, 8);
  for (const { command, args, options } of calls) {
    assert.equal(options.cwd, '/fixture');
    assert.equal(options.shell, false);
    assert.equal(options.env.npm_config_offline, 'true');
    assert.equal(existsSync(options.env.CLAUDE_CONFIG_DIR), false);
    assert.ok(['/usr/bin/git', process.execPath].includes(command));
    assert.equal(args.includes('push'), false);
    assert.equal(args.includes('fetch'), false);
  }
  assert.deepEqual(calls.at(-1).args, ['scripts/linux-preflight.mjs', '--run', '--json']);
  assert.deepEqual(calls.slice(0, -1).map(call => call.args), [
    ['status', '--porcelain=v1', '--untracked-files=all'],
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    ['rev-parse', '--verify', 'refs/tags/v1.4.1^{commit}'],
    ['rev-parse', '--verify', 'origin/main^{commit}'],
    ['merge-base', '--is-ancestor', base, head],
    ['ls-files', '--error-unmatch', '--', 'scripts/release-history-scan.mjs', 'scripts/linux-preflight.mjs'],
    ['scripts/release-history-scan.mjs', `${base}..${head}`],
  ]);
  assert.equal(new Set(calls.map(c => c.options.env.CLAUDE_CONFIG_DIR)).size, calls.length);
});

test('reviewed runner cleans its config even when the injected executor throws', async () => {
  const { existsSync } = await import('node:fs');
  let config;
  const runner = createReviewedRunner('/fixture', { execute: (_command, _args, options) => {
    config = options.env.CLAUDE_CONFIG_DIR;
    throw Error('fixture executor failed');
  } });
  await assert.rejects(runner({ step: 'head' }));
  assert.equal(existsSync(config), false);
});
