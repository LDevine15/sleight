import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnDetachedSession } from '../../plugins/sleight/lib/socket-bridge.mjs';

// Register ownership before readiness or any assertion can fail. IPC also closes on parent death.
export function spawnDemand(f, options = {}) {
  return spawnDetachedSession({ directory: f.directory,
    args: [fileURLToPath(new URL('socket-demand.mjs', import.meta.url)), f.directory],
    ...options,
    spawnChild(command, args, settings) {
      options.observe?.(settings);
      const child = spawn(command, args, { ...settings, stdio: [...settings.stdio, 'ipc'] });
      f.cleanup.push(async () => {
        if (child.connected) child.send({ stop: true }, () => {});
        await child.sessionExit;
      });
      return child;
    },
  });
}
