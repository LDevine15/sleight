// sleight's own menu bar glove, approval cards and payment cards belong to its consent host, the bare `consent-host`
// binary sleight builds in its helper cache (direct-browser/host.mjs). Only the person's click may answer them, so no
// tool acts on that process. The native helpers (lease-target.js, hover.js, drag.js, select-window.js, menubar.js)
// check the same identity by pid themselves.
import { execFileSync } from 'node:child_process';

export const OWN_HOST_LINE = "That is sleight's own confirmation window; only you can answer it.";
const HELPER_CACHE = /\/Library\/Caches\/sleight\/turbo-host\//i;

// A name, bundle id or path that is the host: its bare name, or any file in sleight's helper cache.
export const isOwnHost = (...values) => values.some(value => typeof value === 'string' &&
  (/^(?:.*\/)?consent-host$/i.test(value.trim()) || HELPER_CACHE.test(value)));

// Whether a running pid is the host, from the executable ps names. The host is spawned by its full path.
export function ownHostPid(pid, run = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { return isOwnHost(String(run('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 1000 })).trim()); }
  catch { return false; }
}
