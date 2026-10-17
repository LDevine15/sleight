import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareGenericArm } from '../plugin-arm.mjs';

export const NATIVE_PINS = {
  cua: { version: '0.34.0', digests: {
    arm64: '329bcc140c4840a5877e2cfc9f756351eb4a70c2c2d6acf4954751918122c60a',
    x64: '9f362ad3af021c2d092c89172a02663e5c7d8788f8f7643a0b5f4eb568279b27',
  } },
  peekaboo: { version: '4.9.2', digest: 'wGSZ737NUbfs0YoDhPIdT1C1Dq1P7yC4dBJpb4iE+CXjcSvMI6eEt9qD8YPskklEiMVR0qI1X3c1ckm118VSuw==' },
};
export const isNativeArm = name => ['cua', 'peekaboo'].includes(name);
export const CUA_ENV = { CUA_DRIVER_EMBEDDED: '1', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
  CUA_TELEMETRY_ENABLED: '0', CUA_DRIVER_RS_UPDATE_CHECK: 'false', DO_NOT_TRACK: '1' };

export function nativeArmPlan(name, { armHome, dir = join(armHome, `mcp-${name}-arm`), arch = process.arch } = {}) {
  if (!isNativeArm(name)) throw new Error(`unknown native arm ${name}`);
  dir = resolve(dir);
  const pin = NATIVE_PINS[name];
  if (name === 'cua' && !pin.digests[arch]) throw new Error(`Cua has no pinned macOS artifact for ${arch}`);
  const command = name === 'cua' ? join(dir, 'CuaDriver.app/Contents/MacOS/cua-driver') : join(dir, 'package/peekaboo');
  const config = name === 'cua' ? { command, args: ['mcp', `--socket=${join(dir, 'driver.sock')}`], env: { ...CUA_ENV } }
    : { command, args: ['mcp', 'serve'], env: { DO_NOT_TRACK: '1' } };
  const artifact = name === 'cua' ? {
    url: `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${pin.version}/cua-driver-rs-${pin.version}-darwin-${arch === 'x64' ? 'x86_64' : 'arm64'}.tar.gz`,
    algorithm: 'sha256', encoding: 'hex', digest: pin.digests[arch],
  } : { url: `https://registry.npmjs.org/@steipete/peekaboo/-/peekaboo-${pin.version}.tgz`, algorithm: 'sha512', encoding: 'base64', digest: pin.digest };
  return { generic: true, native: true, cwd: dir, servers: [name], artifact,
    mcp: { mcpServers: { [name]: config } }, identity: { kind: 'native-mcp', name, version: pin.version, artifact },
    env: { CLAUDE_CONFIG_DIR: join(dir, 'claude') },
    args: ['--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config', '--setting-sources', '', '--tools', '',
      '--disable-slash-commands', '--permission-prompts', 'none', '--no-session-persistence', '--no-chrome'] };
}

// Cua's MCP command is a proxy: it exits at once unless its daemon listens on the arm's socket ("no Cua Driver daemon
// listening", which cost the first Firefox round all 12 tasks, 2026-10-17). The daemon starts through LaunchServices so
// macOS applies the grants on CuaDriver.app itself, as the setup plan's start command does.
export function cuaDaemonPlan(dir) {
  const app = join(resolve(dir), 'CuaDriver.app'), socket = join(resolve(dir), 'driver.sock');
  return { socket, executable: join(app, 'Contents/MacOS/cua-driver'),
    start: ['open', '-n', '-g', ...Object.entries(CUA_ENV).filter(([key]) => key !== 'CUA_DRIVER_EMBEDDED')
      .flatMap(([key, value]) => ['--env', `${key}=${value}`]), app, '--args', 'serve', '--socket', socket] };
}
export const socketListening = path => new Promise(done => {
  const socket = createConnection({ path });
  socket.once('connect', () => { socket.destroy(); done(true); });
  socket.once('error', () => done(false));
});
const daemonPids = executable => execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
  .flatMap(line => { const m = /^\s*(\d+)\s+(.*)$/.exec(line); return m && m[2].startsWith(`${executable} serve`) ? [Number(m[1])] : []; });
// Starts the daemon when nothing listens and returns a stop that ends only a daemon this call started.
export async function ensureCuaDaemon(dir, { listening = socketListening, run = execFileSync, pids = daemonPids,
  sleep = ms => new Promise(done => setTimeout(done, ms)), timeoutMs = 15000 } = {}) {
  const plan = cuaDaemonPlan(dir);
  if (await listening(plan.socket)) return { started: false, socket: plan.socket, stop: async () => {} };
  const before = new Set(pids(plan.executable));
  rmSync(plan.socket, { force: true }); // a dead daemon's socket file; nothing listens on it
  run(plan.start[0], plan.start.slice(1), { stdio: 'ignore' });
  for (const end = Date.now() + timeoutMs; !(await listening(plan.socket));) {
    if (Date.now() > end) throw Error(`Cua daemon did not listen on ${plan.socket} within ${timeoutMs / 1000} s`);
    await sleep(250);
  }
  const started = pids(plan.executable).filter(pid => !before.has(pid));
  return { started: true, socket: plan.socket, pids: started, stop: async () => {
    for (const pid of started) try { process.kill(pid, 'SIGTERM'); } catch {}
    for (const end = Date.now() + 5000; started.some(alive) && Date.now() < end;) await sleep(100);
  } };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function prepareNativeArm(name, { root, armHome, env = process.env, dryRun = false } = {}) {
  const plan = nativeArmPlan(name, { armHome });
  if (plan.unsupported || dryRun) return plan;
  const receipt = JSON.parse(readFileSync(join(plan.cwd, 'native-receipt.json'), 'utf8'));
  const config = join(plan.cwd, '.mcp.json');
  const server = plan.mcp.mcpServers[name];
  if (receipt.version !== plan.identity.version || receipt.artifact.digest !== plan.artifact.digest
    || receipt.executableHash !== createHash('sha256').update(readFileSync(server.command)).digest('hex')
    || JSON.stringify(JSON.parse(readFileSync(config, 'utf8'))) !== JSON.stringify(plan.mcp)) {
    throw new Error(`${name} setup receipt or pinned MCP configuration does not match; rerun its setup in a fresh arm folder`);
  }
  const arm = prepareGenericArm(`mcp:${name}`, { root, armHome, env: { ...env, [`MCP_ARM_${name.toUpperCase()}_CONFIG`]: config } });
  mkdirSync(plan.env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  arm.args.push('--no-chrome');
  return { ...arm, native: true, env: { ...arm.env, ...plan.env }, identity: { ...arm.identity, version: plan.identity.version, artifact: plan.artifact } };
}
