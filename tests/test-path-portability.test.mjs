import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { containerProgram, linuxPreflightPlan, runContainerChecks, runLinuxPreflight } from '../scripts/linux-preflight.mjs';

const forbidden = [['', 'private', 'tmp'].join('/'), ['', 'Users', ''].join('/')];
const testsRoot = fileURLToPath(new URL('.', import.meta.url));

function pathViolations(root) {
  const hits = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`test path guard refuses symlink: ${relative(root, file)}`);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile()) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const prefix of forbidden) {
          if (line.includes(prefix)) hits.push(`${relative(root, file)}:${index + 1}: ${prefix}`);
        }
      });
    }
  }
  walk(root);
  return hits;
}

test('path guard scans nested tests, fixtures, comments and every matching prefix without exemptions', t => {
  const root = mkdtempSync(join(tmpdir(), 'sleight-path-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'fixtures'));
  writeFileSync(join(root, 'case.test.mjs'), `// ${forbidden[0]}/fixture\nconst x = '${forbidden[1]}fixture';\n`);
  writeFileSync(join(root, 'fixtures', 'case.json'), JSON.stringify({ path: forbidden.join(' and ') }));
  writeFileSync(join(root, 'portable.test.mjs'), "const dir = mkdtempSync(join(tmpdir(), 'case-'));\n");
  assert.deepEqual(pathViolations(root), [
    `case.test.mjs:1: ${forbidden[0]}`, `case.test.mjs:2: ${forbidden[1]}`,
    `fixtures/case.json:1: ${forbidden[0]}`, `fixtures/case.json:1: ${forbidden[1]}`,
  ]);
  symlinkSync(join(root, 'portable.test.mjs'), join(root, 'linked.test.mjs'));
  assert.throws(() => pathViolations(root), /refuses symlink: linked.test.mjs/);
});

test('Linux preflight keeps worktree names as one volume argument and isolates Linux dependencies', () => {
  const root = resolve(tmpdir(), 'worktree with spaces $(touch never)');
  const plan = linuxPreflightPlan(root);
  assert.equal(plan.command, 'docker');
  assert.deepEqual(plan.args.slice(0, 11), ['run', '--rm', '-v', `${root}:/w`, '-v', '/w/node_modules', '-w', '/w', 'node:24', 'node', '--input-type=module']);
  assert.deepEqual(plan.args.slice(11), ['-e', containerProgram]);
  assert.equal(plan.cwd, root);
  assert.equal(linuxPreflightPlan().cwd, fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''));
  assert.throws(() => linuxPreflightPlan(join(tmpdir(), 'bad:path')), /separator/);
  assert.throws(() => linuxPreflightPlan(join(tmpdir(), 'bad\npath')), /control/);
});

test('Linux preflight invokes Docker without a shell and preserves failed statuses', () => {
  for (const status of [0, 1, 23, 125]) {
    const calls = [];
    const code = runLinuxPreflight({ spawn: (...args) => { calls.push(args); return { status }; } });
    assert.equal(code, status);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'docker');
    assert.equal(calls[0][2].shell, false);
    assert.equal(calls[0][2].stdio, 'inherit');
  }
  for (const result of [{ error: Error('missing Docker') }, { status: null, signal: 'SIGINT' }, {}]) {
    const logs = [];
    assert.equal(runLinuxPreflight({ spawn: () => result, log: line => logs.push(line) }), 1);
    if (result.error || result.signal) assert.equal(logs.length, 1);
  }
});

function fakeContainer(results) {
  const calls = [], removed = [], config = join(tmpdir(), 'synthetic-claude-config');
  return { calls, removed, config, options: { env: { HOME: '/root', CLAUDE_CONFIG_DIR: '/inherited-config' },
    makeConfig: () => config, removeConfig: path => removed.push(path),
    spawn: (...args) => { calls.push(args); return results.shift(); } } };
}

test('container installs locked dependencies before tests and replaces the inherited Claude config', () => {
  const h = fakeContainer([{ status: 0 }, { status: 0 }]);
  assert.equal(runContainerChecks(h.options), 0);
  assert.deepEqual(h.calls.map(([command, args]) => [command, args]), [['npm', ['ci', '--ignore-scripts']], ['npm', ['test']]]);
  for (const [, , options] of h.calls) {
    assert.equal(options.env.CLAUDE_CONFIG_DIR, h.config);
    assert.equal(options.env.HOME, '/root');
    assert.equal(options.shell, false);
  }
  assert.deepEqual(h.removed, [h.config]);
});

test('container stops on install failure, propagates test failure and cleans config after errors', () => {
  for (const results of [[{ status: 7 }], [{ status: 0 }, { status: 9 }], [{ error: Error('ENOENT') }], [{ status: null, signal: 'SIGTERM' }], [{}]]) {
    const expected = results.at(-1).status || 1, count = results.length;
    const h = fakeContainer(results);
    assert.equal(runContainerChecks(h.options), expected);
    assert.equal(h.calls.length, count);
    assert.deepEqual(h.removed, [h.config]);
  }
  const h = fakeContainer([]);
  h.options.spawn = () => { throw Error('spawn failed'); };
  assert.throws(() => runContainerChecks(h.options), /spawn failed/);
  assert.deepEqual(h.removed, [h.config]);
});

test('the exact container program executes both npm argument vectors with fake process controls', () => {
  const calls = [], removed = [], process = { env: {}, exitCode: undefined };
  const source = containerProgram.replace(/^import .*;\n/gm, '');
  runInNewContext(source, { process, join, tmpdir: () => '/container-temp',
    mkdtempSync: prefix => `${prefix}fresh`, rmSync: path => removed.push(path),
    spawnSync: (command, args, options) => { calls.push({ command, args: [...args], config: options.env.CLAUDE_CONFIG_DIR }); return { status: 0 }; } });
  assert.equal(process.exitCode, 0);
  assert.deepEqual(calls, [
    { command: 'npm', args: ['ci', '--ignore-scripts'], config: '/container-temp/lane-claude-fresh' },
    { command: 'npm', args: ['test'], config: '/container-temp/lane-claude-fresh' },
  ]);
  assert.deepEqual(removed, ['/container-temp/lane-claude-fresh']);
});

test('tests contain no hardcoded macOS temporary or home paths', () => {
  const hits = pathViolations(testsRoot);
  assert.equal(hits.length, 0, `Use os.tmpdir() for real filesystem paths. Construct platform-specific adversarial data explicitly.\n${hits.join('\n')}`);
});
