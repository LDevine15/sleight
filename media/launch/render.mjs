#!/usr/bin/env node
// Renders scene.html to an MP4, one exact frame at a time (every frame is a pure function of t).
// Usage: node media/launch/render.mjs [--out file.mp4] [--fps 30] [--stills 2,6,12] [--numbers numbers.json]
// Needs playwright-core and a Chromium (PLAYWRIGHT_MODULE and CHROMIUM, defaults below) and ffmpeg on PATH.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const here = dirname(fileURLToPath(import.meta.url));
const fps = Number(args.fps || 30);
const out = args.out || join(homedir(), 'Desktop/sleight-launch/sleight-launch.mp4');
const cache = join(homedir(), 'Library/Caches');
const require = createRequire(process.env.PLAYWRIGHT_MODULE || join(cache, 'sleight-video/node_modules/'));
const { chromium } = require('playwright-core');
const build = readdirSync(join(cache, 'ms-playwright')).filter((d) => /^chromium-\d+$/.test(d)).sort().at(-1);
const executablePath = process.env.CHROMIUM || join(cache, 'ms-playwright', build, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const browser = await chromium.launch({ executablePath, args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
if (args.numbers) await page.addInitScript(`window.NUMBERS = ${readFileSync(args.numbers, 'utf8')};`);
await page.goto(pathToFileURL(join(here, 'scene.html')).href);
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);
const frame = async (t) => { await page.evaluate((x) => window.render(x), t); return page.screenshot({ type: 'png' }); };

mkdirSync(dirname(out), { recursive: true });
if (args.stills) {
  for (const t of args.stills.split(',').map(Number)) writeFileSync(out.replace(/\.mp4$/, `-${t}s.png`), await frame(t));
} else {
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'slow', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)))));
  const total = Math.round(duration * fps);
  for (let i = 0; i < total; i++) {
    const png = await frame(i / fps);
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
}
await browser.close();
console.log(out);
