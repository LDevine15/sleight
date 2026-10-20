import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const STDERR_LIMIT = 64 * 1024;
const stderrFiles = { 'plugin:sleight:computer': 'computer.stderr.log', 'sleight-turbo': 'turbo.stderr.log' };

// Cap both the standalone log and stderr in trace.jsonl, independently per owned server.
export function createReplayRecorder(dir) {
  const used = new Map(), truncated = new Set(), decoders = new Map();
  const append = event => appendFileSync(join(dir, 'trace.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  return event => {
    if (event.event !== 'stderr') { append(event); return; }
    const file = Object.hasOwn(stderrFiles, event.server) && stderrFiles[event.server];
    if (!file) throw Error('Unknown replay stderr server');
    const bytes = Buffer.from(event.text), remaining = STDERR_LIMIT - (used.get(event.server) ?? 0);
    if (remaining > 0) {
      const kept = bytes.subarray(0, remaining);
      appendFileSync(join(dir, file), kept, { mode: 0o600 });
      if (!decoders.has(event.server)) decoders.set(event.server, new StringDecoder('utf8'));
      append({ ...event, text: decoders.get(event.server).write(kept) });
      used.set(event.server, (used.get(event.server) ?? 0) + kept.length);
    }
    if (bytes.length > remaining && !truncated.has(event.server)) {
      truncated.add(event.server);
      append({ event: 'stderr-truncated', server: event.server, limitBytes: STDERR_LIMIT, file });
    }
  };
}
