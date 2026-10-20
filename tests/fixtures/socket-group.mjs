// Offline relay and engine descendant. A release file lets failed assertions collect both.
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const [mode, root] = process.argv.slice(2);
process.on('SIGTERM', () => {});
const watchdog = setInterval(() => { if (!existsSync(root) || existsSync(root + '/release')) process.exit(0); }, 10);
if (mode === 'engine') {
  writeFileSync(root + '/engine.pid', String(process.pid));
  process.send({ ready: true });
  process.disconnect();
} else {
  const engine = spawn(process.execPath, [fileURLToPath(import.meta.url), 'engine', root],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise(resolve => engine.once('message', resolve));
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const msg = JSON.parse(line);
    if (msg.id === undefined || msg.method !== 'initialize') return;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }) + '\n');
  });
  lines.on('close', () => { if (mode === 'exit') { clearInterval(watchdog); process.exit(0); } });
}
