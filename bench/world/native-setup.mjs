import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeArmPlan, NATIVE_PINS, cuaDaemonPlan } from './native-arms.mjs';
import { worldCLI } from './native-world.mjs';

export function setupPlan(name, argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--dry-run') values.dryRun = true;
    else if (['--dir', '--tcc-host', '--version'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) values[key.slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete setup option ${key}`);
  }
  if (values.version !== NATIVE_PINS[name]?.version) throw new Error('setup script version must match the adapter pin');
  if (name === 'peekaboo' && !values['tcc-host']?.trim()) throw new Error('pass --tcc-host with the exact terminal or editor app that will host the MCP process');
  const armHome = process.env.BENCH_ARM_HOME || join(homedir(), 'Library/Caches/sleight-bench');
  const dir = resolve(values.dir ?? join(armHome, `mcp-${name}-arm`));
  const plan = nativeArmPlan(name, { armHome, dir });
  const app = name === 'cua' ? join(dir, 'CuaDriver.app') : values['tcc-host'];
  return { ...plan, version: plan.identity.version, dryRun: Boolean(values.dryRun),
    grants: ['Accessibility', 'Screen Recording'].map(permission => ({ app, permission, ownerAction: true })),
    ownerLogin: ['env', `CLAUDE_CONFIG_DIR=${join(plan.cwd, 'claude')}`, worldCLI(armHome), 'auth', 'login'],
    world: { setup: [process.execPath, fileURLToPath(new URL('./native-world.mjs', import.meta.url)), '--setup', '--dir', join(armHome, 'world-cli')] },
    runtimeUnaudited: true,
    runtimeNote: 'These paths were identified in the pinned installer or source. Remaining runtime writes and telemetry behavior are unaudited.',
    runtimePathNote: name === 'cua' ? 'The driver reads shared $CUA_HOME/config.toml (default ~/.cua/config.toml). Shared Cua config commands can write it. Setup runs no config command.'
      : 'The pinned package README places provider credentials and settings under ~/.peekaboo. Individual runtime files were not audited.',
    runtimeWrites: name === 'cua' ? [join(homedir(), '.cua-driver'), '$CUA_HOME/config.toml', join(homedir(), '.cua-driver/config.json'), join(homedir(), '.cua-driver/version_check.json')]
      : [join(homedir(), '.peekaboo')],
    ...(name === 'cua' ? { ownerStart: cuaDaemonPlan(dir).start,
      untouched: ['/Applications', '~/.local/bin', 'shell rc files'],
      removal: ['rm', '-rf', dir, join(homedir(), '.cua-driver')],
      removalNote: 'Manual plan only. Stop the staged daemon first, and preserve any pre-existing Cua state before removing its runtime folder.' }
      : { inputHost: app, note: 'Run the benchmark from this host. Background keys and drag may also require Event Synthesizing permission for its input host.' }),
    writes: [join(dir, name === 'cua' ? 'CuaDriver.app' : 'package'), join(dir, '.mcp.json'), join(dir, 'native-receipt.json')],
  };
}

export async function installNative(plan, { download = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`artifact download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}, run = execFileSync, platform = process.platform } = {}) {
  if (plan.dryRun) return;
  if (platform !== 'darwin') throw new Error('native competitor setup requires macOS');
  if (existsSync(plan.cwd)) throw new Error('arm folder already exists; select a fresh --dir');
  let existing = dirname(plan.cwd);
  while (!existsSync(existing)) existing = dirname(existing);
  let repo;
  try { repo = run('/usr/bin/git', ['-C', existing, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: 'pipe' }); } catch {}
  if (repo) throw new Error('arm setup must be outside every git repository');
  const bytes = await download(plan.artifact.url);
  if (createHash(plan.artifact.algorithm).update(bytes).digest(plan.artifact.encoding) !== plan.artifact.digest) throw new Error('pinned artifact checksum mismatch');
  mkdirSync(plan.cwd, { mode: 0o700 });
  const archive = join(plan.cwd, 'artifact.tar.gz'), unpack = join(plan.cwd, 'unpack');
  try {
    writeFileSync(archive, bytes, { mode: 0o600 });
    const entries = run('/usr/bin/tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim().split('\n');
    if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) throw new Error('archive contains paths outside the arm');
    mkdirSync(unpack, { mode: 0o700 });
    run('/usr/bin/tar', ['-xzf', archive, '-C', unpack], { stdio: 'pipe' });
    if (plan.identity.name === 'cua') {
      const bundles = [];
      const find = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(dir, entry.name);
        if (entry.name === 'CuaDriver.app') bundles.push(path); else find(path);
      } };
      find(unpack);
      if (bundles.length !== 1) throw new Error('Cua release must contain exactly one CuaDriver.app');
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundles[0]], { stdio: 'pipe' });
      const bundleId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(bundles[0], 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
      if (bundleId !== 'com.trycua.driver') throw new Error('unexpected Cua bundle identity');
      renameSync(bundles[0], join(plan.cwd, 'CuaDriver.app'));
    } else {
      const manifest = JSON.parse(readFileSync(join(unpack, 'package/package.json'), 'utf8'));
      if (manifest.name !== '@steipete/peekaboo' || manifest.version !== plan.version) throw new Error('unexpected Peekaboo package identity');
      renameSync(join(unpack, 'package'), join(plan.cwd, 'package'));
    }
    const executable = plan.mcp.mcpServers[plan.identity.name].command;
    const executableHash = createHash('sha256').update(readFileSync(executable)).digest('hex');
    writeFileSync(join(plan.cwd, '.mcp.json'), JSON.stringify(plan.mcp, null, 2) + '\n', { mode: 0o600 });
    writeFileSync(join(plan.cwd, 'native-receipt.json'), JSON.stringify({ version: plan.version, artifact: plan.artifact, executableHash }, null, 2) + '\n', { mode: 0o600 });
    rmSync(unpack, { recursive: true, force: true });
    rmSync(archive);
  } catch (error) { rmSync(plan.cwd, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const plan = setupPlan(process.argv[2], process.argv.slice(3));
    console.log(JSON.stringify(plan, null, 2));
    await installNative(plan);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
