// ChatGPT's macOS update feed, the download it names, its Sparkle signature, and unpacking it without running it.
// The feed and key come from the installed app (26.1013.40934): `codexSparkleFeedUrl` in app.asar's package.json and
// `SUPublicEDKey` in Contents/Info.plist. The app also asks https://updates.oaistatic.com/codex/app/appcast with
// per-user query parameters; the static feed needs none, so it's the one polled here.
import { execFile } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const FEED_URL = 'https://persistent.oaistatic.com/codex-app-prod/appcast.xml';
export const ED_PUBLIC_KEY = 'mNfr1v9t63BfgDtlw4C8lRvSY6uMggIXABDOCi3tS6k=';
// Downloads come only from OpenAI's static hosts; a feed pointing anywhere else stops the check.
export const DOWNLOAD_HOSTS = /^(?:[a-z0-9-]+\.)*(?:oaistatic\.com|openai\.com|chatgpt\.com)$/;
export const MAX_DOWNLOAD = 4 * 1024 ** 3;

const attr = (tag, name) => new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`).exec(tag)?.[1];
const element = (xml, name) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(xml)?.[1];

// Sparkle appcast items: version, build, enclosure and signature. Version and build may sit on the item or the enclosure.
export function parseAppcast(xml) {
  const items = [];
  for (const match of String(xml ?? '').matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const item = match[0];
    const enclosure = /<enclosure\b[^>]*>/.exec(item)?.[0] ?? '';
    const build = element(item, 'sparkle:version') ?? attr(enclosure, 'sparkle:version');
    const version = element(item, 'sparkle:shortVersionString') ?? attr(enclosure, 'sparkle:shortVersionString') ?? build;
    items.push({
      version, build, url: attr(enclosure, 'url'), length: Number(attr(enclosure, 'length')) || undefined,
      edSignature: attr(enclosure, 'sparkle:edSignature'), channel: element(item, 'sparkle:channel'),
    });
  }
  return items;
}

const compare = (a, b) => {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
// The newest release on the default channel (beta and other channels are skipped).
export function latestItem(items) {
  return items.filter(item => !item.channel && item.url && item.version)
    .sort((a, b) => compare(b.build ?? b.version, a.build ?? a.version) || compare(b.version, a.version))[0];
}

export async function fetchText(url, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok) throw new Error(`feed request failed with HTTP ${response.status}`);
  return response.text();
}

export function checkDownloadUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('the feed names no valid download URL'); }
  if (parsed.protocol !== 'https:' || !DOWNLOAD_HOSTS.test(parsed.hostname)) throw new Error(`refusing a download from ${parsed.protocol}//${parsed.hostname}`);
  return parsed;
}

export async function download(url, path, { fetchImpl = fetch, maxBytes = MAX_DOWNLOAD, timeoutMs = 30 * 60000 } = {}) {
  checkDownloadUrl(url);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed with HTTP ${response.status}`);
  if (response.url) checkDownloadUrl(response.url);
  let bytes = 0;
  const limit = async function* (source) {
    for await (const chunk of source) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error(`download is larger than ${maxBytes} bytes`);
      yield chunk;
    }
  };
  await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(path, { mode: 0o600 }));
  return bytes;
}

// Sparkle's EdDSA signature over the whole archive, checked against the key the installed app pins.
export function verifySignature(path, signature, key = ED_PUBLIC_KEY) {
  if (!signature) return false;
  const raw = Buffer.from(key, 'base64');
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return verify(null, readFileSync(path), createPublicKey({ key: der, format: 'der', type: 'spki' }), Buffer.from(signature, 'base64'));
}

// Unpacks a .zip with unzip, or a .dmg with 7-Zip (7zz, else 7z), whose first pass can yield a disk image that needs a
// second. Only reads files: nothing from the archive runs.
export async function unpack(archive, dir, { run = execute, which = tool => existsSync(tool) } = {}) {
  const head = readFileSync(archive).subarray(0, 4);
  if (head[0] === 0x50 && head[1] === 0x4b) {
    await run('unzip', ['-q', '-o', archive, '-d', dir], { maxBuffer: 64 << 20 });
    return;
  }
  const sevenZip = ['/usr/bin/7zz', '/usr/local/bin/7zz', '/opt/homebrew/bin/7zz', '/usr/bin/7z', '/usr/local/bin/7z', '/opt/homebrew/bin/7z'].find(which);
  if (!sevenZip) throw new Error('unpacking a .dmg needs 7-Zip (7zz or 7z)');
  await run(sevenZip, ['x', '-y', `-o${dir}`, archive], { maxBuffer: 64 << 20 });
  const images = readdirSync(dir).filter(name => /\.(?:apfs|hfsx?|img)$/i.test(name));
  for (const image of images) await run(sevenZip, ['x', '-y', `-o${join(dir, 'volume')}`, join(dir, image)], { maxBuffer: 64 << 20 });
}
