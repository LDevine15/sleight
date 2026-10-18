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

// { frame, covering: [{ owner, layer, fraction }] }, covering front to back, plus { moved, from } with place; or { error }.
export async function windowCover(pid, { place = false, binary = helper, run = async (binary, args) => (await execFileAsync(binary, args, { timeout: 5000, encoding: 'utf8' })).stdout } = {}) {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { error: 'no-pid' };
    const reply = JSON.parse(await run(await binary(), [String(pid), ...(place ? ['place'] : [])]));
    if (!reply.ok) return { error: reply.error };
    return { frame: reply.frame, covering: reply.covering, ...(place ? { moved: reply.moved === true, ...(reply.from ? { from: reply.from } : {}) } : {}) };
  } catch (error) { return { error: error.code === 'ETIMEDOUT' || error.killed ? 'timeout' : String(error.message).slice(0, 200) }; }
}
