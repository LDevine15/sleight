import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeSlack, judgeSpotify, parseSpotifyLines, setupSlack, promptSlack, checkSlack, setupSpotify, promptSpotify,
  checkSpotify, cleanupSpotify } from '../bench/real-apps.mjs';
import { cleanupElectron } from '../bench/real-electron.mjs';
import { getTasks, REAL_APPS } from '../bench/tasks.mjs';
import { WORLD_APPS } from '../bench/world/tasks.mjs';
import { resolveTask, suite } from '../bench/world/suite.mjs';

// Nothing here reaches Slack or Spotify: the native adapter is a fake, and the real one refuses inside node:test.
function fakeNative({ running = [], launchPid = 900, trusted = true, ready = true, slack = {}, events = [] } = {}) {
  const calls = [];
  let table = running.map(pid => ({ pid, launchedAt: 1, finished: true }));
  const native = {
    calls,
    table: async () => { calls.push('table'); return { processes: table, trusted }; },
    open: async bundle => { calls.push(`open ${bundle}`); table = [{ pid: launchPid, launchedAt: Date.now() / 1000, finished: true }]; },
    ready: async (_ctx, _bundle, pid) => { calls.push(`ready ${pid}`); return ready; },
    quit: async (_ctx, _bundle, pid) => { calls.push(`quit ${pid}`); table = table.filter(item => item.pid !== pid); return true; },
    slack: async (_ctx, pid, nonce) => { calls.push(`slack ${pid} ${nonce}`); return slack; },
    listen: async () => {
      calls.push('listen');
      // The real listener memoizes its stop, which cleanup and the lease's dispose both call.
      let stopped;
      return { events: () => events, stop: () => stopped ??= (async () => { calls.push('stop listener'); return true; })() };
    },
  };
  return native;
}
const options = { pause: async () => {} };
const context = extra => ({ nonce: 'abc123', ownerAway: true, ...extra });

test('Slack judgment: exactly one posted message and an empty composer', () => {
  assert.equal(judgeSlack({ listFound: true, count: 1, composerHolds: false }), true);
  assert.equal(judgeSlack({ listFound: true, count: 0, composerHolds: false }), 'SLACK_POST_COUNT_0');
  assert.equal(judgeSlack({ listFound: true, count: 2, composerHolds: false }), 'SLACK_POST_COUNT_2');
  assert.equal(judgeSlack({ listFound: true, count: 1, composerHolds: true }), 'SLACK_COMPOSER_HOLDS_TEXT');
  assert.equal(judgeSlack({ listFound: false, count: 0, composerHolds: false }), 'SLACK_CHANNEL_LIST_MISSING');
  assert.equal(judgeSlack({ listFound: true, count: 1 }), 'SLACK_COMPOSER_HOLDS_TEXT');
  assert.equal(judgeSlack(undefined), 'SLACK_CHECK_UNAVAILABLE');
});

const event = (state, name = 'Bohemian Rhapsody', artist = 'Queen', id = 'spotify:track:bohemian') =>
  ({ Name: name, Artist: artist, 'Player State': state, 'Track ID': id });

test('Spotify judgment: a Playing event for the song, then a last Paused event for the same track', () => {
  assert.equal(judgeSpotify([event('Playing'), event('Paused')]), true);
  assert.equal(judgeSpotify([event('Playing', 'Bohemian Rhapsody - Remastered 2011', 'Queen', 'spotify:track:remaster'),
    event('Paused', 'Bohemian Rhapsody - Remastered 2011', 'Queen', 'spotify:track:remaster')]), true);
  assert.equal(judgeSpotify([event('Playing', 'bohemian rhapsody', 'queen'), event('Paused', 'bohemian rhapsody', 'queen')]), true);
  // A track that starts, pauses, resumes and pauses again still ends paused on the same track.
  assert.equal(judgeSpotify([event('Playing'), event('Paused'), event('Playing'), event('Paused')]), true);
  assert.equal(judgeSpotify([event('Playing')]), 'SPOTIFY_NOT_PAUSED_AT_END');
  assert.equal(judgeSpotify([event('Playing'), event('Paused'), event('Playing')]), 'SPOTIFY_NOT_PAUSED_AT_END');
  assert.equal(judgeSpotify([event('Playing'), event('Stopped')]), 'SPOTIFY_NOT_PAUSED_AT_END');
  assert.equal(judgeSpotify([event('Playing', 'Another One Bites the Dust', 'Queen', 'spotify:track:other'),
    event('Paused', 'Another One Bites the Dust', 'Queen', 'spotify:track:other')]), 'SPOTIFY_NO_MATCHING_PLAY');
  assert.equal(judgeSpotify([event('Playing', 'Bohemian Rhapsody', 'Panic! At The Disco', 'spotify:track:cover'),
    event('Paused', 'Bohemian Rhapsody', 'Panic! At The Disco', 'spotify:track:cover')]), 'SPOTIFY_NO_MATCHING_PLAY');
  assert.equal(judgeSpotify([event('Playing'), event('Paused', 'Another One Bites the Dust', 'Queen', 'spotify:track:other')]),
    'SPOTIFY_PAUSED_OTHER_TRACK');
  assert.equal(judgeSpotify([event('Paused'), event('Playing', 'Another One Bites the Dust', 'Queen', 'spotify:track:other'),
    event('Paused', 'Another One Bites the Dust', 'Queen', 'spotify:track:other')]), 'SPOTIFY_NO_MATCHING_PLAY');
  assert.equal(judgeSpotify([]), 'SPOTIFY_NO_EVENTS');
  assert.equal(judgeSpotify(undefined), 'SPOTIFY_NO_EVENTS');
});

test('the Spotify listener output parses to four keys per event and a ready marker', () => {
  const text = '{"ready":true}\n' + JSON.stringify({ ...event('Playing'), Extra: 'dropped' }) + '\nnot json\n' + JSON.stringify(event('Paused')) + '\n';
  const { ready, events } = parseSpotifyLines(text);
  assert.equal(ready, true);
  assert.deepEqual(events.map(item => Object.keys(item).sort()), [['Artist', 'Name', 'Player State', 'Track ID'], ['Artist', 'Name', 'Player State', 'Track ID']]);
  assert.equal(parseSpotifyLines('').ready, false);
});

test('Slack setup quits a running Slack by pid, launches it fresh and quits only that launch', async () => {
  const native = fakeNative({ running: [500], launchPid: 900 });
  const ctx = context();
  await setupSlack(ctx, { native, ...options });
  assert.deepEqual(native.calls.filter(call => /^(quit|open|ready)/.test(call)), ['quit 500', 'open com.tinyspeck.slackmacgap', 'ready 900']);
  assert.equal(ctx.windowLeases[0].launched, true);
  assert.equal(ctx.windowLeases[0].running, false);
  native.calls.length = 0;
  await cleanupElectron(ctx);
  assert.deepEqual(native.calls.filter(call => call.startsWith('quit')), ['quit 900']);
  assert.equal(ctx.fixtureDiagnostics[0].appQuit, true);
  assert.equal(ctx.fixtureDiagnostics[0].cleanup, 'quit launched app');
  await cleanupElectron(ctx);
  assert.equal(native.calls.filter(call => call.startsWith('quit')).length, 1);
});

test('Slack setup without a running Slack launches it in the background and waits for its window', async () => {
  let readyCalls = 0;
  const native = fakeNative();
  native.ready = async () => ++readyCalls >= 3;
  const ctx = context();
  await setupSlack(ctx, { native, ...options });
  assert.equal(readyCalls, 3);
  assert.deepEqual(native.calls.filter(call => /^(quit|open)/.test(call)), ['open com.tinyspeck.slackmacgap']);
  assert.equal(ctx.windowLeases[0].pid, 900);
});

test('Slack setup stops when the window never appears, and cleanup still quits the launch', async () => {
  const native = fakeNative({ ready: false });
  const ctx = context();
  let clock = 0;
  await assert.rejects(setupSlack(ctx, { native, pause: async () => { clock += 20000; }, now: () => clock, readyMs: 30000 }),
    /main window did not appear/);
  native.calls.length = 0;
  await cleanupElectron(ctx);
  assert.deepEqual(native.calls.filter(call => call.startsWith('quit')), ['quit 900']);
});

test('setup refuses without --owner-away or accessibility, before any app action', async () => {
  const native = fakeNative({ running: [500] });
  await assert.rejects(setupSlack(context({ ownerAway: false }), { native, ...options }), error => error.noMutation === true && /owner-away/.test(error.message));
  await assert.rejects(setupSpotify(context({ ownerAway: undefined }), { native, ...options }), /owner-away/);
  assert.deepEqual(native.calls, []);
  const untrusted = fakeNative({ running: [500], trusted: false });
  await assert.rejects(setupSlack(context(), { native: untrusted, ...options }), /ACCESSIBILITY/);
  assert.deepEqual(untrusted.calls, ['table']);
});

test('two Slack processes are ambiguous and nothing is quit', async () => {
  const native = fakeNative({ running: [500, 501] });
  await assert.rejects(setupSlack(context(), { native, ...options }), /2 instances/);
  assert.equal(native.calls.some(call => /^(quit|open)/.test(call)), false);
});

test('the real adapter refuses to run inside node:test', async () => {
  await assert.rejects(setupSlack(context(), options), /APP_NATIVE_UNAVAILABLE_IN_TESTS/);
  await assert.rejects(setupSpotify(context(), options), /APP_NATIVE_UNAVAILABLE_IN_TESTS/);
});

test('Slack check reads the pid of this run and grades the counts', async () => {
  const native = fakeNative({ slack: { listFound: true, count: 1, composerHolds: false } });
  const ctx = context();
  assert.equal(await checkSlack(ctx), 'SLACK_NOT_SET_UP');
  assert.deepEqual(native.calls, []);
  await setupSlack(ctx, { native, ...options });
  assert.equal(await checkSlack(ctx), true);
  assert.ok(native.calls.includes('slack 900 abc123'));
  for (const [counts, expected] of [[{ listFound: true, count: 0, composerHolds: false }, 'SLACK_POST_COUNT_0'],
    [{ listFound: true, count: 2, composerHolds: false }, 'SLACK_POST_COUNT_2'],
    [{ listFound: true, count: 1, composerHolds: true }, 'SLACK_COMPOSER_HOLDS_TEXT']]) {
    native.slack = async () => counts;
    assert.equal(await checkSlack(ctx), expected);
  }
  native.slack = async () => { throw new Error('APP_AX_UNAVAILABLE'); };
  assert.match(await checkSlack(ctx), /^SLACK_CHECK_UNAVAILABLE/);
});

test('the Slack and Spotify prompts are tool-neutral and carry the run nonce', () => {
  assert.equal(promptSlack({ nonce: 'abc123' }),
    'In Slack, post the message "bench abc123" in the channel #new-channel, exactly once. Leave #new-channel open.');
  assert.equal(promptSpotify(),
    'In Spotify, search for the song "Bohemian Rhapsody" by Queen, play it, then pause playback. Leave Spotify open.');
});

test('Spotify setup starts the listener after the window exists, and quits Spotify only when it launched it', async () => {
  const running = fakeNative({ running: [700], events: [event('Playing'), event('Paused')] });
  const first = context();
  assert.equal(checkSpotify(first), 'SPOTIFY_NOT_SET_UP');
  await setupSpotify(first, { native: running, ...options });
  assert.deepEqual(running.calls.filter(call => /^(quit|open|ready|listen)/.test(call)), ['ready 700', 'listen']);
  assert.equal(first.windowLeases[0].launched, false);
  assert.equal(checkSpotify(first), true);
  await cleanupSpotify(first);
  assert.deepEqual(running.calls.filter(call => /^(quit|stop)/.test(call)), ['stop listener']);

  const cold = fakeNative({ events: [event('Playing')] });
  const second = context();
  await setupSpotify(second, { native: cold, ...options });
  assert.deepEqual(cold.calls.filter(call => /^(quit|open|ready|listen)/.test(call)), ['open com.spotify.client', 'ready 900', 'listen']);
  assert.equal(checkSpotify(second), 'SPOTIFY_NOT_PAUSED_AT_END');
  await cleanupSpotify(second);
  assert.deepEqual(cold.calls.filter(call => /^(quit|stop)/.test(call)), ['stop listener', 'quit 900']);
  assert.equal(second.fixtureDiagnostics[0].appQuit, true);
});

test('a listener that is not collected fails Spotify cleanup', async () => {
  const native = fakeNative({ running: [700] });
  native.listen = async () => ({ events: () => [], stop: async () => false });
  const ctx = context();
  await setupSpotify(ctx, { native, ...options });
  await assert.rejects(cleanupSpotify(ctx), /listener collection unconfirmed/);
});

test('the claim catalog lists VS Code, Slack and Spotify for every native arm, runnable by --suite world', async () => {
  for (const id of ['vscode-edit', 'slack-post', 'spotify-play']) {
    const row = suite.native.find(item => item.id === `native/${id}`);
    assert.ok(row, id);
    assert.equal(row.claim, true);
    assert.equal(row.source, 'real');
    assert.equal(row.timeoutMs, 300000);
    assert.ok(row.requires.includes('owner-away run boundary'));
    assert.ok(!row.requires.some(item => /owner present/.test(item)));
    for (const arm of ['sleight', 'codex', 'cua', 'peekaboo', 'claude-cu']) assert.equal(row.support[arm], true, `${id} ${arm}`);
    assert.equal((await resolveTask(row.id)).id, id);
    const world = getTasks('world').find(task => task.id === id);
    assert.ok(world && world.fixtureLifecycle === true && world.half === 'native' && world.timeoutMs === 300000);
    assert.ok(world.allowedApps.includes(world.app) && world.allowedApps.includes(world.bundle), id);
    assert.ok(world.allowedApps.every(name => WORLD_APPS.includes(name)), id);
    assert.ok(world.allowedApps.every(name => !/^(com\.|net\.)/.test(name) || REAL_APPS.includes(name)), id);
    assert.notEqual(world.ownerPresent, true);
  }
  assert.ok(REAL_APPS.includes('Spotify') && REAL_APPS.includes('com.spotify.client'));
  assert.equal((await resolveTask('native/slack-post')).check, checkSlack);
  const chat = getTasks('real').find(task => task.id === 'slack-read');
  assert.equal(chat.ownerPresent, true);
});

test('the planning check of the new tasks reaches no app', async () => {
  for (const id of ['slack-post', 'spotify-play']) {
    const task = getTasks('world').find(item => item.id === id);
    const ctx = context();
    await task.prepare(ctx);
    assert.doesNotMatch(task.prompt(ctx), /in the background|sleight\.|mcp__/);
    assert.match(await task.check({ ...ctx, answer: '' }), /NOT_SET_UP/);
  }
});
