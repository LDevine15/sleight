// The host a session runs in, as the menu bar names it ("Codex 0.160.0", "Claude Code 2.1.289"), taken only from the
// MCP client's own `initialize` clientInfo. A missing or odd field is left out, never guessed. No host has been seen to
// report its model through MCP (Claude Code 2.1.289 and Codex 0.160.0 send name, title and version), so there is no model.

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,39}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,31}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,71}$/;
// Clients that send a fixed name and version, read from their own code: Cursor 3.25.6's editor sends
// {name: "cursor-vscode", version: "1.0.0"} and cursor-agent 2026.09.10 sends {name: "Cursor", version: "1.0.0"}.
// That version names no Cursor release, so it is left out.
const FIXED = new Map([['cursor-vscode', { name: 'Cursor', version: '1.0.0' }], ['Cursor', { name: 'Cursor', version: '1.0.0' }]]);

const clean = (value, pattern) => typeof value === 'string' && pattern.test(value.trim()) ? value.trim() : undefined;

// GL1 on Grok CLI 1.0.13 recorded grok-shell-computer and grok-shell-sleight: the suffix is the server key.
export const isGrokClient = info => typeof info?.name === 'string' && info.name.startsWith('grok-shell-');

// The client's display name without a version: its title ("Codex", "Claude Code"), a fixed client's own name, or the
// name in title case ("codex-mcp-client" is "Codex Mcp Client").
export function hostName(info) {
  if (!info || typeof info !== 'object') return undefined;
  const title = clean(info.title, NAME);
  if (title) return title;
  if (isGrokClient(info)) return 'Grok';
  const raw = clean(info.name, NAME);
  if (!raw) return undefined;
  if (FIXED.has(raw)) return FIXED.get(raw).name;
  return /[A-Z\s]/.test(raw) ? raw : raw.split(/[-_]+/).filter(Boolean).map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
}

export function hostLabel(info) {
  const name = hostName(info);
  if (!name) return undefined;
  const version = clean(info.version, VERSION);
  const fixed = !clean(info.title, NAME) && FIXED.get(clean(info.name, NAME));
  return version && version !== fixed?.version ? `${name} ${version}` : name;
}

export const validHostLabel = value => typeof value === 'string' && LABEL.test(value);
