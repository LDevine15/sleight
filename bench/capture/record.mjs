// Records the launch film's windows (docs/design/video-storyboard.md) with bench/capture/recorder.swift. It resolves the
// plan's windows from CGWindowList, checks their size, runs the recorder for every stream at once and checks sync.json.
//
//   node bench/capture/record.mjs <plan.json> [--dry-run]     --dry-run checks the plan and lists the windows it matches
//   node bench/capture/record.mjs --request-permission        the owner's one step: macOS asks for Screen Recording
//
// Plan: {
//   "out": "~/Movies/sleight-film/trick-1",       a new folder; the recorder never overwrites a take
//   "fps": 60, "duration": 15,                    duration in seconds; leave it out to record until Ctrl-C
//   "codec": "prores422hq",                       or "hevc" (quality 1.0); ProRes falls back to HEVC where it can't encode
//   "windows": [
//     { "name": "editor", "pid": 123, "title": "notes.txt", "expect": { "width": 1440, "height": 900, "scale": 2 } },
//     { "name": "hand", "id": 4567 }
//   ],
//   "composites": [{ "name": "hand-over-editor", "windows": ["editor", "hand"] }]
// }
// Every window gets its own stream (<name>.mov), and each composite one more holding just its windows, cropped to their
// union. expect is the window's frame in points, title bar included, as CGWindowList reports it; its scale is checked
// against what the recorder captured. Screenshots and recordings capture single windows (LAWS), so a plan with no window
// is refused, and nothing here can capture a whole display. Live runs start from sleight-arch's own shell, never
// double-forked: macOS gives the recording to the app that started the shell, and needs that app's Screen Recording grant.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { swiftModuleCache } from '../swift-cache.mjs';

const execFileAsync = promisify(execFile);
export const CODECS = ['prores422hq', 'hevc'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const wholeAtLeast = (value, min) => Number.isInteger(value) && value >= min;
const size = ({ width, height }) => `${width} × ${height}`;

export function parsePlan(raw, { home = homedir() } = {}) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  let out = input.out;
  if (typeof out === 'string' && (out === '~' || out.startsWith('~/'))) out = home + out.slice(1);
  if (typeof out !== 'string' || !out.startsWith('/')) errors.push('out must be an absolute path (or start with ~/)');
  const fps = input.fps ?? 60;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) errors.push('fps must be a whole number from 1 to 120');
  const duration = input.duration ?? undefined;
  if (duration !== undefined && !positive(duration)) errors.push('duration must be a positive number of seconds');
  const codec = input.codec ?? 'prores422hq';
  if (!CODECS.includes(codec)) errors.push(`codec must be one of ${CODECS.join(', ')}`);

  const names = new Set();
  const claim = name => {
    if (typeof name !== 'string' || !NAME.test(name)) { errors.push(`window name "${name}" must be letters, digits, - or _`); return false; }
    if (names.has(name)) { errors.push(`name "${name}" is used twice`); return false; }
    names.add(name);
    return true;
  };
  const windows = [];
  if (!Array.isArray(input.windows) || input.windows.length === 0) errors.push('the plan names no window: list them under windows');
  for (const item of Array.isArray(input.windows) ? input.windows : []) {
    const { name, id, pid, title, expect } = item ?? {};
    if (!claim(name)) continue;
    const byId = id !== undefined && pid === undefined && title === undefined && wholeAtLeast(id, 1);
    const byTitle = id === undefined && wholeAtLeast(pid, 1) && typeof title === 'string' && title.length > 0;
    if (!byId && !byTitle) { errors.push(`${name}: give either id or pid and title`); continue; }
    if (expect !== undefined && (!positive(expect?.width) || !positive(expect?.height) || (expect.scale !== undefined && !positive(expect.scale)))) {
      errors.push(`${name}: expect needs positive width and height (and scale, if given)`);
      continue;
    }
    windows.push({ name, ...(byId ? { id } : { pid, title }), ...(expect ? { expect } : {}) });
  }
  const composites = [];
  for (const item of Array.isArray(input.composites) ? input.composites : []) {
    const { name, windows: members } = item ?? {};
    if (!claim(name)) continue;
    if (!Array.isArray(members) || new Set(members).size < 2 || new Set(members).size !== members.length) {
      errors.push(`${name}: a composite needs at least two windows, each named once`);
      continue;
    }
    const missing = members.filter(member => !windows.some(window => window.name === member));
    for (const member of missing) errors.push(`${name}: no window named "${member}"`);
    if (!missing.length) composites.push({ name, windows: [...members] });
  }
  return { plan: { out, fps, duration, codec, windows, composites }, errors };
}

// list: [{ id, pid, owner, title, layer, bounds: { x, y, width, height } }], as `capture-recorder list` prints it.
export function resolveWindows(plan, list) {
  const errors = [], windows = [];
  const untitled = list.every(window => !window.title);
  for (const wanted of plan.windows) {
    if (wanted.id !== undefined) {
      const found = list.find(window => window.id === wanted.id);
      if (found) windows.push({ name: wanted.name, ...found });
      else errors.push(`${wanted.name}: no on-screen window has id ${wanted.id}`);
      continue;
    }
    const ofPid = list.filter(window => window.pid === wanted.pid);
    const matches = ofPid.filter(window => window.title === wanted.title);
    if (matches.length === 1) { windows.push({ name: wanted.name, ...matches[0] }); continue; }
    if (matches.length > 1) {
      errors.push(`${wanted.name}: ${matches.length} windows of pid ${wanted.pid} are titled "${wanted.title}" (${matches.map(window => window.id).join(', ')}); use an id`);
      continue;
    }
    const why = ofPid.length ? `no on-screen window of pid ${wanted.pid} is titled "${wanted.title}"` : `no on-screen window of pid ${wanted.pid}`;
    errors.push(`${wanted.name}: ${why}${untitled ? ' (the window list has no titles: other apps\' titles need Screen Recording for the app that started this)' : ''}`);
  }
  return { windows, errors };
}

export function checkSizes(plan, windows) {
  const errors = [];
  for (const wanted of plan.windows.filter(window => window.expect)) {
    const found = windows.find(window => window.name === wanted.name);
    if (!found) continue;
    if (Math.abs(found.bounds.width - wanted.expect.width) > 0.5 || Math.abs(found.bounds.height - wanted.expect.height) > 0.5) {
      errors.push(`${wanted.name}: window is ${size(found.bounds)} pt, plan expects ${size(wanted.expect)} pt`);
    }
  }
  return errors;
}

export function recorderPlan(plan, windows, codec) {
  const id = name => windows.find(window => window.name === name).id;
  return {
    version: 1, out: plan.out, fps: plan.fps, ...(plan.duration !== undefined ? { duration: plan.duration } : {}), codec,
    streams: [
      ...plan.windows.map(window => ({ name: window.name, windows: [id(window.name)], composite: false })),
      ...plan.composites.map(composite => ({ name: composite.name, windows: composite.windows.map(id), composite: true })),
    ],
  };
}

// recorder: the plan recorderPlan made; parsed: parsePlan's plan, for the expected sizes.
export function checkSync(sync, recorder, parsed) {
  const errors = [];
  if (sync?.version !== 1) errors.push('sync.json version must be 1');
  if (sync?.codec !== recorder.codec) errors.push(`sync.json codec is ${sync?.codec}, plan asked for ${recorder.codec}`);
  if (!['duration', 'signal'].includes(sync?.stoppedBy)) errors.push(`recorder stopped by ${sync?.stoppedBy ?? 'nothing recorded'}`);
  const streams = Array.isArray(sync?.streams) ? sync.streams : [];
  for (const planned of recorder.streams) {
    const name = planned.name;
    const stream = streams.find(item => item?.name === name);
    if (!stream) { errors.push(`${name}: missing from sync.json`); continue; }
    if (stream.error) errors.push(`${name}: ${stream.error}`);
    if (!wholeAtLeast(stream.frames, 1)) errors.push(`${name}: recorded no frames`);
    if (!wholeAtLeast(stream.droppedFrames, 0)) errors.push(`${name}: droppedFrames must be a whole number`);
    if (typeof stream.firstFrameHostTime !== 'number' || !Number.isFinite(stream.firstFrameHostTime)) errors.push(`${name}: firstFrameHostTime must be a number`);
    if (typeof stream.wallClockStart !== 'string' || !ISO.test(stream.wallClockStart) || Number.isNaN(Date.parse(stream.wallClockStart))) {
      errors.push(`${name}: wallClockStart must be an ISO time`);
    }
    const ids = Array.isArray(stream.windows) ? stream.windows.map(window => window?.id) : [];
    if (ids.join() !== planned.windows.join()) errors.push(`${name}: windows are ${ids.join(', ')}, plan has ${planned.windows.join(', ')}`);
    const { sizePt: pt, sizePx: px, scale } = stream;
    if (!positive(pt?.width) || !positive(pt?.height) || !wholeAtLeast(px?.width, 1) || !wholeAtLeast(px?.height, 1) || !positive(scale)) {
      errors.push(`${name}: sizePt, sizePx and scale must be positive`);
      continue;
    }
    // The recorder rounds each side to an even pixel count for the encoder.
    if (Math.abs(px.width - pt.width * scale) > 2 || Math.abs(px.height - pt.height * scale) > 2) {
      errors.push(`${name}: ${size(px)} px is not ${size(pt)} pt at ${scale}x`);
    }
    const members = planned.composite ? parsed.composites.find(item => item.name === name)?.windows ?? [] : [name];
    for (const member of parsed.windows.filter(window => window.expect && members.includes(window.name))) {
      if (member.expect.scale !== undefined && scale !== member.expect.scale) errors.push(`${name}: recorded at ${scale}x, plan expects ${member.expect.scale}x`);
      if (!planned.composite && (Math.abs(pt.width - member.expect.width) > 0.5 || Math.abs(pt.height - member.expect.height) > 0.5)) {
        errors.push(`${name}: recorded ${size(pt)} pt, plan expects ${size(member.expect)} pt`);
      }
    }
  }
  return errors;
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function scrubSync(value, { home = homedir(), user = userInfo().username } = {}) {
  if (typeof value === 'string') {
    let out = value.split(home).join('~').replace(/\/(?:Users|home)\/[^/\s"]+/g, '~');
    if (user && user.length >= 3) out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(user)}(?![\\p{L}\\p{N}])`, 'giu'), '<user>');
    return out;
  }
  if (Array.isArray(value)) return value.map(item => scrubSync(item, { home, user }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubSync(item, { home, user })]));
  return value;
}

let built = null;
export function buildRecorder() {
  built ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sleight-capture-'));
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
    const binary = join(dir, 'capture-recorder');
    await execFileAsync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
      fileURLToPath(new URL('./recorder.swift', import.meta.url)), '-o', binary], { timeout: 240000 });
    return binary;
  })();
  return built;
}
const reply = async (binary, args) => JSON.parse((await execFileAsync(binary, args, { timeout: 20000, encoding: 'utf8' })).stdout);
export const listWindows = async binary => (await reply(binary, ['list'])).windows;
export const codecs = async binary => reply(binary, ['codecs']);

// Ctrl-C reaches the recorder through the terminal's process group; a signal sent to this process alone is passed on.
export function runRecorder(binary, planPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['record', planPath], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const forward = signal => child.kill(signal);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, forward);
    child.on('error', reject);
    child.on('close', code => {
      for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, forward);
      let error;
      try { const last = JSON.parse(stdout.trim().split('\n').at(-1)); error = last.error && [last.error, last.detail].filter(Boolean).join(': '); } catch {}
      resolve({ code, ...(error ? { error } : {}) });
    });
  });
}

export async function record(raw, {
  dryRun = false, home = homedir(), user = userInfo().username, hold = '/tmp/sleight-hold',
  buildRecorder: build = buildRecorder, listWindows: list = listWindows, codecs: encoders = codecs, runRecorder: run = runRecorder,
} = {}) {
  const fail = errors => ({ ok: false, errors });
  const { plan, errors } = parsePlan(raw, { home });
  if (errors.length) return fail(errors);
  if (!dryRun && existsSync(hold) && process.env.SLEIGHT_IGNORE_HOLD !== '1') {
    return fail([`${hold} exists: another project holds a timed window on this Mac; record after it is gone`]);
  }
  const binary = await build();
  const resolved = resolveWindows(plan, await list(binary));
  if (resolved.errors.length) return fail(resolved.errors);
  const sizes = checkSizes(plan, resolved.windows);
  if (sizes.length) return fail(sizes);
  const scrub = value => scrubSync(value, { home, user });
  if (dryRun) {
    return { ok: true, dryRun: true, windows: scrub(resolved.windows), streams: recorderPlan(plan, resolved.windows, plan.codec).streams };
  }

  const streams = recorderPlan(plan, resolved.windows, plan.codec).streams;
  if ([join(plan.out, 'sync.json'), ...streams.map(stream => join(plan.out, `${stream.name}.mov`))].some(path => existsSync(path))) {
    return fail([`${scrub(plan.out)} already holds a take (sync.json or a .mov); give the plan a new out`]);
  }
  const notes = [];
  const available = await encoders(binary);
  let codec = plan.codec;
  if (!available[codec]) {
    if (codec === 'prores422hq' && available.hevc) { codec = 'hevc'; notes.push('ProRes 422 HQ is not available; recording HEVC at quality 1.0'); }
    else return fail([`no encoder for ${codec} on this Mac`]);
  }
  mkdirSync(plan.out, { recursive: true });
  const recorder = recorderPlan(plan, resolved.windows, codec);
  const planPath = join(plan.out, 'recorder-plan.json');
  writeFileSync(planPath, JSON.stringify(recorder, null, 2) + '\n');
  const result = await run(binary, planPath);
  const syncPath = join(plan.out, 'sync.json');
  if (!existsSync(syncPath)) return fail([`recorder exited ${result.code}: ${result.error ?? 'no sync.json'}`]);
  const sync = scrub(JSON.parse(readFileSync(syncPath, 'utf8')));
  writeFileSync(syncPath, JSON.stringify(sync, null, 2) + '\n');
  writeFileSync(planPath, JSON.stringify(scrub(recorder), null, 2) + '\n');
  const problems = checkSync(sync, recorder, plan);
  for (const stream of recorder.streams) if (!existsSync(join(plan.out, `${stream.name}.mov`))) problems.push(`${stream.name}: ${stream.name}.mov is missing`);
  if (result.code !== 0 && !problems.length) problems.push(`recorder exited ${result.code}${result.error ? `: ${result.error}` : ''}`);
  return { ok: problems.length === 0, errors: problems, notes, out: scrub(plan.out), streams: sync.streams };
}

async function main(args) {
  if (args[0] === '--request-permission' && args.length === 1) {
    console.log(JSON.stringify(await reply(await buildRecorder(), ['request-permission'])));
    return 0;
  }
  const dryRun = args.includes('--dry-run');
  const rest = args.filter(arg => arg !== '--dry-run');
  if (rest.length !== 1) {
    console.error('usage: node bench/capture/record.mjs <plan.json> [--dry-run] | --request-permission');
    return 2;
  }
  const result = await record(JSON.parse(readFileSync(rest[0], 'utf8')), { dryRun });
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
