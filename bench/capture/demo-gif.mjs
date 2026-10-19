// Cuts the README demo from a cap1 take (bench/capture/record.mjs): one GIF and one mp4, composed from the take's
// per-window streams on the shared host clock, with title bars cropped and the layout's scrub boxes filled.
//
//   node bench/capture/demo-gif.mjs <take-folder> [--layout layout.json] [--start s] [--duration s] [--out dir] [--install]
//
// The take folder holds sync.json and one <name>.mov per stream. --start is seconds after the moment every tile's stream
// has its first frame, and --duration is 8 to 12 s (default 10). The GIF is 900 px wide at 12 fps and must come in under
// 5 MB (README plan, section 1c); the mp4 is the same picture at 30 fps, H.264, silent. --out defaults to <take>/demo,
// and --install also copies both files over docs/assets/demo.gif and demo.mp4.
//
// Layout (all lengths in points of the uncropped window, the way sync.json's sizePt measures it):
// {
//   "columns": 2, "gutter": 6, "background": "#141A26",
//   "tiles": [
//     { "stream": "notes" },                                       crop defaults to { "top": 33 }, the title bar
//     { "stream": "safari", "crop": { "top": 80 } },               a taller crop also drops the address bar
//     { "stream": "chess", "scrub": [{ "x": 10, "y": 40, "width": 200, "height": 20, "color": "#FFFFFF" }] },
//     { "stream": "hand-over-textedit", "crop": { "top": 312, "left": 220, "right": 0, "bottom": 0 } }
//   ]
// }
// Without --layout every stream in sync.json becomes a tile, two columns, in sync.json's order.
//
// Scrubbing. Window titles carry names (Chess shows the player's name), so a tile whose crop removes less than 28 pt from
// the top of a titled window is refused unless the tile says "keepTitle": true. The default crop is 33 pt: Chess's title
// bar on macOS 26 measured 32 pt plus a 1 px separator (T0b take, 2026-10-19); taller toolbars need a taller crop. A composite stream (several windows,
// cropped to their union) has its title bars wherever its windows sat, so its tile needs an explicit crop. A scrub box
// is filled with its "color", or with the colour sampled 2 pt left of the box on the cut's first frame. Streams smaller
// than 100 pt on a side are refused as tiles: the ghost hand's panel starts at 1 by 1 pt and moves with each action, so
// its own stream has no fixed place in a window. Show the hand through a composite stream of the hand and its window.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SPEC = Object.freeze({ width: 900, fps: 12, mp4Fps: 30, maxBytes: 5 * 1024 * 1024, minSeconds: 8, maxSeconds: 12,
  titlePt: 28, cropTopPt: 33, minTilePt: 100, colors: [256, 128, 64] });
const HEX = /^#[0-9A-Fa-f]{6}$/;
const even = value => Math.max(2, Math.floor(value / 2) * 2);
const finite = value => typeof value === 'number' && Number.isFinite(value);

// sync.json from the take, checked for what the cut relies on.
export function readTake(dir) {
  const path = join(dir, 'sync.json');
  if (!existsSync(path)) throw Error(`${path} is missing; a take folder holds sync.json and its .mov files`);
  const sync = JSON.parse(readFileSync(path, 'utf8'));
  if (sync?.version !== 1 || !Array.isArray(sync.streams) || !finite(sync.stopHostTime)) throw Error('sync.json is not a version 1 take');
  return sync;
}

function streamProblem(stream) {
  if (stream.error) return `recorded an error (${stream.error})`;
  if (stream.writer !== 'completed') return `writer status is ${stream.writer}`;
  if (!(stream.frames > 0)) return 'has no frames';
  if (!finite(stream.firstFrameHostTime)) return 'has no firstFrameHostTime';
  if (!finite(stream.scale) || stream.scale <= 0) return 'has no scale';
  if (!finite(stream.sizePt?.width) || !finite(stream.sizePt?.height)) return 'has no sizePt';
  return undefined;
}

// The cut as data: inputs with their seek offsets, each tile's crop and placement in pixels, and the output size.
// Pure, so the tests can check every refusal without ffmpeg.
export function planDemo(sync, layout = {}, { start = 0, duration = 10, width = SPEC.width } = {}) {
  if (!finite(duration) || duration < SPEC.minSeconds || duration > SPEC.maxSeconds) {
    throw Error(`duration must be ${SPEC.minSeconds} to ${SPEC.maxSeconds} s (README plan 1c), got ${duration}`);
  }
  if (!finite(start) || start < 0) throw Error(`start must be 0 or more seconds, got ${start}`);
  const byName = new Map(sync.streams.map(stream => [stream.name, stream]));
  const tilesIn = layout.tiles ?? sync.streams.map(stream => ({ stream: stream.name }));
  if (!Array.isArray(tilesIn) || !tilesIn.length) throw Error('the layout has no tiles');
  const columns = layout.columns ?? (tilesIn.length === 1 ? 1 : 2);
  const gutter = layout.gutter ?? 6;
  const background = layout.background ?? '#141A26';
  if (!Number.isInteger(columns) || columns < 1 || columns > 4) throw Error('columns must be 1 to 4');
  if (!Number.isInteger(gutter) || gutter < 0 || gutter > 40) throw Error('gutter must be 0 to 40 px');
  if (!HEX.test(background)) throw Error('background must be #RRGGBB');

  const tiles = tilesIn.map((tile, index) => {
    const stream = byName.get(tile?.stream);
    if (!stream) throw Error(`tile ${index + 1}: no stream named ${JSON.stringify(tile?.stream)} in sync.json`);
    const problem = streamProblem(stream);
    if (problem) throw Error(`${stream.name}: ${problem}`);
    const { width: wPt, height: hPt } = stream.sizePt;
    if (wPt < SPEC.minTilePt || hPt < SPEC.minTilePt) {
      throw Error(`${stream.name} is ${wPt} by ${hPt} pt, too small for a tile (the hand panel's own stream? use a composite with its window)`);
    }
    if (stream.composite && !tile.crop && !tile.keepTitle) {
      throw Error(`${stream.name} is a composite; give its tile an explicit crop that removes its windows' title bars`);
    }
    const crop = { top: SPEC.cropTopPt, right: 0, bottom: 0, left: 0, ...(tile.crop ?? {}) };
    for (const [side, value] of Object.entries(crop)) {
      if (!['top', 'right', 'bottom', 'left'].includes(side) || !finite(value) || value < 0) throw Error(`${stream.name}: bad crop ${side}`);
    }
    const titled = (stream.windows ?? []).some(window => typeof window.title === 'string' && window.title.trim());
    if (!stream.composite && titled && crop.top < SPEC.titlePt && tile.keepTitle !== true) {
      throw Error(`${stream.name}: the crop keeps the title bar (top ${crop.top} pt < ${SPEC.titlePt}), and window titles carry names; crop it or set keepTitle`);
    }
    const s = stream.scale;
    const px = value => Math.round(value * s);
    const cw = wPt - crop.left - crop.right, ch = hPt - crop.top - crop.bottom;
    if (cw < SPEC.minTilePt || ch < SPEC.minTilePt / 2) throw Error(`${stream.name}: the crop leaves ${cw} by ${ch} pt`);
    const scrub = (tile.scrub ?? []).map((box, i) => {
      if (![box?.x, box?.y, box?.width, box?.height].every(v => finite(v) && v >= 0) || box.width === 0 || box.height === 0) {
        throw Error(`${stream.name}: scrub box ${i + 1} needs x, y, width and height in pt`);
      }
      if (box.color !== undefined && !HEX.test(box.color)) throw Error(`${stream.name}: scrub box ${i + 1} color must be #RRGGBB`);
      const sample = { x: Math.max(0, px(box.x - 2)), y: Math.min(px(hPt) - 1, px(box.y + box.height / 2)) };
      return { x: px(box.x), y: px(box.y), width: px(box.width), height: px(box.height), color: box.color, sample };
    });
    return {
      stream: stream.name, file: stream.file ?? `${stream.name}.mov`, first: stream.firstFrameHostTime, scrub,
      crop: { x: px(crop.left), y: px(crop.top), width: even(px(cw)), height: even(px(ch)) },
      aspect: ch / cw, titleCropped: crop.top >= SPEC.titlePt || stream.composite === true,
    };
  });

  // The cut starts once every tile has a frame, and must end by the take's stop.
  const zero = Math.max(...tiles.map(tile => tile.first));
  const available = sync.stopHostTime - zero;
  if (start + duration > available + 1e-6) {
    throw Error(`the cut ends at ${(start + duration).toFixed(2)} s but the take has ${available.toFixed(2)} s with every tile recording`);
  }
  const cellW = even((width - (columns + 1) * gutter) / columns);
  const rows = [];
  for (let i = 0; i < tiles.length; i += columns) rows.push(tiles.slice(i, i + columns));
  let y = gutter;
  for (const row of rows) {
    const rowH = Math.max(...row.map(tile => even(cellW * tile.aspect)));
    row.forEach((tile, col) => {
      tile.cell = { x: gutter + col * (cellW + gutter), y, width: cellW, height: rowH };
      tile.scaled = { width: cellW, height: even(cellW * tile.aspect) };
      tile.seek = start + zero - tile.first;
    });
    y += rowH + gutter;
  }
  return { tiles, width: even(width), height: even(y), start, duration, background, zero };
}

const ffColor = hex => `0x${hex.slice(1)}`;

// One ffmpeg filter graph: each input to the output frame rate, trimmed to the cut, scrubbed, cropped, scaled and laid
// over a background of the cut's length. The recorder writes a frame only when a window changes, so a still window can
// go seconds without one; fps first repeats the frame on screen, and only then does trim cut, so every tile has a
// picture from the cut's first frame (seeking the input instead would drop the frame that covers the start).
export function composeFilter(plan, fps) {
  const parts = [`color=c=${ffColor(plan.background)}:s=${plan.width}x${plan.height}:r=${fps}:d=${plan.duration}[base]`];
  plan.tiles.forEach((tile, i) => {
    const boxes = tile.scrub.map(box => `drawbox=x=${box.x}:y=${box.y}:w=${box.width}:h=${box.height}:color=${ffColor(box.color)}@1:t=fill`);
    const chain = [`fps=${fps}`, `trim=start=${tile.seek.toFixed(4)}:duration=${plan.duration}`, 'setpts=PTS-STARTPTS', ...boxes, `crop=${tile.crop.width}:${tile.crop.height}:${tile.crop.x}:${tile.crop.y}`,
      `scale=${tile.scaled.width}:${tile.scaled.height}:flags=lanczos`, 'setsar=1', 'format=rgb24'];
    parts.push(`[${i}:v]${chain.join(',')}[t${i}]`);
  });
  let last = 'base';
  plan.tiles.forEach((tile, i) => {
    const x = tile.cell.x + (tile.cell.width - tile.scaled.width) / 2;
    const y = tile.cell.y + (tile.cell.height - tile.scaled.height) / 2;
    const next = i === plan.tiles.length - 1 ? 'out' : `o${i}`;
    parts.push(`[${last}][t${i}]overlay=x=${x}:y=${y}:eof_action=repeat[${next}]`);
    last = next;
  });
  return parts.join(';');
}

async function ffmpeg(args, ffmpegPath) {
  return run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });
}

async function sampleColor(file, seek, { x, y }, ffmpegPath) {
  const { stdout } = await ffmpeg(['-i', file, '-vf', `fps=30,trim=start=${seek.toFixed(4)},crop=1:1:${x}:${y}`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], ffmpegPath);
  if (stdout.length < 3) throw Error(`could not sample a scrub colour from ${file}`);
  return '#' + [...stdout.subarray(0, 3)].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function makeDemo(dir, { layout, start = 0, duration = 10, out = join(dir, 'demo'), install = false,
  ffmpegPath = process.env.FFMPEG ?? 'ffmpeg', log = () => {} } = {}) {
  const sync = readTake(dir);
  const plan = planDemo(sync, layout, { start, duration });
  for (const tile of plan.tiles) {
    tile.path = join(dir, tile.file);
    if (!existsSync(tile.path)) throw Error(`${tile.file} is missing from the take`);
    for (const box of tile.scrub) box.color ??= await sampleColor(tile.path, tile.seek, box.sample, ffmpegPath);
  }
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'sleight-demo-'));
  try {
    const inputs = plan.tiles.flatMap(tile => ['-i', tile.path]);
    // A lossless master at the mp4's rate, so the mp4 and the GIF come from the same frames.
    const master = join(work, 'master.mkv');
    log(`composing ${plan.tiles.length} tile(s), ${plan.width} by ${plan.height}, ${duration} s from ${start} s`);
    await ffmpeg([...inputs, '-filter_complex', composeFilter(plan, SPEC.mp4Fps), '-map', '[out]', '-t', String(duration),
      '-an', '-c:v', 'libx264rgb', '-qp', '0', '-preset', 'ultrafast', master], ffmpegPath);
    const mp4 = join(out, 'demo.mp4');
    await ffmpeg(['-y', '-i', master, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', mp4], ffmpegPath);
    const gif = join(out, 'demo.gif');
    let colors;
    for (const n of SPEC.colors) {
      await ffmpeg(['-y', '-i', master, '-vf', `fps=${SPEC.fps},split[a][b];[a]palettegen=max_colors=${n}:stats_mode=diff[p];` +
        `[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gif], ffmpegPath);
      if (statSync(gif).size <= SPEC.maxBytes) { colors = n; break; }
      log(`GIF is ${(statSync(gif).size / 1048576).toFixed(2)} MB at ${n} colours; trying fewer`);
    }
    if (!colors) throw Error(`the GIF is over ${SPEC.maxBytes / 1048576} MB even at ${SPEC.colors.at(-1)} colours; cut it shorter or use fewer tiles`);
    const report = {
      gif: { path: gif, bytes: statSync(gif).size, width: plan.width, height: plan.height, fps: SPEC.fps, colors },
      mp4: { path: mp4, bytes: statSync(mp4).size, fps: SPEC.mp4Fps }, start, duration,
      tiles: plan.tiles.map(tile => ({ stream: tile.stream, seek: Number(tile.seek.toFixed(3)), titleCropped: tile.titleCropped, scrubBoxes: tile.scrub.length })),
    };
    writeFileSync(join(out, 'demo.json'), JSON.stringify(report, null, 2) + '\n');
    if (install) {
      const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/assets');
      copyFileSync(gif, join(assets, 'demo.gif'));
      copyFileSync(mp4, join(assets, 'demo.mp4'));
      report.installed = assets;
    }
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseArgs(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => { if (i + 1 >= args.length) throw Error(`${arg} needs a value`); return args[++i]; };
    if (arg === '--layout') options.layout = JSON.parse(readFileSync(value(), 'utf8'));
    else if (arg === '--start') options.start = Number(value());
    else if (arg === '--duration') options.duration = Number(value());
    else if (arg === '--out') options.out = resolve(value());
    else if (arg === '--install') options.install = true;
    else if (arg.startsWith('--')) throw Error(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw Error('one take folder');
  return { dir: resolve(positional[0]), options };
}

async function main(args) {
  let parsed;
  try { parsed = parseArgs(args); } catch (error) {
    console.error(`${error.message}\nusage: node bench/capture/demo-gif.mjs <take-folder> [--layout layout.json] [--start s] [--duration s] [--out dir] [--install]`);
    return 2;
  }
  try {
    const report = await makeDemo(parsed.dir, { ...parsed.options, log: line => console.error(line) });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    console.error(`demo-gif: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
