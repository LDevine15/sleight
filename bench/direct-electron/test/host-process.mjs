// Test fixture: a resident host as its own process, so a test can kill it the way a crash would.
// Approves its own launch because it only ever launches the fake Electron from fake-electron.py.
import { runHostEntry } from '../../../plugins/sleight/lib/direct-browser/electron-host-entry.mjs';

const [, , build, ...argv] = process.argv;
const host = await runHostEntry({ argv, deps: { authorizeLaunch: async () => true } });
await host.start({ build });
const handle = host.issueTicket({ session: 'crash-test', ttlMs: 60000 });
const identity = host.broker.identity;
process.stdout.write(JSON.stringify({ started: true, handle, pid: identity.pid, birth: identity.birth }) + '\n');
setInterval(() => {}, 1 << 30);
