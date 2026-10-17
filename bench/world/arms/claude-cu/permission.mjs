import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateAllowedApps(apps) {
  if (!Array.isArray(apps) || apps.length > 64 || apps.some(app => typeof app !== 'string' || !app.trim() ||
    app !== app.trim() || app.length > 256 || /[\x00-\x1f\x7f]/.test(app))) throw new Error('invalid computer-use app allowlist');
  return [...new Set(apps)];
}

function allowedCall(name, input, apps, depth = 0) {
  if (depth > 8 || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (name === 'request_access' && (!Array.isArray(input.apps) || !input.apps.length || !input.apps.every(app => apps.includes(app)))) return false;
  if (name === 'open_application' && !apps.includes(input.app ?? input.bundle_id)) return false;
  for (const key of ['app', 'app_name', 'bundle_id']) if (key in input && !apps.includes(input[key])) return false;
  if (name === 'computer_batch') return Array.isArray(input.actions) && input.actions.length > 0 && input.actions.every(action =>
    typeof action?.action === 'string' && allowedCall(action.action, action, apps, depth + 1));
  return true;
}

export function permissionDecision(input, env = process.env) {
  const event = input?.hook_event_name;
  if (!['PermissionRequest', 'PreToolUse'].includes(event)) return {};
  let apps = [];
  try { apps = validateAllowedApps(JSON.parse(env.BENCH_CU_ALLOWED_APPS)); } catch {}
  const bound = input.session_id === env.BENCH_CU_SESSION && input.cwd === env.BENCH_CU_CWD;
  const tool = /^mcp__computer-use__(\w+)$/.exec(input.tool_name ?? '')?.[1];
  const allowed = bound && apps.length > 0 && !!tool && allowedCall(tool, input.tool_input, apps);
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
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; if (text.length > 65536) process.exit(1); });
  process.stdin.on('end', () => {
    try { process.stdout.write(JSON.stringify(permissionDecision(JSON.parse(text)))); } catch { process.exitCode = 1; }
  });
}
