import { existsSync, readFileSync } from 'node:fs';

// The hooks an arm's own setup wrote to its project settings, added after the bench's own. A guarded arm runs with
// --setting-sources '', which drops that file: lcu 0.11.2 then refused every call for want of its PreToolUse identity hook
// (2026-10-16). Only hooks come across; the arm's permissions and other settings stay out of the comparison.
export function mergeArmHooks(settings, file) {
  if (!existsSync(file)) return settings;
  const own = JSON.parse(readFileSync(file, 'utf8')).hooks ?? {};
  const hooks = { ...settings.hooks };
  for (const [event, entries] of Object.entries(own)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  return { ...settings, hooks };
}
