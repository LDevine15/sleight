import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { superviseProbe } from '../../plugins/sleight/lib/probe-supervisor.mjs';

const mode = process.argv[2], fixture = fileURLToPath(import.meta.url);
if (mode === 'native-fake') {
  process.on('SIGTERM', () => {});
  process.stdout.write(JSON.stringify({ ready: process.pid }) + '\n');
  setInterval(() => {}, 1000);
} else if (mode === 'supervisor' || mode === 'supervisor-once') {
  const child = spawn(process.execPath, [fixture, 'native-fake'], { stdio: ['pipe', 'pipe', 'ignore'] });
  await superviseProbe(child, { input: process.stdin, output: process.stdout, owner: process, deadlineMs: 1000, oneShot: mode === 'supervisor-once' }).done;
  process.stdin.destroy();
} else if (mode === 'parent' || mode === 'parent-once') {
  const child = spawn(process.execPath, [fixture, mode === 'parent-once' ? 'supervisor-once' : 'supervisor'], { stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdout.pipe(process.stdout);
  process.stdin.resume();
  process.stdin.once('end', () => child.stdin.end());
} else throw new Error('Unknown fixture mode');
