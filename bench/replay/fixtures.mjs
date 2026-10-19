import { randomUUID } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { getTasks } from '../tasks.mjs';
import { genericTask } from '../generic-task.mjs';
import { realBrowserPlan, launchRealBrowser, resetRealBrowser, checkBrowserOwner } from '../fowl/real-browser.mjs';
import { startGateSites } from '../fowl/real-gate.mjs';
import { realAgentSetup, gateWindowApps } from '../fowl/real-gate-setup.mjs';
import { executeRealTask } from '../real-run.mjs';
import { observePermission } from '../real-permission.mjs';
import { dragMethodAudit } from '../world/method-check.mjs';

export function nativePlan(recording, dir) {
  const { task, calls, metadata } = recording;
  // These fixture bytes can be restored from the task definition and the recorded nonce.
  const supported = ['textedit-drag', 'textedit-edit', 'textedit-save', 'textedit-window-drag', 'textedit-two-windows',
    'textedit-replace-save', 'textedit-replace-all', 'textedit-insert-line'];
  if (!supported.includes(task.id)) throw Error(`Native fixture ${task.id} is not reproducible by replay; random operands, real accounts and external documents require a saved fixture manifest`);
  const text = JSON.stringify(calls.map(c => c.arguments));
  const paths = [...text.matchAll(/(?:\/[^\s"\\]+)*\/sleight-bench\/[^\s"\\]+\/[^\s"\\]+\/((?:Source-|Target-)?[a-f0-9]{8}(?:-drag|-edit)?\.txt)/g)].map(m => m[0]);
  const folders = [...new Set(paths.map(p => dirname(p).replace(/^\/private(?=\/(?:var|tmp)\/)/, '')))];
  if (folders.length !== 1) throw Error('Native recording needs exactly one owned fixture directory');
  const nonces = [...new Set(paths.map(p => /(?:Source-|Target-)?([a-f0-9]{8})(?:-drag|-edit)?\.txt$/.exec(basename(p))?.[1]).filter(Boolean))];
  if (nonces.length !== 1) throw Error('Native fixture nonce is ambiguous');
  const suite = metadata.suite ?? 'default';
  let definition = getTasks(suite).find(t => t.id === task.id);
  if (!definition) throw Error(`Task ${task.id} missing in current ${suite} suite`);
  if (!definition.fixtureLifecycle) definition = genericTask(definition);
  return { definition, ctx: { dir, nonce: nonces[0], ownerAway: true, stopOnAppDialog: true }, oldDir: folders[0], suite };
}

export async function withNative(recording, { dir, mapper, signal, drive, beforeCall }) {
  const { definition, ctx, oldDir } = nativePlan(recording, dir);
  mapper.addString(oldDir, dir);
  if (/^\/(?:var|tmp)\//.test(oldDir)) mapper.addString('/private' + oldDir, dir);
  let replay;
  const lifecycle = await executeRealTask(definition, ctx, { lockHeld: true, signal,
    permissionCheck: async () => { await beforeCall(); return observePermission(); },
    drive: async () => {
      replay = await drive({ policy: 'bench', env: { BENCH_SUITE: recording.metadata.suite ?? 'default',
        BENCH_WORLD_TASKS: JSON.stringify([recording.task.id]) }, servers: null });
      const transcript = replay.calls.flatMap(row => [
        { message: { content: [{ type: 'tool_use', id: row.id, name: row.name, input: row.arguments }] } },
        { message: { content: [{ type: 'tool_result', tool_use_id: row.id, is_error: row.result?.isError ?? true }] } },
      ]).map(JSON.stringify).join('\n');
      return { code: replay.verdict === 'pass' ? 0 : 1, groupClean: true, out: { result: '' }, methodAudit: dragMethodAudit(transcript) };
    } });
  return { replay, lifecycle, cleanupConfirmed: !lifecycle.cleanupError && !lifecycle.cleanupUnconfirmed && !lifecycle.exitDisagreements?.length };
}

export async function withRace(recording, { dir, repo, mapper, signal, drive, beforeCall, env, mcpRoot = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser') }) {
  const browserName = recording.task.browser;
  const surface = ['firefox', 'safari'].includes(browserName) ? 'sleight' : 'sleight-turbo';
  const plan = realBrowserPlan({ browser: browserName, round: randomUUID(), profile: 'fresh', surface });
  let sites, browser, replay, cleanupConfirmed = true, cleanupError;
  try {
    await beforeCall();
    mkdirSync(dir, { mode: 0o700 });
    sites = await startGateSites(mcpRoot);
    browser = await launchRealBrowser(plan);
    await beforeCall();
    await resetRealBrowser(browser);
    await checkBrowserOwner(browser, { ownedPid: browser.pid });
    // The marker is the only fixture-specific title substitution. Other window titles must match literally.
    const markers = new Set(JSON.stringify(recording.calls).match(/Sleight Gate [a-f0-9-]{36}/g) ?? []);
    if (markers.size > 1) throw Error('Recording names multiple gate windows');
    for (const marker of markers) {
      mapper.addString(marker, browser.marker);
      mapper.addString(encodeURIComponent(marker), encodeURIComponent(browser.marker));
    }
    const arm = realAgentSetup({ task: recording.task, surface, dir, realBrowser: browser, repo, dryRun: false });
    const gate = gateWindowApps(browser);
    replay = await drive({ policy: 'race', env: { ...arm.env, FOWL_GATE_WINDOW: JSON.stringify(gate) },
      servers: arm.mcpConfig.mcpServers, turbo: surface === 'sleight-turbo', gateWindow: surface === 'sleight', switches: env });
  } catch (error) {
    cleanupError = error.message;
    if (error.message === 'BENCH_BROWSER_CLEANUP_UNPROVED' || error.cleanupUnconfirmed) cleanupConfirmed = false;
  } finally {
    try { await sites?.close(); } catch (error) { cleanupError = error.message; cleanupConfirmed = false; }
    // Permission prompts and uncollected drivers forbid further app actions.
    if (signal?.aborted) cleanupConfirmed = false;
    if (browser && cleanupConfirmed) try { await browser.stop(); }
    catch (error) { cleanupError = error.message; cleanupConfirmed = false; }
  }
  return { replay, lifecycle: { cleanupError, browser: { browser: browserName, marker: plan.marker, profileRoot: plan.profileRoot } }, cleanupConfirmed };
}
