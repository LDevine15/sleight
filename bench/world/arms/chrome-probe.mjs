import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromeProbePlan, withChromeArm } from './chrome.mjs';
import { outsideGit } from './browser.mjs';
import { runOwned } from '../../preapproved-process.mjs';

async function command(command, args, options) {
  const result = await runOwned(command, args, { ...options, timeoutMs: 60000 });
  return { status: result.exit.code, stdout: result.stdout, stderr: result.stderr,
    error: result.spawnError || result.timedOut || result.cancelled || !result.groupClean ? new Error('Chrome probe process did not complete cleanly') : undefined };
}

export async function probeChrome(plan, { dir, run = command, launch, signal } = {}) {
  outsideGit(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(plan.settings));
  return withChromeArm(plan.chrome, async () => {
    const options = { cwd: dir, env: plan.env, signal };
    const version = await run(plan.command, ['--version'], options);
    if (version.error) throw version.error;
    if (version.status !== 0 || version.stdout?.trim() !== `${plan.metadata.claudeVersion} (Claude Code)`) throw new Error('Pinned Claude version check failed');
    const result = await run(plan.command, plan.args, options);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Chrome tool probe failed: ${result.stderr || result.status}`);
    const events = result.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
    const tools = events.find(event => event?.type === 'system' && event.subtype === 'init')?.tools || [];
    const chromeTools = tools.filter(name => typeof name === 'string' && name.startsWith('mcp__claude-in-chrome__'));
    const report = { claudeVersion: plan.metadata.claudeVersion, strictMcpConfig: true, chrome: true, maxTurns: 1,
      tools, chromeTools, deviceId: plan.chrome.deviceId, profileFolder: plan.chrome.profileFolder };
    fs.writeFileSync(path.join(dir, 'tools.json'), JSON.stringify(report, null, 2));
    if (!chromeTools.length) throw new Error('No Chrome tools under --strict-mcp-config --chrome; see tools.json');
    return report;
  }, { launch });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), out = args.indexOf('--out');
  if (out < 0 || !args[out + 1]) throw new Error('Use --out <folder outside git>, with --dry-run to print the one-turn probe');
  const dir = path.resolve(args[out + 1]);
  const plan = chromeProbePlan({ dir });
  if (args.includes('--dry-run')) { const { env, ...shown } = plan; console.log(JSON.stringify(shown, null, 2)); }
  else {
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try { console.log(JSON.stringify(await probeChrome(plan, { dir, signal: controller.signal }), null, 2)); }
    finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  }
}
