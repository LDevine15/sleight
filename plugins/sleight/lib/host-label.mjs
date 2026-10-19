// The host a session runs in, as the menu bar names it ("Codex 0.160.0", "Claude Code 2.1.289"), taken only from the
// MCP client's own `initialize` clientInfo. A missing or odd field is left out, never guessed. No host has been seen to
// report its model through MCP (Claude Code 2.1.289 and Codex 0.160.0 send name, title and version), so there is no model.

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,31}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,71}$/;

const clean = (value, pattern) => typeof value === 'string' && pattern.test(value.trim()) ? value.trim() : undefined;

export function hostLabel(info) {
  if (!info || typeof info !== 'object') return undefined;
  // The title is the client's display name ("Codex", "Claude Code"). Without one, the name in title case ("cursor" is "Cursor").
  const title = clean(info.title, NAME);
  const raw = clean(info.name, NAME);
  const name = title ?? (raw && (/[A-Z\s]/.test(raw) ? raw
    : raw.split(/[-_]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(' ')));
  if (!name) return undefined;
  const version = clean(info.version, VERSION);
  return version ? `${name} ${version}` : name;
}

export const validHostLabel = value => typeof value === 'string' && LABEL.test(value);
