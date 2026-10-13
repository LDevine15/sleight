import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
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
