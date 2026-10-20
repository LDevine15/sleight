// Offline compositor. The JSON plan and its receipts stay private; only the GIF is published locally.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, lstatSync, realpathSync, mkdtempSync, rmSync, linkSync, statSync } from 'node:fs';
import { dirname, join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const MAX_BYTES = 5_000_000;
const FPS = 10;
const PROFILES = [{ width: 640, colors: 128 }, { width: 480, colors: 96 }, { width: 320, colors: 64 }];
const number = n => typeof n === 'number' && Number.isFinite(n);
const text = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 500;
const need = (condition, message) => { if (!condition) throw Error(message); };
const clean = n => Number(n.toFixed(6));

function rectangle(rect, width, height, name) {
  need(rect && ['x', 'y', 'width', 'height'].every(k => Number.isSafeInteger(rect[k])), `${name}: integer rectangle required`);
  need(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
    rect.x + rect.width <= width && rect.y + rect.height <= height, `${name}: rectangle outside image`);
}

export function validatePlan(value, metadata) {
  need(value?.version === 1 && text(value.task) && text(value.taskSource), 'version 1, task and taskSource required');
  need(Array.isArray(value.recordings) && value.recordings.length === 2, 'exactly two recordings required');
  need(text(value.approval?.reference) && Array.isArray(value.approval.arms) && value.approval.arms.length === 2,
    'explicit approved pair and reference required');
  need(number(value.endHoldSeconds) && value.endHoldSeconds >= 1 && value.endHoldSeconds <= 5, 'endHoldSeconds must be 1 to 5');
  need(Array.isArray(metadata) && metadata.length === 2, 'two probed recordings required');
  const recordings = value.recordings.map((r, i) => {
    need(text(r.arm) && value.approval.arms[i] === r.arm && r.task === value.task, 'recording must match task and approved pair order');
    need(r.singleWindow === true && text(r.recordingReference) && text(r.model), 'single window, recording reference and model required');
    need(typeof r.label === 'string' && /^[A-Za-z0-9 .-]{1,24}$/.test(r.label) && r.label.trim(), 'label must be 1 to 24 public letters, digits, spaces, periods or hyphens');
    need(text(r.file), 'recording file required');
    const m = metadata[i];
    need(m && [m.width, m.height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 8192) &&
      number(m.duration) && m.duration > 0 && m.startTime === 0, 'invalid video dimensions, duration or nonzero start timestamp');
    const timing = r.timing;
    need(timing && number(timing.startSeconds) && number(timing.finishSeconds) && text(timing.evidence), 'explicit timings and evidence required');
    const elapsed = clean(timing.finishSeconds - timing.startSeconds);
    need(timing.startSeconds >= 0 && elapsed >= 0.1 && elapsed <= 180 && timing.finishSeconds <= m.duration,
      'timing must cover 0.1 to 180 seconds within the recording');
    const redaction = r.redaction;
    need(redaction?.verified === true && text(redaction.reviewReference) && Array.isArray(redaction.masks) && redaction.masks.length <= 64,
      'verified redaction review, crop and masks array required');
    rectangle(redaction.crop, m.width, m.height, 'crop');
    const crop = redaction.crop;
    need(crop.width >= 16 && crop.height >= 16 && crop.height / crop.width <= 3, 'crop too small or too tall');
    redaction.masks.forEach(mask => rectangle(mask, crop.width, crop.height, 'mask in cropped coordinates'));
    return { ...r, elapsed };
  });
  need(recordings[0].arm !== recordings[1].arm, 'two distinct arms required');
  const duration = Math.ceil(clean(Math.max(...recordings.map(r => r.elapsed)) + value.endHoldSeconds) * FPS) / FPS;
  return { ...value, recordings, duration };
}

export function clockAt(recording, time) {
  need(number(time) && time >= 0, 'clock time must be nonnegative');
  const done = time >= recording.elapsed;
  const seconds = clean(Math.min(time, recording.elapsed));
  return { seconds, done, text: done ? `DONE ${seconds.toFixed(1)} S - HELD` : `${seconds.toFixed(1)} S` };
}

// Five columns per glyph, low bit at the top. PBM headers need no font download or drawtext build.
const GLYPHS = {
  ' ': [0,0,0,0,0], '.': [0,96,96,0,0], '-': [8,8,8,8,8],
  '0': [62,81,73,69,62], '1': [0,66,127,64,0], '2': [66,97,81,73,70], '3': [33,65,69,75,49],
  '4': [24,20,18,127,16], '5': [39,69,69,69,57], '6': [60,74,73,73,48], '7': [1,113,9,5,3],
  '8': [54,73,73,73,54], '9': [6,73,73,41,30],
  A:[126,17,17,17,126], B:[127,73,73,73,54], C:[62,65,65,65,34], D:[127,65,65,34,28],
  E:[127,73,73,73,65], F:[127,9,9,9,1], G:[62,65,73,73,122], H:[127,8,8,8,127],
  I:[0,65,127,65,0], J:[32,64,65,63,1], K:[127,8,20,34,65], L:[127,64,64,64,64],
  M:[127,2,12,2,127], N:[127,4,8,16,127], O:[62,65,65,65,62], P:[127,9,9,9,6],
  Q:[62,65,81,33,94], R:[127,9,25,41,70], S:[70,73,73,73,49], T:[1,1,127,1,1],
  U:[63,64,64,64,63], V:[31,32,64,32,31], W:[63,64,56,64,63], X:[99,20,8,20,99],
  Y:[7,8,112,8,7], Z:[97,81,73,69,67],
};

export function makeHeader(plan, panelWidth, time) {
  const width = panelWidth * 2, stride = width / 8;
  const pixels = Buffer.alloc(stride * 64);
  const draw = (s, x, y) => {
    for (const letter of s.toUpperCase()) {
      const columns = GLYPHS[letter];
      need(columns, 'unsupported header glyph');
      columns.forEach((bits, col) => {
        for (let row = 0; row < 7; row++) if (bits & (1 << row)) {
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const px = x + col * 2 + dx, py = y + row * 2 + dy;
            pixels[py * stride + (px >> 3)] |= 0x80 >> (px % 8);
          }
        }
      });
      x += 12;
    }
  };
  plan.recordings.forEach((r, i) => { draw(r.label, i * panelWidth + 8, 8); draw(clockAt(r, time).text, i * panelWidth + 8, 34); });
  return Buffer.concat([Buffer.from(`P4\n${width} 64\n`), pixels]);
}

function regular(path) {
  let st;
  try { st = lstatSync(path); } catch { throw Error('missing regular file'); }
  need(st.isFile() && !st.isSymbolicLink(), 'input must be a regular file, never a symlink');
  return st;
}

function absent(path) {
  try { lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw Error('output exists, choose a new filename');
}

async function runProcess(command, args, options = {}) {
  return execute(command, args, { maxBuffer: 2 * 1024 * 1024, ...options });
}

async function probe(file, run) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', file]);
  const value = JSON.parse(stdout);
  const videos = value.streams?.filter(s => s.codec_type === 'video');
  need(videos?.length === 1, 'one video stream required');
  const v = videos[0];
  need(!(v.side_data_list ?? []).some(s => Number(s.rotation ?? 0) !== 0) && Number(v.tags?.rotate ?? 0) === 0,
    'rotated recording requires a separately reviewed pixel plan');
  return { width: v.width, height: v.height, duration: Number(v.duration ?? value.format?.duration),
    startTime: Number(v.start_time ?? value.format?.start_time ?? 0) };
}

function filter(plan, profile) {
  const { width, colors } = profile;
  const height = Math.ceil(Math.max(...plan.recordings.map(r => r.redaction.crop.height / r.redaction.crop.width)) * width / 2) * 2;
  const chains = plan.recordings.map((r, i) => {
    const c = r.redaction.crop;
    const masks = r.redaction.masks.map(m => `drawbox=x=${m.x}:y=${m.y}:w=${m.width}:h=${m.height}:color=black:t=fill`);
    // Preserve native frames through the inclusive measured finish before resampling. The clone therefore
    // uses the last frame at or before completion, even between output ticks. Retain the pre-start frame
    // covering time zero, subtract the measured start, and round output ticks up so no future frame appears early.
    return `[${i}:v]trim=end=${r.timing.finishSeconds + 1},settb=AVTB,select='lte(pts,${Math.floor(r.timing.finishSeconds * 1_000_000)})',` +
      [`crop=${c.width}:${c.height}:${c.x}:${c.y}:exact=1`, ...masks,
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`, 'setsar=1',
        `tpad=stop_mode=clone:stop_duration=${plan.duration}`, 'settb=AVTB', `setpts=PTS-${r.timing.startSeconds}/TB`,
        `fps=fps=${FPS}:start_time=0:round=up`, `trim=duration=${plan.duration}`].join(',') + `[v${i}]`;
  });
  return [...chains, '[v0][v1]hstack=inputs=2[windows]',
    '[2:v][windows]vstack=inputs=2:shortest=1,split[a][b]',
    `[a]palettegen=max_colors=${colors}:reserve_transparent=0[p]`,
    '[b][p]paletteuse=dither=bayer:bayer_scale=5[out]'].join(';');
}

export async function buildComparison(planFile, outputFile, { run = runProcess } = {}) {
  const source = resolve(planFile), output = resolve(outputFile);
  need(extname(output).toLowerCase() === '.gif', 'output must end in .gif');
  absent(output);
  regular(source);
  need(statSync(source).size <= 128 * 1024, 'plan exceeds 128 KiB');
  const value = JSON.parse(readFileSync(source, 'utf8'));
  need(Array.isArray(value?.recordings) && value.recordings.length === 2, 'exactly two recordings required');
  const inputs = value.recordings.map(r => {
    need(text(r.file) && /\.(mov|mp4|m4v|mkv|webm|avi)$/i.test(r.file), 'local recorded video file required');
    const path = resolve(dirname(source), r.file), st = regular(path);
    return { path: realpathSync(path), identity: `${st.dev}:${st.ino}` };
  });
  need(inputs[0].identity !== inputs[1].identity, 'two distinct recordings required');
  const plan = validatePlan(value, await Promise.all(inputs.map(f => probe(f.path, run))));
  const parent = realpathSync(dirname(output));
  const work = mkdtempSync(join(parent, '.comparison-gif-'));
  try {
    for (const profile of PROFILES) {
      const frames = Math.round(plan.duration * FPS);
      for (let frame = 0; frame < frames; frame++) writeFileSync(join(work, `header-${String(frame).padStart(5, '0')}.pbm`),
        makeHeader(plan, profile.width, frame / FPS));
      const candidate = join(work, 'candidate.gif');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_complex_threads', '1',
        ...inputs.flatMap(f => ['-protocol_whitelist', 'file', '-noautorotate', '-i', f.path]),
        '-framerate', String(FPS), '-i', join(work, 'header-%05d.pbm'),
        '-filter_complex', filter(plan, profile), '-map', '[out]', '-an', '-sn', '-dn',
        '-map_metadata', '-1', '-map_chapters', '-1', '-t', String(plan.duration), '-loop', '0', candidate]);
      const bytes = statSync(candidate).size;
      need(bytes > 0, 'empty encoded GIF');
      if (bytes < MAX_BYTES) {
        // Hard-link publication fails atomically if a file appeared after the first check.
        linkSync(candidate, join(parent, output.slice(output.lastIndexOf('/') + 1)));
        return { bytes, duration: plan.duration, fps: FPS, panelWidth: profile.width, colors: profile.colors,
          attempts: PROFILES.indexOf(profile) + 1, requiresHumanPreview: true };
      }
    }
    throw Error('3 attempts exhausted: GIF must be strictly below 5,000,000 bytes; no output published');
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    need(process.argv.length === 4, 'usage: node scripts/build-comparison-gif.mjs PLAN.json OUTPUT.gif');
    console.log(JSON.stringify(await buildComparison(process.argv[2], process.argv[3])));
  } catch (error) { console.error(`comparison-gif: ${error.message}`); process.exitCode = 1; }
}
