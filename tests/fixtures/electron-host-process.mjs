// Test fixture: a resident host as its own process, so a test can kill it the way a crash would.
// Approves its own launch because it only ever launches the fake Electron from fake-electron.py.
// Leading flags: --profile-user launches on the user's own profile (the relaunch flow's mode); --partial leaves half a
// command in the app's pipe before reporting, as a host that dies mid-write would; --flood has the app send 8 MB of events
// half a second later, after the test has killed this host.
import { runHostEntry } from '../../plugins/sleight/lib/direct-browser/electron-host-entry.mjs';

const args = process.argv.slice(2), flags = new Set();
while (['--profile-user', '--partial', '--flood'].includes(args[0])) flags.add(args.shift());
const [build, ...argv] = args;
const host = await runHostEntry({ argv, deps: { authorizeLaunch: async () => true, authorizeIssue: async () => true, admitTarget: async info => info.type === 'page' } });
await host.start(flags.has('--profile-user') ? { build, profile: 'user' } : { build });
const handle = await host.issueTicket({ session: 'crash-test', ttlMs: 60000 });
const identity = host.broker.identity;
if (flags.has('--flood')) await host.broker.pipe.request('Fake.floodLater', { delayMs: 500, bytes: 8 << 20 });
if (flags.has('--partial')) host.broker.pipe.input.write('{"id":99,"method":"Runtime.evaluate","params":{"expression":"1 +');
process.stdout.write(JSON.stringify({ started: true, handle, pid: identity.pid, birth: identity.birth, keeper: host.status().keeper?.pid ?? null }) + '\n');
setInterval(() => {}, 1 << 30);
