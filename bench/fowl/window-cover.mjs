// Which windows cover the benchmark browser's window when a task starts (window-cover.swift). The engine's background drags
// miss in a covered window, so before each task the round moves its own browser window to the place on any display that the
// fewest other windows overlap (`place`), and records what still covers it beside the task's outcome. The race's own
// Terminal windows and the owner's windows covered Safari on 2026-10-18. Neither step ever fails a round: an error is recorded.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { swiftModuleCache } from '../swift-cache.mjs';

const execFileAsync = promisify(execFile);
let built = null;

async function helper() {
  built ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sleight-window-cover-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    const binary = join(dir, 'window-cover');
    await execFileAsync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
      fileURLToPath(new URL('./window-cover.swift', import.meta.url)), '-o', binary], { timeout: 120000 });
    return binary;
  })();
  return built;
}

// { frame, covering: [{ owner, layer, fraction }] }, covering front to back, plus { moved, from, screens, bestOverlap } with place;
// or { error }. bestOverlap is the other windows' area over the best spot found, as a share of the window (stacked windows add).
export async function windowCover(pid, { place = false, binary = helper, run = async (binary, args) => (await execFileAsync(binary, args, { timeout: 5000, encoding: 'utf8' })).stdout } = {}) {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { error: 'no-pid' };
    const reply = JSON.parse(await run(await binary(), [String(pid), ...(place ? ['place'] : [])]));
    if (!reply.ok) return { error: reply.error };
    return { frame: reply.frame, covering: reply.covering, ...(place ? { moved: reply.moved === true, ...(reply.from ? { from: reply.from } : {}),
      ...(Number.isFinite(reply.screens) ? { screens: reply.screens, bestOverlap: reply.bestOverlap } : {}) } : {}) };
  } catch (error) { return { error: error.code === 'ETIMEDOUT' || error.killed ? 'timeout' : String(error.message).slice(0, 200) }; }
}

// The windows that covered the browser's window at any reading: each app once, with the largest share it covered.
export function summarizeCover(readings) {
  const share = new Map();
  let errors = 0;
  for (const reading of readings) {
    if (!reading || reading.error) { errors++; continue; }
    for (const { owner, fraction } of reading.covering) share.set(owner, Math.max(share.get(owner) ?? 0, fraction));
  }
  return { readings: readings.length, errors, covering: [...share].map(([owner, fraction]) => ({ owner, fraction })) };
}

// Reads the cover every `every` ms while the agent runs and once more at stop, one read at a time. A window can come over the
// browser's after the task starts: the Claude app's did in Firefox codex-sleight-sol b16-r2 (form-settings-helium, 2026-10-19),
// where the start reading was clean. It only reads the window list: nothing is moved, raised or activated.
export function watchCover(pid, { every = 5000, read = windowCover } = {}) {
  const readings = [];
  let chain = Promise.resolve(), busy = false;
  const take = () => {
    if (busy) return chain;
    busy = true;
    chain = chain.then(async () => { readings.push(await read(pid)); }).catch(error => { readings.push({ error: String(error.message) }); })
      .finally(() => { busy = false; });
    return chain;
  };
  const timer = setInterval(take, every);
  timer.unref?.();
  return { async stop() { clearInterval(timer); await chain; await take(); return summarizeCover(readings); } };
}
