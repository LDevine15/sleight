// The live runner's card log: each sleight consent card a worker shows, and its answer, as one JSON line. The runner
// (electron-live-runner.mjs) reads it to say what to click and by when. Lines carry no secrets, paths or page text.
import { appendFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// The consent card's own wall-clock deadline (electron-consent ttlMs): a click after it is refused.
export const CARD_TTL_MS = 120000;
export function cardLine(path, event) {
  if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('.jsonl')) return;
  try { appendFileSync(path, JSON.stringify({ ...event, worker: process.pid }) + '\n', { mode: 0o600 }); } catch {}
}
