// Which windows cover the benchmark browser's window when a task starts (window-cover.swift reads the window list only).
// The engine's background drags miss in a covered window, so a round records this beside each task's outcome and a drag
// failure can be told apart from a covered window. Recording never fails a round: an error is recorded instead.
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

// { frame, covering: [{ owner, layer, fraction }] }, covering front to back; or { error } when it could not be read.
export async function windowCover(pid, { binary = helper, run = async binary => (await execFileAsync(binary, [String(pid)], { timeout: 5000, encoding: 'utf8' })).stdout } = {}) {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { error: 'no-pid' };
    const reply = JSON.parse(await run(await binary()));
    if (!reply.ok) return { error: reply.error };
    return { frame: reply.frame, covering: reply.covering };
  } catch (error) { return { error: error.code === 'ETIMEDOUT' || error.killed ? 'timeout' : String(error.message).slice(0, 200) }; }
}
