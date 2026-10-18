// Entry for the resident Electron host process. Inert by itself: running this file directly does
// nothing but explain why. A trusted parent (EPV3-7) imports runHostEntry() and supplies the
// callbacks that only the user can answer (launch approval, the app's own Quit, resume
// authority). None of them can arrive through argv, the environment or the channel.
//
// The broker and the launch adapter currently live under bench/direct-electron (their prototype
// home). EPV3-7 decides where they ship; until then this entry resolves them from the repository.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, normalize } from 'node:path';
import { createElectronHost, createPythonAdapter } from './electron-host.mjs';

const fail = code => { throw Error(code); };
const options = new Set(['--state-dir', '--registry', '--temp-root', '--builds', '--python', '--adapter-script', '--broker-module', '--admin-fd']);
const absolute = value => typeof value === 'string' && isAbsolute(value) && normalize(value) === value && !value.includes('\0');

export function parseHostArguments(argv) {
  if (!Array.isArray(argv) || argv.length % 2 || argv.length > 16) fail('HOST_ARGUMENTS_INVALID');
  const parsed = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!options.has(argv[i]) || Object.hasOwn(parsed, argv[i]) || typeof argv[i + 1] !== 'string') fail('HOST_ARGUMENTS_INVALID');
    parsed[argv[i]] = argv[i + 1];
  }
  for (const required of ['--state-dir', '--registry', '--temp-root', '--builds']) if (!Object.hasOwn(parsed, required)) fail('HOST_ARGUMENTS_INVALID');
  for (const path of ['--state-dir', '--registry', '--temp-root', '--adapter-script', '--broker-module']) {
    if (Object.hasOwn(parsed, path) && !absolute(parsed[path])) fail('HOST_ARGUMENTS_INVALID');
  }
  if (Object.hasOwn(parsed, '--admin-fd') && !/^(0|[3-9]|[1-9][0-9])$/.test(parsed['--admin-fd'])) fail('HOST_ARGUMENTS_INVALID');
  const builds = parsed['--builds'].split(',');
  if (!builds.length || builds.length > 16 || builds.some(build => !/^[A-Za-z0-9._@+-]{1,128}$/.test(build))) fail('HOST_ARGUMENTS_INVALID');
  return Object.freeze({ stateDir: parsed['--state-dir'], registryPath: parsed['--registry'], tempRoot: parsed['--temp-root'], builds,
    python: parsed['--python'] ?? 'python3', adminFd: Object.hasOwn(parsed, '--admin-fd') ? Number(parsed['--admin-fd']) : undefined,
    script: parsed['--adapter-script'] ?? fileURLToPath(new URL('../../../../bench/direct-electron/launch.py', import.meta.url)),
    brokerModule: parsed['--broker-module'] ?? fileURLToPath(new URL('../../../../bench/direct-electron/broker.mjs', import.meta.url)) });
}

// The parent's per-start admin secret: one base64url line (at least 32 bytes decoded) on an inherited
// descriptor, read once and never stored. A parent in the same process passes deps.adminSecret instead.
export function readAdminSecret(fd, read = readFileSync) {
  const text = String(read(fd, 'utf8')).trim();
  const secret = /^[A-Za-z0-9_-]{43,512}$/.test(text) ? Buffer.from(text, 'base64url') : Buffer.alloc(0);
  if (secret.length < 32) fail('ADMIN_SECRET_INVALID');
  return secret;
}

/** deps = { authorizeLaunch, authorizeIssue, admitTarget, requestQuit, resumeAuthority, adminSecret } from the trusted parent,
 * plus optional Broker for tests. */
export async function runHostEntry({ argv, deps = {}, output = process.stdout } = {}) {
  const config = parseHostArguments(argv);
  if (typeof deps.authorizeLaunch !== 'function') fail('HOST_APPROVAL_REQUIRED');
  const adminSecret = deps.adminSecret ?? (config.adminFd === undefined ? undefined : readAdminSecret(config.adminFd));
  const Broker = deps.Broker ?? (await import(config.brokerModule)).ElectronBroker;
  const host = await createElectronHost({
    stateDir: config.stateDir, Broker, builds: config.builds,
    createAdapter: async () => createPythonAdapter({ python: config.python, script: config.script, registryPath: config.registryPath, tempRoot: config.tempRoot }),
    authorizeLaunch: deps.authorizeLaunch, requestQuit: deps.requestQuit, resumeAuthority: deps.resumeAuthority, brokerOptions: deps.brokerOptions,
    authorizeIssue: deps.authorizeIssue, admitTarget: deps.admitTarget, adminSecret,
  });
  const status = host.status();
  output.write(JSON.stringify({ ready: true, hostId: status.hostId, socket: status.socket, ownership: status.ownership }) + '\n');
  return host;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stderr.write('The Electron host entry is inert on its own. A trusted parent imports runHostEntry() and supplies launch approval.\n');
  process.exit(2);
}
