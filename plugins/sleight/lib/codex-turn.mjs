// Turbo's turn binding inside Codex (1.3.1). Claude Code's mod ties each turbo turn to the user's message with a private
// envelope; a Codex hook can't hold one. Codex's own UserPromptSubmit hook calls turn_started instead, with the prompt
// Codex itself received. Three checks, each from openai/codex 0.160.0's source, keep the model from making that call:
// - turn_started carries `_meta.ui.visibility: []`. Codex lists only tools whose visibility includes "model", and its
//   model path refuses any other by name (codex-mcp binding.rs prepare_call, "not available to the model"). Hooks call
//   tools without that filter (core hook_mcp_executor.rs).
// - Every model call carries `_meta.callId`, `sessionId` and Codex's turn metadata (core mcp_tool_call.rs). A hook's call
//   carries only `_meta.threadId`, and anything more is refused here, even if Codex ever showed the tool.
// - The hook's thread must be the session's root: a subagent's prompt is written by the parent model, and a subagent
//   thread's id differs from the session id (core session.rs). Codex older than 0.160.0 is never trusted.
// The threat model is in docs/design/other-hosts.md.

export const TURN_START_TOOL = 'turn_started';
export const TURN_START = Object.freeze({
  name: TURN_START_TOOL,
  description: 'Internal to sleight: Codex\'s prompt hook calls this when the user sends a message. Never call it yourself.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  _meta: { ui: { visibility: [] } },
});

const MIN_VERSION = [0, 160, 0];
// Codex's ids are UUIDs (session) and opaque turn ids; an unexpanded `${...}` template never matches.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN = /^[A-Za-z0-9_.:-]{1,128}$/;
// The worker's binding takes at most 64 KiB of message text. A longer prompt binds with none, so every payment,
// booking, upload and history step asks on sleight's own card instead of trusting a cut message.
const MAX_TEXT = 65536;
// A hook's call: Codex adds the thread id (core hook_mcp_executor.rs); an MCP client may add a progress token.
const HOOK_META = ['threadId', 'progressToken'];

// Codex's MCP client names itself codex-mcp-client (Codex 0.160.0's initialize, tests/fixtures/codex/host-client-info.json).
export function codexTurnClient(info) {
  if (!info || typeof info !== 'object' || info.name !== 'codex-mcp-client' || typeof info.version !== 'string') return false;
  const parts = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.+-]{0,32})?$/.exec(info.version);
  if (!parts) return false;
  const version = parts.slice(1, 4).map(Number);
  for (let i = 0; i < 3; i++) if (version[i] !== MIN_VERSION[i]) return version[i] > MIN_VERSION[i];
  return true;
}

// The hook's call, or undefined when anything about it isn't the hook's: { session, turn, text }.
export function codexTurnFrame(params) {
  const args = params?.arguments, meta = params?._meta;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const keys = Object.keys(args);
  if (keys.length !== 4 || !['hook_event_name', 'session_id', 'turn_id', 'prompt'].every(key => Object.hasOwn(args, key))) return undefined;
  if (args.hook_event_name !== 'UserPromptSubmit' || typeof args.session_id !== 'string' || !UUID.test(args.session_id) ||
      typeof args.turn_id !== 'string' || !TURN.test(args.turn_id) || typeof args.prompt !== 'string') return undefined;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || !Object.keys(meta).every(key => HOOK_META.includes(key)) ||
      typeof meta.threadId !== 'string' || meta.threadId.toLowerCase() !== args.session_id.toLowerCase()) return undefined;
  // A voice session's delegation reaches the hook as a prompt that quotes the voice model (core realtime_conversation.rs).
  const text = Buffer.byteLength(args.prompt) <= MAX_TEXT && !args.prompt.startsWith('<realtime_delegation>') ? args.prompt : '';
  return { session: args.session_id, turn: args.turn_id, text };
}

// Which Codex thread and turn a model's tool call belongs to, from the metadata Codex adds to every model call:
// `_meta.threadId` and `x-codex-turn-metadata.turn_id`, the turn id the prompt hook got. Turbo answers only the bound one,
// so a turn that never ran the prompt hook (a goal continuation, a queued turn, a missed Stop) gets no turbo.
export function codexCallTurn(meta) {
  if (!meta || typeof meta !== 'object' || typeof meta.threadId !== 'string') return undefined;
  let turn = meta['x-codex-turn-metadata'];
  if (typeof turn === 'string') { try { turn = JSON.parse(turn); } catch { return undefined; } }
  if (!turn || typeof turn !== 'object' || typeof turn.turn_id !== 'string' || !TURN.test(turn.turn_id)) return undefined;
  return { thread: meta.threadId.toLowerCase(), turn: turn.turn_id };
}
