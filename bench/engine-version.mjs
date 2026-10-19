#!/usr/bin/env node
// Which ChatGPT computer-use engine a benchmark ran on. ChatGPT updates several times a week, so an update no longer forces a
// rerun, and every published result names the engine version instead (LAWS, owner 2026-10-19).
//
// readEngine() is a pure read that calls no engine and launches nothing: the newest engine folder in the Codex plugin cache,
// found the way `sleight-mcp --doctor` finds it (launch.mjs resolveServer, which falls back to the engine inside the ChatGPT
// app), and the ChatGPT app's version and build from its Info.plist. Runners save a span: the read at the start and the read
// at the end, with changed set when they differ. Results saved before 2026-10-19 have no read, so engineForRun() infers the
// version from bench/engine-versions.json, a timeline built from evidence on disk. A run that starts inside a switch window,
// or spans a switch, is ambiguous.
//
//   node bench/engine-version.mjs                          the current read, as JSON
//   node bench/engine-version.mjs record <dir>             writes <dir>/engine.json with the start read (creating <dir>)
//   node bench/engine-version.mjs record <dir> --end       adds the end read to that span (startMissing when there was none)
//   node bench/engine-version.mjs at <ISO start> [<ISO end>]  what the timeline says about a run at that time
//   node bench/engine-version.mjs refresh                  updates the timeline file from this Mac: checkedUTC moves to now while
//                                                          the version is unchanged, and a new version is added from its folder's birth
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';

export const TIMELINE_FILE = fileURLToPath(new URL('./engine-versions.json', import.meta.url));
const VERSION = /^\d+(\.\d+)+$/;

// CFBundleShortVersionString and CFBundleVersion, or null when the app or plutil is missing.
export function readAppPlist(app) {
  const key = name => execFileSync('/usr/bin/plutil', ['-extract', name, 'raw', join(app, 'Contents/Info.plist')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  try { return { version: key('CFBundleShortVersionString'), build: key('CFBundleVersion') }; } catch { return null; }
}

// Never throws: a Mac without the engine reads as version null with the doctor's reason.
export function readEngine({ env = process.env, resolve = resolveServer, plist = readAppPlist, app = true, now = () => new Date() } = {}) {
  let server;
  try { server = resolve(env); } catch (error) { server = { error: error.message }; }
  const version = !server.error && VERSION.test(server.version ?? '') ? server.version : null;
  const read = { version, source: server.error ? null : server.fromChatGPTApp ? 'chatgpt-app' : 'codex-plugin-cache', at: now().toISOString() };
  if (server.error) read.error = String(server.error).split(homedir()).join('~');
  if (app) {
    const info = plist(env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app');
    Object.assign(read, { chatgptApp: info?.version ?? null, chatgptBuild: info?.build ?? null });
  }
  return read;
}

// What a runner saves, with the run's UTC start and end beside the version (owner, 2026-10-19: every result is dated too). end is
// missing while the run is still going (or when it stopped before its last save).
export function engineSpan(start, end) {
  if (!end) return { version: start.version, startedAt: start.at ?? null, start, changed: null };
  const changed = start.version !== end.version || (start.chatgptApp ?? null) !== (end.chatgptApp ?? null) || (start.chatgptBuild ?? null) !== (end.chatgptBuild ?? null);
  return { version: changed ? null : start.version, startedAt: start.at ?? null, endedAt: end.at ?? null, start, end, changed };
}

export const loadTimeline = (file = TIMELINE_FILE) => JSON.parse(readFileSync(file, 'utf8'));

// The checked-in timeline, kept current through now when this Mac still runs its last version: the ChatGPT app deletes the old
// engine folder on every update, so a folder of the same version still in place means no update since the timeline's check.
export function currentTimeline({ timeline = loadTimeline(), read = () => readEngine() } = {}) {
  const last = timeline.versions.at(-1), now = read();
  if (now.version !== last.version || (now.chatgptApp && now.chatgptApp !== last.version)) return timeline;
  return { ...timeline, checkedUTC: now.at, checkedEvidence: `this Mac still reads ${now.version} (${now.source})` };
}

const ms = value => (typeof value === 'number' ? value : Date.parse(value));

// Where one instant falls: inside version i's settled span, inside the switch window into version i, or outside the timeline.
function placeAt(t, timeline) {
  const v = timeline.versions;
  if (!Number.isFinite(t) || t < ms(v[0].firstSeenUTC)) return { outside: 'before' };
  if (t > ms(timeline.checkedUTC)) return { outside: 'after' };
  for (let i = v.length - 1; i >= 0; i--) {
    if (t >= ms(v[i].firstSeenUTC)) return { index: i };
    if (i > 0 && t > ms(v[i].switchedAfterUTC)) return { window: i };
  }
  return { index: 0 };
}

// A run from start to end (end defaults to start): inferred when both ends sit in one version's settled span, ambiguous when
// either end sits in a switch window or the run spans a switch, unknown outside the timeline.
export function inferEngine(start, end = start, timeline = loadTimeline()) {
  const from0 = ms(start), to0 = Math.max(from0, ms(end));
  const a = placeAt(from0, timeline), b = placeAt(Number.isNaN(to0) ? from0 : to0, timeline), v = timeline.versions;
  if (a.outside || b.outside) {
    const which = a.outside ?? b.outside;
    return { version: null, provenance: 'unknown', reason: which === 'before' ? `before the first version in the timeline (${v[0].firstSeenUTC})`
      : `after the timeline's last check (${timeline.checkedUTC})` };
  }
  if (a.index !== undefined && a.index === b.index) return { version: v[a.index].version, provenance: 'inferred' };
  const from = a.index ?? a.window - 1, to = b.index ?? b.window;
  const candidates = v.slice(from, to + 1).map(x => x.version);
  const windows = v.slice(from + 1, to + 1).map(x => `to ${x.version} between ${x.switchedAfterUTC} and ${x.firstSeenUTC}`);
  return { version: null, provenance: 'ambiguous', candidates, reason: `the run overlaps the switch ${windows.join(', and the switch ')}` };
}

function versionOf(recorded, startMs, endMs, timeline) {
  if (typeof recorded === 'string' && VERSION.test(recorded)) return { version: recorded, provenance: 'recorded' };
  const seen = recorded?.start ? [...new Set([recorded.start.version, recorded.end?.version].filter(Boolean))] : [];
  if (seen.length === 1) return { version: seen[0], provenance: 'recorded', ...(recorded.changed && { changedMidRun: true }) };
  if (seen.length > 1) {
    // The engine changed during the run: the timeline can still place a single task on one side of the switch.
    const inferred = Number.isFinite(startMs) ? inferEngine(startMs, Number.isFinite(endMs) ? endMs : startMs, timeline) : null;
    if (inferred?.provenance === 'inferred' && seen.includes(inferred.version)) return { ...inferred, changedMidRun: true };
    return { version: null, provenance: 'ambiguous', candidates: seen, changedMidRun: true, reason: `the engine went from ${seen.join(' to ')} during the run` };
  }
  if (!Number.isFinite(startMs)) return { version: null, provenance: 'unknown', reason: 'no read and no start time' };
  return inferEngine(startMs, Number.isFinite(endMs) ? endMs : startMs, timeline);
}

// One run's engine and date. The version comes from the run's own read, then a span its runner saved, then the timeline over its
// start and end. recorded is a version string (a row's engineVersion) or a span from engineSpan(). startedAt and endedAt are the
// run's UTC times, dated 'recorded' when the run saved them and 'inferred' when they come from a file's stamp or modification time.
export function engineForRun({ recorded, startMs, endMs, dated = 'recorded' }, timeline = loadTimeline()) {
  if (!Number.isFinite(startMs) && (recorded?.startedAt ?? recorded?.start?.at)) {
    startMs = ms(recorded.startedAt ?? recorded.start.at); endMs = ms(recorded.endedAt ?? recorded.end?.at); dated = 'recorded';
  }
  const result = versionOf(recorded, startMs, endMs, timeline);
  if (!Number.isFinite(startMs)) return result;
  return { ...result, startedAt: new Date(startMs).toISOString(), endedAt: new Date(Number.isFinite(endMs) ? Math.max(startMs, endMs) : startMs).toISOString(), dated };
}

// A bench/run.mjs pass file's stamp (2026-10-17T04-20-31-416Z) as epoch ms.
export const stampMs = stamp => Date.parse(String(stamp ?? '').replace(/^(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z.*$/, '$1:$2:$3.$4Z'));

// One row of a bench/run.mjs pass. A row saved since 2026-10-19 carries its engine read and finishedAt, so its start is finishedAt
// less its seconds. An older row gets the pass's span, else the timeline, over the pass's start (its stamp) to its last save (the
// file's mtime when known, else the start plus every row's seconds), and that date is inferred.
export function passRowEngine(raw, row, { file, mtimeMs, timeline = loadTimeline() } = {}) {
  const recorded = row.engineVersion ?? raw.engine ?? (typeof raw.engineVersion === 'string' ? raw.engineVersion : undefined);
  const finished = Date.parse(row.finishedAt ?? '');
  if (Number.isFinite(finished)) return engineForRun({ recorded, startMs: finished - (Number(row.seconds) || 0) * 1000, endMs: finished }, timeline);
  let startMs = stampMs(raw.stamp ?? file), endMs;
  if (!Number.isFinite(startMs)) startMs = Date.parse([raw.started, raw.date].find(v => /T\d\d:/.test(v ?? '')) ?? '');
  if (Number.isFinite(startMs)) {
    // A copied folder's mtime is the copy's time, so the mtime counts only when it is plausible for the pass: no earlier than its
    // runs' seconds and no later than three times them plus 30 minutes of setup.
    const busy = (raw.results ?? []).reduce((sum, r) => sum + (Number(r.seconds) || 0), 0) * 1000;
    endMs = Number.isFinite(mtimeMs) && mtimeMs >= startMs + busy && mtimeMs <= startMs + 3 * busy + 1800000 ? mtimeMs : startMs + busy;
  }
  else {
    // Only the day in the file's name: the whole UTC day stands for the run, so a version is inferred only for a day it covered alone.
    const day = /^(\d{4}-\d\d-\d\d)/.exec(file ?? '')?.[1];
    if (!day) return engineForRun({ recorded }, timeline);
    startMs = Date.parse(`${day}T00:00:00Z`); endMs = startMs + 86399999;
  }
  return engineForRun({ recorded, startMs, endMs: Math.max(startMs, endMs), dated: 'inferred' }, timeline);
}

// '2026-10-19', or '2026-10-18 to 2026-10-19' (UTC days).
export const dayRange = (first, last) => !first ? 'no date' : first.slice(0, 10) === (last ?? first).slice(0, 10) ? first.slice(0, 10) : `${first.slice(0, 10)} to ${last.slice(0, 10)}`;

// Only sleight's arms and Codex's arms drive the ChatGPT engine. LCU, Cua, Peekaboo, FowlBrowser, Claude in Chrome and Claude's
// own computer use don't, so their version is context, never a difference between arms.
export const usesEngine = arm => /^(sleight|codex)(-|$)/.test(String(arm));

// Per arm: for each version (and for ambiguous and unknown runs) how many runs, read or inferred, and their UTC dates.
export function summarizeEngines(rows) {
  const out = {};
  const add = (bucket, engine) => {
    bucket.runs += 1;
    if (engine?.provenance === 'recorded') bucket.recorded += 1;
    if (!engine?.startedAt) bucket.undated += 1;
    else {
      if (!bucket.first || engine.startedAt < bucket.first) bucket.first = engine.startedAt;
      if (!bucket.last || engine.endedAt > bucket.last) bucket.last = engine.endedAt;
      if (engine.dated === 'inferred') bucket.datesInferred += 1;
    }
  };
  const fresh = () => ({ runs: 0, recorded: 0, first: null, last: null, datesInferred: 0, undated: 0 });
  for (const { arm, engine } of rows) {
    const s = out[arm] ??= { versions: {}, ambiguous: fresh(), unknown: fresh() };
    add(engine?.version ? (s.versions[engine.version] ??= fresh()) : engine?.provenance === 'ambiguous' ? s.ambiguous : s.unknown, engine);
  }
  return out;
}

const bucketText = (label, b, counts) => {
  const dates = b.first ? dayRange(b.first, b.last) + (b.datesInferred === b.runs ? ' (dates inferred)' : b.datesInferred ? ` (${b.datesInferred} dates inferred)` : '') : 'no date';
  return `${label}${counts ? ` (${counts})` : ''}, ${dates}${b.undated && b.first ? `, ${b.undated} undated` : ''}`;
};

// 'engine 26.1007.71326 (36 inferred), 2026-10-18; 4 ambiguous, 2026-10-18', for tables. An arm that doesn't drive the engine
// reads 'not used' with its dates.
export function engineText(summary, arm) {
  const all = summary ? [...Object.values(summary.versions), summary.ambiguous, summary.unknown].filter(b => b.runs) : [];
  if (arm !== undefined && !usesEngine(arm)) {
    const first = all.map(b => b.first).filter(Boolean).sort()[0], last = all.map(b => b.last).filter(Boolean).sort().at(-1);
    return `not used${first ? `, ${dayRange(first, last)}` : ''}`;
  }
  if (!all.length) return 'not recorded';
  const parts = Object.entries(summary.versions).sort(([a], [b]) => (a < b ? -1 : 1)).map(([version, b]) =>
    bucketText(`engine ${version}`, b, [b.recorded && `${b.recorded} recorded`, b.runs - b.recorded && `${b.runs - b.recorded} inferred`].filter(Boolean).join(', ')));
  if (summary.ambiguous.runs) parts.push(bucketText(`${summary.ambiguous.runs} ambiguous`, summary.ambiguous));
  if (summary.unknown.runs) parts.push(bucketText(`${summary.unknown.runs} unknown`, summary.unknown));
  return parts.join('; ');
}

// Arms compared in one table may run on different versions (allowed), and the table must say so. Only arms that drive the
// engine count. Null when the resolved runs all ran one version.
export function engineMix(byArm) {
  const arms = Object.entries(byArm).filter(([arm]) => usesEngine(arm));
  const all = [...new Set(arms.flatMap(([, s]) => Object.keys(s.versions)))].sort();
  if (all.length < 2) return null;
  return { versions: all, arms: Object.fromEntries(arms.map(([arm, s]) => [arm, Object.keys(s.versions).sort()])) };
}
export const mixText = mix => `The arms that drive the engine ran on different engine versions: ${Object.entries(mix.arms).map(([arm, versions]) => `${arm} on ${versions.join(' and ') || 'no known version'}`).join(', ')}.`;

// The sentence under a table: the mix, or one version, and how many engine-arm runs have no settled version.
export function engineNote(byArm, mix = engineMix(byArm)) {
  const unresolved = Object.entries(byArm).filter(([arm]) => usesEngine(arm)).reduce((n, [, s]) => n + s.ambiguous.runs + s.unknown.runs, 0);
  const versions = [...new Set(Object.entries(byArm).filter(([arm]) => usesEngine(arm)).flatMap(([, s]) => Object.keys(s.versions)))];
  const head = mix ? mixText(mix) : versions.length ? `The arms that drive the engine ran on one engine version, ${versions[0]}.` : 'No arm here drives the engine with a known version.';
  return unresolved ? `${head} ${unresolved} of their runs have no settled version (ambiguous or unknown).` : head;
}

// The refresh step for the timeline file: run it before collecting results on the benchmark Mac.
export function refreshTimeline(timeline, { read = readEngine(), folderBirth } = {}) {
  const last = timeline.versions.at(-1);
  if (!read.version) return { timeline, changed: false, reason: read.error ?? 'no engine read' };
  if (read.version === last.version) return { timeline: { ...timeline, checkedUTC: read.at, checkedEvidence: `the engine folder was still ${read.version} (refresh)` }, changed: true };
  if (!folderBirth) return { timeline, changed: false, reason: 'no birth time for the new engine folder' };
  const entry = { version: read.version, switchedAfterUTC: timeline.checkedUTC, firstSeenUTC: folderBirth,
    evidence: [`the timeline's last check of ${last.version} (${timeline.checkedUTC})`, `the engine folder ${read.version} was born ${folderBirth} (refresh at ${read.at})`] };
  return { timeline: { ...timeline, checkedUTC: read.at, checkedEvidence: `the engine folder was ${read.version} (refresh)`, versions: [...timeline.versions, entry] }, changed: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'record') {
    const dir = rest[0], file = join(dir ?? '', 'engine.json');
    if (!dir) { console.error('usage: engine-version.mjs record <dir> [--end]'); process.exit(2); }
    const now = readEngine();
    let span;
    if (rest.includes('--end')) {
      let before; try { before = JSON.parse(readFileSync(file, 'utf8')); } catch { before = undefined; }
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) { console.error(`engine-version.mjs: no folder ${dir}`); process.exit(2); }
      // Without a start read the span keeps only the end, so it never claims the version held for the whole run.
      span = before?.start ? engineSpan(before.start, now) : { version: null, startedAt: null, endedAt: now.at, start: null, end: now, changed: null, startMissing: true };
    } else { mkdirSync(dir, { recursive: true }); span = engineSpan(now); }
    writeFileSync(file, JSON.stringify(span, null, 2) + '\n');
  } else if (command === 'at') {
    console.log(JSON.stringify(inferEngine(rest[0], rest[1] ?? rest[0], currentTimeline()), null, 2));
  } else if (command === 'refresh') {
    const server = resolveServer(), read = readEngine();
    let folderBirth;
    try { folderBirth = server.configPath && !server.fromChatGPTApp ? statSync(dirname(server.configPath)).birthtime.toISOString() : undefined; } catch { folderBirth = undefined; }
    const result = refreshTimeline(loadTimeline(), { read, folderBirth });
    if (result.changed) writeFileSync(TIMELINE_FILE, JSON.stringify(result.timeline, null, 2) + '\n');
    console.log(result.changed ? `timeline checked through ${result.timeline.checkedUTC}, last version ${result.timeline.versions.at(-1).version}` : `timeline unchanged: ${result.reason}`);
  } else console.log(JSON.stringify(readEngine()));
}
