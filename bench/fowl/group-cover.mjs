// Browser-group admission runs under the group's live lock, after its owned window exists.
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { beginWindowControl } from '../pass-hygiene.mjs';

export const benchmarkFixtureRoots = () => [...new Set([tmpdir(), realpathSync(tmpdir())])].map(base => join(base, 'sleight-bench'));
const frameOK = f => f && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(f[k])) && f.width > 1 && f.height > 1;

// CGWindowList order is front to back. Same-app windows and windows behind the browser cannot cover it.
export function browserCovers(state, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Array.isArray(state?.windows)) throw Error('Browser window inventory unavailable');
  const visible = state.windows.filter(w => w.onScreen && (w.alpha ?? 1) > 0 && frameOK(w.frame));
  const target = visible.filter(w => w.pid === pid && w.layer === 0)
    .sort((a, b) => b.frame.width * b.frame.height - a.frame.width * a.frame.height)[0];
  if (!target) throw Error('Browser window unavailable');
  const covering = visible.slice(0, visible.indexOf(target)).filter(w => w.pid !== pid).flatMap(w => {
    const a = w.frame, b = target.frame;
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? [{ ...w, fraction: width * height / (b.width * b.height) }] : [];
  });
  return { frame: target.frame, covering };
}

function fixtureCover(window, roots) {
  if (window.bundle !== 'com.apple.finder' || typeof window.document !== 'string') return false;
  let path;
  try { path = window.document.startsWith('file:') ? fileURLToPath(window.document) : window.document; } catch { return false; }
  if (!isAbsolute(path)) return false;
  // Never let dot traversal or a symlink turn an apparent scratch path into the owner's folder.
  try { path = realpathSync(path); } catch { path = normalize(path); }
  return roots.some(root => path === root || path.startsWith(root + '/'));
}

export async function waitForBrowserUncovered(pid, { roots = benchmarkFixtureRoots(), snapshot, act, log = console.log,
  signal, wait = ms => delay(ms, undefined, { signal }) } = {}) {
  const closed = new Set();
  for (;;) {
    signal?.throwIfAborted();
    let mustWait = false;
    try {
      const cover = browserCovers(await snapshot(), pid);
      log({ event: 'browser-group-cover', frame: cover.frame, covering: cover.covering.map(({ document, title, ...window }) => window) });
      if (!cover.covering.length) return;
      for (const window of cover.covering) {
        signal?.throwIfAborted();
        const key = `${window.pid}:${window.start}:${window.id}`;
        if (closed.has(key) || !fixtureCover(window, roots)) { mustWait = true; continue; }
        const result = await act({ action: 'close', finderOnly: true, pid: window.pid, start: window.start,
          bundle: window.bundle, id: window.id, fixtures: { fixturePaths: roots, fixtureNames: [] } });
        log({ event: 'finder-fixture-close', id: window.id, result });
        if (result?.closed !== true || result.dialog) mustWait = true;
        else closed.add(key);
      }
    } catch (error) { signal?.throwIfAborted(); log({ event: 'browser-group-cover-error', error: error.message }); mustWait = true; }
    if (mustWait) await wait(60000);
    // Even a successful AX press needs a fresh inventory before the group can start.
  }
}

export async function guardBrowserGroup(pid, { cacheDir, log, signal } = {}) {
  const control = await beginWindowControl({ cacheDir, signal, includeFloating: true });
  await waitForBrowserUncovered(pid, { ...control, log, signal });
}
