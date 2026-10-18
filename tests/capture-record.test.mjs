import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { checkSizes, checkSync, parsePlan, record, recorderPlan, resolveWindows, scrubSync } from '../bench/capture/record.mjs';

const HOME = '/Users/ownername';
const windowList = [
  { id: 11, pid: 100, owner: 'TextEdit', title: 'notes.txt', layer: 0, bounds: { x: 0, y: 25, width: 1440, height: 900 } },
  { id: 12, pid: 100, owner: 'TextEdit', title: 'other.txt', layer: 0, bounds: { x: 40, y: 60, width: 800, height: 600 } },
  { id: 13, pid: 100, owner: 'TextEdit', title: 'twin', layer: 0, bounds: { x: 0, y: 0, width: 10, height: 10 } },
  { id: 14, pid: 100, owner: 'TextEdit', title: 'twin', layer: 0, bounds: { x: 0, y: 0, width: 10, height: 10 } },
  { id: 21, pid: 200, owner: 'Hand', title: '', layer: 3, bounds: { x: 1000, y: 500, width: 300, height: 300 } },
];
const basePlan = (extra = {}) => ({
  out: '~/Movies/take-1',
  windows: [
    { name: 'editor', pid: 100, title: 'notes.txt', expect: { width: 1440, height: 900, scale: 2 } },
    { name: 'hand', id: 21 },
  ],
  composites: [{ name: 'hand-over-editor', windows: ['editor', 'hand'] }],
  ...extra,
});

test('parsePlan fills the defaults and expands ~ in out', () => {
  const { plan, errors } = parsePlan(basePlan(), { home: HOME });
  assert.deepEqual(errors, []);
  assert.equal(plan.out, '/Users/ownername/Movies/take-1');
  assert.equal(plan.fps, 60);
  assert.equal(plan.duration, undefined);
  assert.equal(plan.codec, 'prores422hq');
  assert.equal(plan.windows.length, 2);
  assert.deepEqual(plan.composites, [{ name: 'hand-over-editor', windows: ['editor', 'hand'] }]);
});

test('parsePlan refuses a plan that names no window', () => {
  for (const raw of [{ out: '/tmp/x' }, { out: '/tmp/x', windows: [] }, { out: '/tmp/x', windows: [], composites: [] }]) {
    const { errors } = parsePlan(raw, { home: HOME });
    assert.ok(errors.some(error => /names no window/.test(error)), errors.join('; '));
  }
});

test('parsePlan rejects bad fields with one message each', () => {
  const cases = [
    [{ out: 'relative/dir' }, /out must be an absolute path/],
    [{ out: undefined }, /out must be an absolute path/],
    [{ fps: 0 }, /fps must be a whole number from 1 to 120/],
    [{ fps: 59.94 }, /fps must be a whole number from 1 to 120/],
    [{ duration: -1 }, /duration must be a positive number of seconds/],
    [{ codec: 'h264' }, /codec must be one of prores422hq, hevc/],
    [{ windows: [{ name: 'a', id: 1, pid: 2, title: 'x' }] }, /a: give either id or pid and title/],
    [{ windows: [{ name: 'a', pid: 2 }] }, /a: give either id or pid and title/],
    [{ windows: [{ name: 'a', pid: 2, title: '' }] }, /a: give either id or pid and title/],
    [{ windows: [{ name: 'a b', id: 1 }] }, /window name "a b"/],
    [{ windows: [{ name: 'a', id: 1 }, { name: 'a', id: 2 }] }, /name "a" is used twice/],
    [{ windows: [{ name: 'a', id: 1, expect: { width: 0, height: 900 } }] }, /a: expect needs positive width and height/],
    [{ composites: [{ name: 'c', windows: ['editor'] }] }, /c: a composite needs at least two windows/],
    [{ composites: [{ name: 'c', windows: ['editor', 'nope'] }] }, /c: no window named "nope"/],
    [{ composites: [{ name: 'editor', windows: ['editor', 'hand'] }] }, /name "editor" is used twice/],
  ];
  for (const [extra, pattern] of cases) {
    const { errors } = parsePlan(basePlan(extra), { home: HOME });
    assert.ok(errors.some(error => pattern.test(error)), `${JSON.stringify(extra)}: ${errors.join('; ')}`);
  }
});

test('resolveWindows matches by id or by pid and exact title, and names misses and twins', () => {
  const { plan } = parsePlan(basePlan(), { home: HOME });
  const { windows, errors } = resolveWindows(plan, windowList);
  assert.deepEqual(errors, []);
  assert.deepEqual(windows.map(window => [window.name, window.id]), [['editor', 11], ['hand', 21]]);

  const misses = parsePlan(basePlan({ windows: [
    { name: 'gone', id: 99 }, { name: 'case', pid: 100, title: 'Notes.txt' }, { name: 'twin', pid: 100, title: 'twin' },
    { name: 'wrong-pid', pid: 101, title: 'notes.txt' },
  ], composites: [] }), { home: HOME }).plan;
  const result = resolveWindows(misses, windowList);
  assert.equal(result.errors.length, 4);
  assert.match(result.errors[0], /gone: no on-screen window has id 99/);
  assert.match(result.errors[1], /case: no on-screen window of pid 100 is titled "Notes.txt"/);
  assert.match(result.errors[2], /twin: 2 windows of pid 100 are titled "twin" \(13, 14\); use an id/);
  assert.match(result.errors[3], /wrong-pid: no on-screen window of pid 101/);
});

test('resolveWindows says titles need Screen Recording when the list has none', () => {
  const { plan } = parsePlan(basePlan({ windows: [{ name: 'editor', pid: 100, title: 'notes.txt' }], composites: [] }), { home: HOME });
  const untitled = windowList.map(window => ({ ...window, title: '' }));
  const { errors } = resolveWindows(plan, untitled);
  assert.match(errors[0], /Screen Recording/);
});

test('checkSizes compares the window frame in points with expect', () => {
  const { plan } = parsePlan(basePlan(), { home: HOME });
  const { windows } = resolveWindows(plan, windowList);
  assert.deepEqual(checkSizes(plan, windows), []);
  const small = windows.map(window => window.name === 'editor' ? { ...window, bounds: { ...window.bounds, width: 1280 } } : window);
  assert.match(checkSizes(plan, small)[0], /editor: window is 1280 × 900 pt, plan expects 1440 × 900 pt/);
});

test('recorderPlan gives every window a stream and each composite one more', () => {
  const { plan } = parsePlan(basePlan({ duration: 12, fps: 30 }), { home: HOME });
  const { windows } = resolveWindows(plan, windowList);
  assert.deepEqual(recorderPlan(plan, windows, 'hevc'), {
    version: 1, out: '/Users/ownername/Movies/take-1', fps: 30, duration: 12, codec: 'hevc',
    streams: [
      { name: 'editor', windows: [11], composite: false },
      { name: 'hand', windows: [21], composite: false },
      { name: 'hand-over-editor', windows: [11, 21], composite: true },
    ],
  });
});

function goodSync(plan) {
  return {
    version: 1, codec: plan.codec, fps: plan.fps, stoppedBy: 'signal', hostClock: 'CMClockGetHostTimeClock',
    streams: plan.streams.map((stream, index) => ({
      name: stream.name, file: `${stream.name}.mov`, composite: stream.composite,
      windows: stream.windows.map(id => ({ id, pid: 100, app: 'TextEdit', title: `${HOME}/notes.txt` })),
      firstFrameHostTime: 1000.5 + index / 100, wallClockStart: '2026-10-18T22:00:00.000Z', frames: 120, droppedFrames: 0,
      idleFrames: 3, sizePt: { width: 1440, height: 900 }, sizePx: { width: 2880, height: 1800 }, scale: 2,
    })),
  };
}

test('checkSync accepts a well-formed sync.json and the expected scale', () => {
  const { plan: parsed } = parsePlan(basePlan(), { home: HOME });
  const resolved = resolveWindows(parsed, windowList).windows;
  const plan = recorderPlan(parsed, resolved, 'prores422hq');
  assert.deepEqual(checkSync(goodSync(plan), plan, parsed), []);
});

test('checkSync names each schema problem', () => {
  const { plan: parsed } = parsePlan(basePlan(), { home: HOME });
  const plan = recorderPlan(parsed, resolveWindows(parsed, windowList).windows, 'prores422hq');
  const broken = goodSync(plan);
  broken.streams[0].frames = 0;
  broken.streams[0].sizePx = { width: 1440, height: 900 };
  delete broken.streams[1].firstFrameHostTime;
  broken.streams[2].wallClockStart = 'yesterday';
  broken.streams[2].windows = broken.streams[2].windows.slice(0, 1);
  const errors = checkSync(broken, plan, parsed);
  assert.ok(errors.some(error => /editor: recorded no frames/.test(error)), errors.join('; '));
  assert.ok(errors.some(error => /editor: 1440 × 900 px is not 1440 × 900 pt at 2x/.test(error)), errors.join('; '));
  assert.ok(errors.some(error => /hand: firstFrameHostTime must be a number/.test(error)), errors.join('; '));
  assert.ok(errors.some(error => /hand-over-editor: wallClockStart must be an ISO time/.test(error)), errors.join('; '));
  assert.ok(errors.some(error => /hand-over-editor: windows are 11, plan has 11, 21/.test(error)), errors.join('; '));

  const missing = goodSync(plan);
  missing.streams.pop();
  missing.version = 2;
  const more = checkSync(missing, plan, parsed);
  assert.ok(more.some(error => /version must be 1/.test(error)), more.join('; '));
  assert.ok(more.some(error => /hand-over-editor: missing from sync.json/.test(error)), more.join('; '));

  const scaled = goodSync(plan);
  scaled.streams[0].scale = 1;
  scaled.streams[0].sizePx = { width: 1440, height: 900 };
  assert.ok(checkSync(scaled, plan, parsed).some(error => /editor: recorded at 1x, plan expects 2x/.test(error)));
});

test('scrubSync shows home as ~ and hides the user name', () => {
  const sync = { streams: [{ windows: [{ title: '/Users/ownername/Documents/ownername notes.txt' }, { title: '/Users/someone/x' }] }] };
  const scrubbed = scrubSync(sync, { home: HOME, user: 'ownername' });
  assert.deepEqual(scrubbed.streams[0].windows.map(window => window.title), ['~/Documents/<user> notes.txt', '~/x']);
});

function fakes(t, { list = windowList, codecs = { prores422hq: true, hevc: true }, sync } = {}) {
  const calls = { run: [], list: 0 };
  return {
    calls,
    options: {
      home: HOME, user: 'ownername', hold: join(mkdtempSync(join(tmpdir(), 'sleight-capture-hold-')), 'absent'),
      buildRecorder: async () => '/fake/recorder',
      listWindows: async binary => { calls.list += 1; assert.equal(binary, '/fake/recorder'); return list; },
      codecs: async () => codecs,
      runRecorder: async (binary, planPath) => {
        const plan = JSON.parse(readFileSync(planPath, 'utf8'));
        calls.run.push(plan);
        const written = sync ? sync(plan) : goodSync(plan);
        for (const stream of written.streams) writeFileSync(join(plan.out, stream.file), '');
        writeFileSync(join(plan.out, 'sync.json'), JSON.stringify(written));
        return { code: 0 };
      },
    },
  };
}

test('record --dry-run lists the matching windows and never starts the recorder', async t => {
  const out = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-')));
  const { calls, options } = fakes(t);
  const result = await record(basePlan({ out }), { ...options, dryRun: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.windows.map(window => [window.name, window.id, window.owner]), [['editor', 11, 'TextEdit'], ['hand', 21, 'Hand']]);
  assert.deepEqual(result.streams.map(stream => stream.name), ['editor', 'hand', 'hand-over-editor']);
  assert.equal(calls.list, 1);
  assert.equal(calls.run.length, 0);
  assert.equal(existsSync(join(out, 'recorder-plan.json')), false);
});

test('record refuses before listing windows when the plan is bad', async t => {
  const { calls, options } = fakes(t);
  const result = await record({ out: '/tmp/x', windows: [] }, options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /names no window/);
  assert.equal(calls.list, 0);
});

test('record refuses a window of the wrong size before recording', async t => {
  const out = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-')));
  const list = windowList.map(window => window.id === 11 ? { ...window, bounds: { ...window.bounds, height: 875 } } : window);
  const { calls, options } = fakes(t, { list });
  const result = await record(basePlan({ out }), options);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /1440 × 875 pt/);
  assert.equal(calls.run.length, 0);
});

test('record runs the recorder, checks sync.json and scrubs it in place', async t => {
  const out = join(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-'))), 'take');
  const { calls, options } = fakes(t);
  const result = await record(basePlan({ out, duration: 5 }), options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0].codec, 'prores422hq');
  assert.equal(calls.run[0].duration, 5);
  const sync = JSON.parse(readFileSync(join(out, 'sync.json'), 'utf8'));
  assert.equal(sync.streams[0].windows[0].title, '~/notes.txt');
  assert.equal(JSON.stringify(sync).includes('ownername'), false);
});

test('record falls back to HEVC when ProRes is unavailable, and refuses when neither is', async t => {
  const out = join(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-'))), 'take');
  const fallback = fakes(t, { codecs: { prores422hq: false, hevc: true } });
  const result = await record(basePlan({ out }), fallback.options);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fallback.calls.run[0].codec, 'hevc');
  assert.match(result.notes.join('; '), /ProRes 422 HQ is not available; recording HEVC/);

  const none = fakes(t, { codecs: { prores422hq: false, hevc: false } });
  const refused = await record(basePlan({ out: `${out}-2` }), none.options);
  assert.equal(refused.ok, false);
  assert.match(refused.errors[0], /no encoder/);
  assert.equal(none.calls.run.length, 0);
});

test('record never overwrites an earlier take', async t => {
  const out = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-')));
  writeFileSync(join(out, 'sync.json'), '{}');
  const { calls, options } = fakes(t);
  const result = await record(basePlan({ out }), options);
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /already holds a take/);
  assert.equal(calls.run.length, 0);
});

test('record refuses while the hold file exists', async t => {
  const out = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-')));
  const hold = join(out, 'hold');
  mkdirSync(hold);
  const { calls, options } = fakes(t);
  const result = await record(basePlan({ out: join(out, 'take') }), { ...options, hold });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /hold/);
  assert.equal(calls.run.length, 0);
});

test('record reports a recorder failure and a broken sync.json', async t => {
  const out = join(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-capture-'))), 'take');
  const failing = fakes(t);
  failing.options.runRecorder = async () => ({ code: 2, error: 'screen-recording-not-granted' });
  const failed = await record(basePlan({ out }), failing.options);
  assert.equal(failed.ok, false);
  assert.match(failed.errors[0], /recorder exited 2: screen-recording-not-granted/);

  const broken = fakes(t, { sync: plan => ({ ...goodSync(plan), streams: goodSync(plan).streams.map(stream => ({ ...stream, frames: 0 })) }) });
  const result = await record(basePlan({ out: `${out}-2` }), broken.options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /recorded no frames/);
});
