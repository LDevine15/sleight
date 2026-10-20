#!/usr/bin/env node
import { readFile as readText } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { privateIdentity, privateMatches } from './lib/public-privacy.mjs';

export const manifestFiles = Object.freeze([
  'plugins/sleight/.claude-plugin/plugin.json', 'plugins/sleight/.codex-plugin/plugin.json',
  'plugins/sleight/.cursor-plugin/plugin.json', '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json', '.cursor-plugin/marketplace.json',
]);
const number = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?$`);
const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const validTag = tag => typeof tag === 'string' && tag.startsWith('v') && versionPattern.test(tag.slice(1));
const validRef = ref => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
  && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.');
const placeholder = /\b(?:TODO|TBD|FIXME|XXX|CHANGEME)\b|\bv?X\.Y\.Z\b|\{\{[^}]+\}\}|\[INSERT\b|<!--\s*(?:GB12\b|GB14\b|cursor-row\b|pending\b)/i;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// No exception text, document text, runner output or private match is copied to the result.
export async function preflight({ root = process.cwd(), mode = 'release', tag, version, historyBase = 'origin/main',
  runner, readFile = path => readText(path, 'utf8'), identity = privateIdentity(), privateTerms = [] } = {}) {
  const result = { ok: false, mode: mode === 'candidate' ? 'candidate' : 'release', releaseReady: false, failures: [] };
  const fail = (check, code, details = {}) => result.failures.push({ check, code, ...details });
  const requested = mode === 'release' && validTag(tag) ? tag.slice(1) : version;
  if (!['release', 'candidate'].includes(mode) || typeof requested !== 'string' || !versionPattern.test(requested)
    || (mode === 'release' && (!validTag(tag) || version !== undefined))
    || (mode === 'candidate' && tag !== undefined) || !validRef(historyBase)
    || typeof runner !== 'function' || !Array.isArray(privateTerms) || !privateTerms.length
    || privateTerms.some(term => typeof term !== 'string' || !term.trim())) {
    fail('arguments', 'invalid-options');
    return result;
  }
  result.version = requested;
  const texts = new Map();
  for (const file of ['README.md', 'CHANGELOG.md', ...manifestFiles]) {
    try { texts.set(file, await readFile(join(root, file))); }
    catch { fail('files', 'unreadable', { file }); }
  }
  for (const file of manifestFiles) {
    if (!texts.has(file)) continue;
    try {
      const manifest = JSON.parse(texts.get(file));
      if (!object(manifest)) throw Error();
      const versions = [];
      if (file.endsWith('/plugin.json')) {
        if (manifest.name !== 'sleight' || !Object.hasOwn(manifest, 'version')) throw Error();
        versions.push(manifest.version);
      } else {
        if (!Array.isArray(manifest.plugins)) throw Error();
        const entries = manifest.plugins.filter(entry => entry?.name === 'sleight');
        if (entries.length !== 1) throw Error();
        for (const entry of [manifest, manifest.metadata, entries[0]]) {
          if (object(entry) && Object.hasOwn(entry, 'version')) versions.push(entry.version);
        }
      }
      if (versions.some(value => value !== requested)) fail('version', 'manifest-disagreement', { file });
    } catch { fail('version', 'invalid-manifest', { file }); }
  }
  const changelog = texts.get('CHANGELOG.md') ?? '';
  const headings = [...changelog.matchAll(/^##\s+(.+)$/gm)];
  const heading = /^(\S+) \((\d{4}-\d{2}-\d{2})\)$/.exec(headings[0]?.[1] ?? '');
  const date = heading?.[2];
  if (!heading || heading[1] !== requested || !date || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date
    || headings.slice(1).some(item => item[1].split(' ')[0] === requested)) {
    fail('version', 'changelog-disagreement', { file: 'CHANGELOG.md' });
  }
  for (const file of ['README.md', 'CHANGELOG.md']) {
    (texts.get(file) ?? '').split('\n').forEach((line, index) => {
      if (placeholder.test(line)) fail('docs', 'placeholder', { file, line: index + 1 });
    });
  }
  // Inspect only the newest release's notes. The historical addition scan covers the Git range.
  const noteEnd = headings[1]?.index ?? changelog.length;
  const noteStart = headings[0]?.index ?? 0;
  const firstLine = changelog.slice(0, noteStart).split('\n').length;
  changelog.slice(noteStart, noteEnd).split('\n').forEach((line, index) => {
    if (privateMatches(line, identity).length || /\/(?:Users|home)\/[^\s/]+/.test(line)
      || /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(line)
      || /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\b\d{3})[ .-]\d{3}[ .-]\d{4}\b/.test(line)
      || privateTerms.some(term => line.toLowerCase().includes(term.toLowerCase()))) {
      fail('privacy', 'private-notes', { file: 'CHANGELOG.md', line: firstLine + index });
    }
  });
  if (result.failures.length) return result;

  const run = async (step, data = {}) => {
    let response;
    try { response = await runner({ step, ...data }); }
    catch { fail(step, 'runner-error'); return null; }
    if (response?.status !== 0 || typeof response.stdout !== 'string') {
      fail(step, 'command-failed', { exitCode: Number.isInteger(response?.status) ? response.status : null });
      return null;
    }
    return response.stdout.trim();
  };
  const clean = async () => {
    const status = await run('status');
    if (status === null) return false;
    if (status) { fail('status', 'dirty-tree'); return false; }
    return true;
  };
  if (!await clean()) return result;
  const head = await run('head');
  if (head === null) return result;
  if (!shaPattern.test(head)) { fail('head', 'invalid-commit'); return result; }
  result.head = head;
  const checkTag = async () => {
    if (mode === 'candidate') return true;
    const commit = await run('tag', { tag });
    if (commit === null) return false;
    if (commit !== head) { fail('tag', 'tag-not-at-head'); return false; }
    return true;
  };
  if (!await checkTag()) return result;
  const base = await run('base', { ref: historyBase });
  if (base === null) return result;
  if (!shaPattern.test(base)) { fail('base', 'invalid-commit'); return result; }
  if (await run('ancestor', { base, head }) === null || await run('sources') === null) return result;
  const history = await run('history', { range: `${base}..${head}` });
  if (history === null) return result;
  if (history !== 'Release history scan: 0 added line(s) contain private identity data.') {
    fail('history', 'findings-or-invalid-summary'); return result;
  }
  const linux = await run('linux');
  if (linux === null) return result;
  try {
    const receipt = JSON.parse(linux);
    if (!object(receipt) || receipt.platform !== 'linux' || receipt.exitCode !== 0 || receipt.executed !== true
      || JSON.stringify(receipt.command) !== JSON.stringify(['npm', 'test'])) throw Error();
  } catch { fail('linux', 'invalid-test-receipt'); return result; }
  if (!await clean()) return result;
  const after = await run('head');
  if (after === null) return result;
  if (after !== head) { fail('head', 'changed-during-check'); return result; }
  if (!await checkTag()) return result;
  result.ok = true;
  result.releaseReady = mode === 'release';
  return result;
}

// This is the only real subprocess boundary. Tests inject execute; there is no shell or arbitrary command option.
// The A5 helper must implement --run --json with the receipt described in docs/release-preflight.md.
export function createReviewedRunner(root, { platform = process.platform, execute = spawnSync } = {}) {
  return async request => {
    let command = '/usr/bin/git', args, timeout = 30_000;
    switch (request.step) {
      case 'status': args = ['status', '--porcelain=v1', '--untracked-files=all']; break;
      case 'head': args = ['rev-parse', '--verify', 'HEAD^{commit}']; break;
      case 'tag':
        if (!validTag(request.tag)) throw Error('Invalid tag');
        args = ['rev-parse', '--verify', `refs/tags/${request.tag}^{commit}`]; break;
      case 'base':
        if (!validRef(request.ref)) throw Error('Invalid base');
        args = ['rev-parse', '--verify', `${request.ref}^{commit}`]; break;
      case 'ancestor':
        if (!shaPattern.test(request.base ?? '') || !shaPattern.test(request.head ?? '')) throw Error('Invalid commits');
        args = ['merge-base', '--is-ancestor', request.base, request.head]; break;
      case 'sources': args = ['ls-files', '--error-unmatch', '--', 'scripts/release-history-scan.mjs', 'scripts/linux-preflight.mjs']; break;
      case 'history':
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})\.\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.range ?? '')) throw Error('Invalid range');
        command = process.execPath; args = ['scripts/release-history-scan.mjs', request.range]; timeout = 120_000; break;
      case 'linux':
        if (platform !== 'linux') return { status: null, stdout: '' };
        command = process.execPath; args = ['scripts/linux-preflight.mjs', '--run', '--json']; timeout = 1_200_000; break;
      default: throw Error('Unknown preflight operation');
    }
    const config = mkdtempSync(join(tmpdir(), 'lane-claude-'));
    try {
      const env = { ...process.env, CLAUDE_CONFIG_DIR: config, npm_config_offline: 'true', GIT_TERMINAL_PROMPT: '0' };
      for (const key of Object.keys(env)) {
        if ((key.startsWith('GIT_') && key !== 'GIT_TERMINAL_PROMPT') || ['NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
      }
      return await execute(command, args, { cwd: root, encoding: 'utf8', shell: false, env, timeout,
        maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } finally { rmSync(config, { recursive: true, force: true }); }
  };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const log = dependencies.log ?? console.log;
  try {
    const options = {}, seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!['--tag', '--candidate', '--history-base', '--private-terms'].includes(flag)
        || seen.has(flag) || !value || value.startsWith('--')) throw Error();
      seen.add(flag);
      if (flag === '--tag') { options.mode = 'release'; options.tag = value; }
      if (flag === '--candidate') { options.mode = 'candidate'; options.version = value; }
      if (flag === '--history-base') options.historyBase = value;
      if (flag === '--private-terms') options.privateTerms = JSON.parse(await (dependencies.readFile ?? (path => readText(path, 'utf8')))(value));
    }
    if (seen.has('--tag') === seen.has('--candidate') || !seen.has('--private-terms')) throw Error();
    const root = dependencies.root ?? process.cwd();
    const result = await preflight({ ...dependencies, root, tag: undefined, version: undefined,
      runner: dependencies.runner ?? createReviewedRunner(root), ...options });
    log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch {
    log(JSON.stringify({ ok: false, releaseReady: false, failures: [{ check: 'arguments', code: 'invalid-options-or-private-terms' }] }));
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
