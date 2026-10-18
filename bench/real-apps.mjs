import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runOwned } from './preapproved-process.mjs';
import { swiftModuleCache } from './swift-cache.mjs';
import { cleanupElectron } from './real-electron.mjs';

// The Slack and Spotify claim tasks (owner, 2026-10-18). Both run in the owner's own accounts with the owner away:
// Slack's throwaway workspace takes one fixed message in one test channel, and Spotify plays and pauses one track.
// Each task launches its app in the background, and the quit goes by pid through NSRunningApplication, never an Apple event
// (this Mac has no Automation grant for either app).
export const SLACK = { app: 'Slack', bundle: 'com.tinyspeck.slackmacgap', channel: 'new-channel' };
export const SPOTIFY = { app: 'Spotify', bundle: 'com.spotify.client', track: 'Bohemian Rhapsody', artist: 'Queen' };
export const APP_NAMES = {
  slack: [SLACK.app, SLACK.bundle],
  spotify: [SPOTIFY.app, SPOTIFY.bundle],
};

const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (message, noMutation = false) => Object.assign(new Error(message), { noMutation });

// ---- Decisions (pure) ----

// counts comes from the helper: whether the channel's list was found, how many of its static texts equal the message exactly,
// and whether the composer still holds the text.
export function judgeSlack(counts) {
  if (!counts || typeof counts !== 'object') return 'SLACK_CHECK_UNAVAILABLE';
  if (counts.listFound !== true) return 'SLACK_CHANNEL_LIST_MISSING';
  if (counts.count !== 1) return `SLACK_POST_COUNT_${Number.isSafeInteger(counts.count) ? counts.count : 'UNKNOWN'}`;
  if (counts.composerHolds !== false) return 'SLACK_COMPOSER_HOLDS_TEXT';
  return true;
}

const lower = value => String(value ?? '').trim().toLowerCase();
const sameTrack = (a, b) => a['Track ID'] && b['Track ID'] ? a['Track ID'] === b['Track ID'] : lower(a.Name) === lower(b.Name);

// Pass when a Playing event names the song by Queen (a remaster's longer name counts) and the last event of the run is a
// Paused event for that same track.
export function judgeSpotify(events) {
  if (!Array.isArray(events) || !events.length) return 'SPOTIFY_NO_EVENTS';
  const plays = events.filter(event => lower(event['Player State']) === 'playing'
    && lower(event.Name).startsWith(lower(SPOTIFY.track)) && lower(event.Artist).includes(lower(SPOTIFY.artist)));
  if (!plays.length) return 'SPOTIFY_NO_MATCHING_PLAY';
  const last = events.at(-1);
  if (lower(last['Player State']) !== 'paused') return 'SPOTIFY_NOT_PAUSED_AT_END';
  return plays.some(play => sameTrack(play, last)) || 'SPOTIFY_PAUSED_OTHER_TRACK';
}

export function parseSpotifyLines(text) {
  const events = [];
  let ready = false;
  for (const line of String(text).split('\n')) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value?.ready === true) ready = true;
    else if (value && typeof value === 'object' && 'Player State' in value) {
      events.push(Object.fromEntries(['Name', 'Artist', 'Player State', 'Track ID'].map(key => [key, String(value[key] ?? '')])));
    }
  }
  return { ready, events };
}

// ---- Native adapter (compiled Swift helpers) ----

const binaries = new Map();
let bank;
process.once('exit', () => { if (bank) rmSync(bank, { recursive: true, force: true }); });
function compiled(source, signal) {
  if (!binaries.has(source)) {
    const attempt = (async () => {
      bank ??= mkdtempSync(join(tmpdir(), 'sleight-apps-helper-'));
      const path = join(bank, source.replace(/\.swift$/, ''));
      const result = await runOwned('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
        fileURLToPath(new URL(`./${source}`, import.meta.url)), '-o', path], { signal, timeoutMs: 180000 });
      if (!result.groupClean || result.exit?.code !== 0 || result.cancelled || result.timedOut || result.spawnError) {
        throw failure(`${source} did not compile`);
      }
      return path;
    })();
    binaries.set(source, attempt);
    attempt.catch(() => binaries.delete(source));
  }
  return binaries.get(source);
}

function guardTests() {
  // Never reach the owner's Slack or Spotify from a test (chat apps were launched once by an offline test, 2026-10-11).
  if (process.env.NODE_TEST_CONTEXT) throw failure('APP_NATIVE_UNAVAILABLE_IN_TESTS', true);
}

async function probe(ctx, request) {
  guardTests();
  const command = await compiled('real-apps.swift', ctx.signal);
  const result = await runOwned(command, [JSON.stringify(request)], { signal: ctx.signal, timeoutMs: 45000 });
  if (!result.groupClean) throw failure('APP_HELPER_UNCOLLECTED');
  if (result.timedOut) throw failure('APP_NATIVE_TIMEOUT');
  if (result.exit?.code !== 0 || result.cancelled || result.spawnError) throw failure(result.stderr.trim() || 'APP_SETUP_FAILED');
  try { return JSON.parse(result.stdout); } catch { throw failure('APP_SETUP_FAILED'); }
}

// The listener starts before the prompt and stops after the check. Cancelling the owned group ends it.
async function startListener(ctx) {
  guardTests();
  const command = await compiled('spotify-listener.swift', ctx.signal);
  const stop = new AbortController();
  let text = '';
  let wake;
  const run = runOwned(command, [], { signal: stop.signal, timeoutMs: 2 * 60 * 60 * 1000, graceMs: 3000,
    onStdout: data => { text += data; wake?.(); } });
  const deadline = Date.now() + 20000;
  while (!parseSpotifyLines(text).ready) {
    if (Date.now() > deadline) { stop.abort(); await run; throw failure('Spotify listener did not start'); }
    await new Promise(resolve => { wake = resolve; setTimeout(resolve, 200); });
  }
  let stopped;
  return {
    events: () => parseSpotifyLines(text).events,
    // Resolves true once the process group is collected.
    stop: () => stopped ??= (async () => { stop.abort(); return (await run).groupClean === true; })(),
  };
}

export const appNative = {
  table: async (ctx, bundle) => probe(ctx, { op: 'table', bundle }),
  ready: async (ctx, bundle, pid) => (await probe(ctx, { op: 'ready', bundle, pid })).ready === true,
  quit: async (ctx, bundle, pid) => (await probe(ctx, { op: 'quit', bundle, pid })).quit === true,
  slack: async (ctx, pid, nonce) => probe(ctx, { op: 'slack', bundle: SLACK.bundle, pid, nonce, channel: SLACK.channel }),
  open: async bundle => { guardTests(); await execute('/usr/bin/open', ['-g', '-b', bundle], { timeout: 15000 }); },
  listen: startListener,
};

// ---- Setup and cleanup ----

// Brings the app up in the background and returns once its main window exists. restart quits a running instance first, so the
// run starts from the app's default accessibility state; otherwise a running app is used as it is and left running.
async function bringUp(ctx, spec, native, { restart, readyMs = 60000, pause = sleep, now = Date.now } = {}) {
  if (ctx.ownerAway !== true) throw failure(`${spec.app} runs only with --owner-away`, true);
  ctx.signal?.throwIfAborted(); ctx.cleanupSignal?.throwIfAborted();
  const diagnostic = { app: spec.app, bundle: spec.bundle, launched: false, running: false, helperCollectionConfirmed: true,
    cleanup: 'nothing created' };
  (ctx.fixtureDiagnostics ??= []).push(diagnostic);
  const lease = {
    app: spec.app, bundle: spec.bundle, launched: false, running: true, openedAtMs: undefined,
    async close() {},
    async dispose() { return await lease.afterRun?.() !== false; },
    async quit() {
      if (!lease.launched || diagnostic.appQuit) return;
      diagnostic.cleanup = 'unconfirmed';
      await ctx.beforeFixtureCleanup?.(); ctx.cleanupSignal?.throwIfAborted();
      // A setup that stopped before it saw the pid looks once more, so a late start is still quit by its own pid.
      if (!lease.pid) {
        const late = (await native.table(ctx, spec.bundle)).processes.filter(item => item.launchedAt * 1000 >= lease.openedAtMs - 2000);
        if (late.length > 1) throw failure(`${spec.app} launch ambiguous: ${late.length} instances`);
        if (late.length === 1) lease.pid = late[0].pid;
      }
      if (lease.pid && await native.quit(ctx, spec.bundle, lease.pid) !== true) throw failure(`Launched ${spec.app} quit unconfirmed`);
      diagnostic.appQuit = true; diagnostic.cleanup = 'quit launched app';
    },
  };
  (ctx.windowLeases ??= []).push(lease);
  const before = await native.table(ctx, spec.bundle);
  if (before.trusted === false) throw failure('APP_ACCESSIBILITY_UNAVAILABLE', true);
  if (before.processes.length > 1) throw failure(`${spec.app} has ${before.processes.length} instances`, true);
  let existing = before.processes[0];
  if (existing && restart) {
    // The owner's instance is quit here, once, so the run starts fresh. It is not ours to quit again afterwards unless we launch.
    diagnostic.actionTaken = true;
    if (await native.quit(ctx, spec.bundle, existing.pid) !== true) throw failure(`${spec.app} quit before the run unconfirmed`);
    for (const started = now(); (await native.table(ctx, spec.bundle)).processes.length; await pause(250)) {
      if (now() - started > 10000) throw failure(`${spec.app} still running after its quit`);
    }
    existing = undefined;
  }
  if (!existing) {
    lease.launched = true; lease.running = false; diagnostic.launched = true; diagnostic.actionTaken = true; diagnostic.cleanup = 'unconfirmed';
    lease.openedAtMs = now();
    await native.open(spec.bundle);
  }
  for (const started = now(); ; await pause(500)) {
    ctx.signal?.throwIfAborted();
    const { processes } = await native.table(ctx, spec.bundle);
    if (processes.length > 1) throw failure(`${spec.app} launch ambiguous: ${processes.length} instances`);
    if (processes.length === 1 && processes[0].finished !== false) {
      lease.pid = processes[0].pid;
      if (await native.ready(ctx, spec.bundle, lease.pid)) break;
    }
    if (now() - started > readyMs) throw failure(`${spec.app} main window did not appear in ${Math.round(readyMs / 1000)} s`);
  }
  diagnostic.pid = lease.pid;
  if (!lease.launched) diagnostic.cleanup = 'unchanged running app';
  return lease;
}

export async function setupSlack(ctx, { native = appNative, ...options } = {}) {
  ctx.slack = {};
  ctx.slack.lease = await bringUp(ctx, SLACK, native, { restart: true, ...options });
  ctx.slack.native = native;
}

export function promptSlack(ctx) {
  return `In Slack, post the message "bench ${ctx.nonce}" in the channel #${SLACK.channel}, exactly once. Leave #${SLACK.channel} open.`;
}

export async function checkSlack(ctx) {
  // A planning pass calls the check without a setup: nothing to read, and no app to reach.
  const state = ctx.slack;
  if (!state?.lease?.pid) return 'SLACK_NOT_SET_UP';
  try { return judgeSlack(await state.native.slack(ctx, state.lease.pid, ctx.nonce)); }
  catch (error) { return `SLACK_CHECK_UNAVAILABLE${error?.message ? ': ' + String(error.message).slice(0, 80) : ''}`; }
}

export async function setupSpotify(ctx, { native = appNative, ...options } = {}) {
  ctx.spotify = {};
  const lease = ctx.spotify.lease = await bringUp(ctx, SPOTIFY, native, { restart: false, ...options });
  ctx.spotify.native = native;
  // Subscribed before the prompt goes out, so the first Playing event is not lost.
  const listener = ctx.spotify.listener = await native.listen(ctx);
  lease.afterRun = () => listener.stop();
}

export function promptSpotify() {
  return `In Spotify, search for the song "${SPOTIFY.track}" by ${SPOTIFY.artist}, play it, then pause playback. Leave Spotify open.`;
}

export function checkSpotify(ctx) {
  if (!ctx.spotify?.listener) return 'SPOTIFY_NOT_SET_UP';
  return judgeSpotify(ctx.spotify.listener.events());
}

export async function cleanupSpotify(ctx) {
  const errors = [];
  try { if (await ctx.spotify?.listener?.stop() === false) errors.push('Spotify listener collection unconfirmed'); }
  catch (error) { errors.push(error.message); }
  try { await cleanupElectron(ctx); } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(errors.join('; '));
}
