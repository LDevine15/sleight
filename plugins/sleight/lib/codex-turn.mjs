// Turbo's turn binding inside Codex (1.3.1). Claude Code's mod ties each turbo turn to the user's message with a private
// envelope; a Codex hook can't hold one. Codex's own UserPromptSubmit hook calls turn_started instead, with the prompt
// Codex itself received. Three checks, each from openai/codex 0.160.0's source, keep the model from making that call:
// - turn_started carries `_meta.ui.visibility: []`. Codex lists only tools whose visibility includes "model", and its
//   model path refuses any other by name (codex-mcp binding.rs prepare_call, "not available to the model"). Hooks call
//   tools without that filter (core hook_mcp_executor.rs).
// - Every model call carries `_meta.callId` (core mcp_tool_call.rs build_mcp_tool_call_request_meta). A hook's call
//   carries only `_meta.threadId`. A call with callId is refused here even if Codex ever showed the tool.
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
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.hasOwn(meta, 'callId') ||
      typeof meta.threadId !== 'string' || meta.threadId.toLowerCase() !== args.session_id.toLowerCase()) return undefined;
  const text = Buffer.byteLength(args.prompt) <= MAX_TEXT ? args.prompt : '';
  return { session: args.session_id, turn: args.turn_id, text };
}
