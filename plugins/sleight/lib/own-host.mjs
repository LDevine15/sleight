// sleight's own menu bar glove, approval cards and payment cards belong to its consent host, the bare `consent-host`
// binary sleight builds in its helper cache (direct-browser/host.mjs). Only the person's click may answer them, so no
// tool acts on that process. The native helpers (lease-target.js, hover.js, drag.js, select-window.js, menubar.js)
// check the same identity by pid themselves.
import { execFileSync } from 'node:child_process';

export const OWN_HOST_LINE = "That is sleight's own confirmation window; only you can answer it.";
const HELPER_CACHE = /\/Library\/Caches\/sleight\/turbo-host\//i;
// The host's name however it is spelled: case, spaces, `-` or `_`, a path before it or `.app` after it.
const hostName = value => value.trim().replace(/^.*\//, '').replace(/\.app$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'consenthost';

// A name, bundle id or path that is the host: its name, or any file in sleight's helper cache.
export const isOwnHost = (...values) => values.some(value => typeof value === 'string' && (hostName(value) || HELPER_CACHE.test(value)));
// Text that names the host anywhere, such as an approval card's message.
export const mentionsOwnHost = text => typeof text === 'string' && (/consent[\s_-]*host(?![a-z])/i.test(text) || HELPER_CACHE.test(text));

// Whether a running pid is the host, from the executable ps names. The host is spawned by its full path.
export function ownHostPid(pid, run = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { return isOwnHost(String(run('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 1000 })).trim()); }
  catch { return false; }
}

// An app as Claude or the engine names it (a name, bundle id, path, or pid as a number or digits) that is the host.
export function namesOwnHost(app, pidCheck = ownHostPid) {
  if (typeof app === 'number') return pidCheck(app);
  if (typeof app !== 'string') return false;
  return /^\s*\d+\s*$/.test(app) ? pidCheck(Number(app)) : isOwnHost(app);
}

// The getApp targets in js code: each argument made only of string literals (joined with +, escapes decoded) or digits.
// A computed argument is left out: only the engine's approval card can name it, and the relay declines the host's card.
const LITERAL = String.raw`"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|\x60(?:[^\x60\\$]|\\[\s\S]|\$(?!\{))*\x60`;
const PLAIN = new RegExp(String.raw`\s*((?:${LITERAL})(?:\s*\+\s*(?:${LITERAL}))*|\d+)\s*\)`, 'y');
const decode = body => body.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|(\r\n|[\n\r])|([\s\S]))/g,
  (_, x, braced, u, line, other) => {
    if (x || braced || u) { try { return String.fromCodePoint(parseInt(x ?? braced ?? u, 16)); } catch { return ''; } }
    if (line) return '';
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[other] ?? other;
  });
export function getAppTargets(code) {
  const source = String(code ?? ''), literals = [];
  for (const call of source.matchAll(/\bcua\s*(?:\.\s*getApp|\[\s*(["'\x60])getApp\1\s*\])\s*\(/g)) {
    PLAIN.lastIndex = call.index + call[0].length;
    const plain = PLAIN.exec(source);
    if (!plain) continue;
    literals.push(/^\d+$/.test(plain[1]) ? plain[1]
      : [...plain[1].matchAll(new RegExp(LITERAL, 'g'))].map(part => decode(part[0].slice(1, -1))).join(''));
  }
  return literals;
}
