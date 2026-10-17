import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateAllowedApps(apps) {
  if (!Array.isArray(apps) || apps.length > 64 || apps.some(app => typeof app !== 'string' || !app.trim() ||
    app !== app.trim() || app.length > 256 || /[\x00-\x1f\x7f]/.test(app))) throw new Error('invalid computer-use app allowlist');
  return [...new Set(apps)];
}

const grants = ['clipboardRead', 'clipboardWrite', 'systemKeyCombos', 'shellAccess', 'fileAccess', 'systemSettings'];
export function validateAllowedGrants(values) {
  if (!Array.isArray(values) || values.some(value => !grants.includes(value))) throw new Error('invalid computer-use grant allowlist');
  return [...new Set(values)];
}

// Claude Code 2.1.289's computer-use tools and batch actions (live 15:40Z). Screen-coordinate tools reach only apps the session
// granted: the server hides every other app before acting. Full control, teaching and the clipboard (without its grant) stay out.
const tools = new Set(['request_access', 'list_granted_applications', 'list_apps', 'open_application', 'screenshot', 'zoom',
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'left_mouse_down', 'left_mouse_up',
  'mouse_move', 'cursor_position', 'type', 'key', 'hold_key', 'scroll', 'wait', 'switch_display', 'computer_batch', 'release_full_control',
  'app_screenshot', 'app_zoom', 'app_click', 'app_type', 'app_key', 'app_scroll', 'app_drag', 'app_menu', 'app_ax_find',
  'app_list_windows', 'app_focus', 'app_release', 'app_bring_to_current_space', 'app_batch',
  'click', 'move', 'drag']);
function allowedTargets(input, apps, allowedGrants, depth = 0) {
  if (depth > 16) return false;
  if (!input || typeof input !== 'object') return true;
  if (Array.isArray(input)) return input.every(value => allowedTargets(value, apps, allowedGrants, depth + 1));
  for (const [key, value] of Object.entries(input)) {
    if (['app', 'app_name', 'bundle_id'].includes(key) && !apps.includes(value)) return false;
    if (key === 'apps' && (!Array.isArray(value) || !value.length || !value.every(app => apps.includes(app)))) return false;
    if (grants.includes(key) && (typeof value !== 'boolean' || value && !allowedGrants.includes(key))) return false;
    if (!allowedTargets(value, apps, allowedGrants, depth + 1)) return false;
  }
  return true;
}
function allowedCall(name, input, apps, allowedGrants, depth = 0, app) {
  if (name === 'read_clipboard' && allowedGrants.includes('clipboardRead') || name === 'write_clipboard' && allowedGrants.includes('clipboardWrite')) return true;
  if (depth > 8 || !tools.has(name) || !input || typeof input !== 'object' || Array.isArray(input) ||
    !allowedTargets(input, apps, allowedGrants)) return false;
  if (name === 'request_access' && (!Array.isArray(input.apps) || !input.apps.length ||
    input.reason !== undefined && typeof input.reason !== 'string' ||
    Object.keys(input).some(key => !['action', 'apps', 'reason', 'clipboardRead', 'clipboardWrite', 'systemKeyCombos'].includes(key)))) return false;
  const target = input.app ?? input.app_name ?? input.bundle_id ?? app;
  if ((name === 'open_application' || name.startsWith('app_')) && !apps.includes(target)) return false;
  if (name === 'computer_batch' || name === 'app_batch') return Array.isArray(input.actions) && input.actions.length > 0 && input.actions.every(action =>
    typeof action?.action === 'string' && allowedCall(action.action, action, apps, allowedGrants, depth + 1, name === 'app_batch' ? target : undefined));
  return true;
}

export function permissionDecision(input, env = process.env) {
  const event = input?.hook_event_name;
  if (!['PermissionRequest', 'PreToolUse'].includes(event)) throw new Error('malformed hook event');
  let apps = [], allowedGrants = [];
  try {
    apps = validateAllowedApps(JSON.parse(env.BENCH_CU_ALLOWED_APPS));
    allowedGrants = validateAllowedGrants(JSON.parse(env.BENCH_CU_ALLOWED_GRANTS ?? '[]'));
  } catch { apps = []; }
  const bound = typeof env.BENCH_CU_SESSION === 'string' && !!env.BENCH_CU_SESSION && typeof env.BENCH_CU_CWD === 'string' && !!env.BENCH_CU_CWD &&
    input.session_id === env.BENCH_CU_SESSION && input.cwd === env.BENCH_CU_CWD;
  const tool = /^mcp__computer-use__(\w+)$/.exec(input.tool_name ?? '')?.[1];
  const allowed = bound && apps.length > 0 && !!tool && allowedCall(tool, input.tool_input, apps, allowedGrants);
  if (event === 'PreToolUse') {
    if (bound && /^(?:ToolSearch|WaitForMcpServers)$/.test(input.tool_name ?? '') || allowed) return {};
    return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny',
      permissionDecisionReason: 'Computer-use benchmark tool or app is outside the task allowlist.' } };
  }
  return { hookSpecificOutput: { hookEventName: event, decision: { behavior: allowed ? 'allow' : 'deny',
    ...(!allowed && { message: 'Computer-use benchmark tool or app is outside the task allowlist.' }) } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = '';
  const deny = reason => { process.stderr.write(`Computer-use benchmark denied: ${reason}.\n`); process.exit(2); };
  const timer = setTimeout(() => deny('hook stdin timeout'), 4000);
  process.on('uncaughtException', () => deny('hook failure'));
  process.on('unhandledRejection', () => deny('hook failure'));
  process.stdin.on('error', () => deny('hook stdin failure'));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; if (text.length > 65536) deny('oversized hook stdin'); });
  process.stdin.on('end', () => {
    clearTimeout(timer);
    try { process.stdout.write(JSON.stringify(permissionDecision(JSON.parse(text)))); } catch { deny('malformed hook stdin'); }
  });
}
