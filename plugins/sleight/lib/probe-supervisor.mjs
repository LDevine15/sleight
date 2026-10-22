import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';

// Keep the native probe behind a pipe-owning process that survives caller loss long enough to reap it.
export function superviseProbe(child, { input, output, owner, deadlineMs = 35000, oneShot = false }) {
  let timer, stopping = false, completed = false, activeId, pending = '';
  const arm = () => { clearTimeout(timer); timer = setTimeout(stop, deadlineMs); };
  function stop() {
    if (stopping || completed) return;
    stopping = true; clearTimeout(timer);
    child.kill('SIGKILL');
  }
  const request = chunk => {
    pending += String(chunk);
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, at); pending = pending.slice(at + 1);
      try { activeId = JSON.parse(line).id; } catch { activeId = undefined; }
      arm();
    }
    if (pending.length > 131072) stop();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      if (!oneShot && JSON.parse(line).id === activeId) { clearTimeout(timer); activeId = undefined; }
    } catch {}
  });
  const events = ['SIGTERM', 'SIGINT', 'SIGHUP', 'disconnect', 'exit'];
  const parentPid = owner.ppid;
  const parentTimer = Number.isInteger(parentPid) ? setInterval(() => { if (owner.ppid !== parentPid || parentPid <= 1) stop(); }, 100) : undefined;
  const endedInput = () => { if (!oneShot) stop(); };
  for (const event of events) owner.on(event, stop);
  input.on('end', endedInput); input.on('close', endedInput); input.on('error', stop);
  output.on('error', stop); child.stdin.on('error', stop); child.on('error', stop);
  input.on('data', request);
  input.pipe(child.stdin); child.stdout.pipe(output, { end: false });
  if (oneShot) arm();
  const done = new Promise(resolve => child.once('close', (code, signal) => {
    completed = true;
    clearTimeout(timer); clearInterval(parentTimer); lines.close();
    input.unpipe(child.stdin); child.stdout.unpipe(output);
    input.removeListener('data', request);
    for (const event of events) owner.removeListener(event, stop);
    for (const event of ['end', 'close']) input.removeListener(event, endedInput);
    input.removeListener('error', stop);
    output.removeListener('error', stop);
    resolve({ code, signal, stopped: stopping });
  }));
  return { done, stop };
}

export function probePlan(mode, input) {
  if (mode === '--launchd-jobs') return { command: '/bin/launchctl', args: ['list'], deadlineMs: 5000, oneShot: true };
  if (mode === '--forbidden-targets') return { command: '/usr/bin/defaults', args: ['read', '-g', 'ComputerUseAllowForbiddenTargets'], deadlineMs: 5000, oneShot: true };
  if (mode === '--resolve-app') return { command: '/usr/bin/osascript',
    args: ['-l', 'JavaScript', fileURLToPath(new URL('./resolve-app-id.js', import.meta.url)), input[0]], deadlineMs: 10000, oneShot: true };
  if (!['--session', '--hand-session', '--once'].includes(mode)) throw new Error('Unknown probe mode');
  const script = fileURLToPath(new URL('./app-health.js', import.meta.url));
  const oneShot = mode === '--once';
  const args = oneShot ? input : ['--session', dirname(script)];
  const deadlineMs = oneShot ? Math.min(35000, Math.max(1000, Number(args[1] ?? 0.5) * 1000 + 1500)) : 35000;
  const jxa = ['-l', 'JavaScript', script, ...args];
  return mode === '--hand-session'
    ? { command: '/usr/bin/nice', args: ['-n', '10', '/usr/bin/osascript', ...jxa], deadlineMs, oneShot }
    : { command: '/usr/bin/osascript', args: jxa, deadlineMs, oneShot };
}

if (isMainModule(import.meta.url)) {
  const { command, args, deadlineMs, oneShot } = probePlan(process.argv[2], process.argv.slice(3));
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  const result = await superviseProbe(child, { input: process.stdin, output: process.stdout, owner: process, deadlineMs, oneShot }).done;
  process.exitCode = result.stopped ? 1 : result.code ?? 1;
  process.stdin.destroy();
}
