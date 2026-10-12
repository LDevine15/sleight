import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { INVOICE_ID, INVOICE_TOTAL, NOTE, NATIVE_FILES, ROSTER } from './data.mjs';

export { INVOICE_TOTAL, NOTE, NATIVE_FILES, ROSTER };

function siteProblems(task, site) {
  if (!task.site?.expect?.length) return [];
  if (!site || site.error) return [`site log unavailable: ${site?.error ?? 'not fetched'}`];
  const lines = site.lines || [];
  const problems = [];
  for (const re of task.site.expect) {
    if (!lines.some((l) => new RegExp(re, 'i').test(l))) problems.push(`site log has no line matching /${re}/`);
  }
  return problems;
}

// PDFKit reads the file itself. Spotlight (mdls) returns (null) under /tmp, which isn't indexed (2026-10-12).
const PDF_TEXT = 'ObjC.import("PDFKit"); function run(argv) { const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0])); return d.isNil() ? "" : ObjC.unwrap(d.string); }';
export function extractPdfText(file, exec = execFileSync) {
  const text = exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_TEXT, file], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (!text) throw new Error('PDF has no text');
  return text;
}

function previewPdf({ task, dir, extractPdf }) {
  const file = join(dir, task.native.file || 'invoice.pdf');
  const total = task.native.total || INVOICE_TOTAL;
  if (!existsSync(file)) return [`missing ${file}`];
  const body = readFileSync(file, 'utf8');
  if (!body.startsWith('%PDF-')) return [`${file} is not a PDF`];
  let text;
  try { text = extractPdf(file); }
  catch (err) { return [`${file} text extraction failed: ${err.message}`]; }
  if (!new RegExp(`\\b${INVOICE_ID}\\b`).test(text)
    || !new RegExp(`(?:^|[^\\d.,])${total.replace(/[.,]/g, '\\$&')}(?:$|[^\\d.,])`).test(text)) {
    return [`${file} text is missing invoice ${INVOICE_ID} or total ${total}`];
  }
  const marker = join(dir, 'invoice-total.txt');
  if (!existsSync(marker) || readFileSync(marker, 'utf8').trim() !== `${INVOICE_ID} ${total}`) {
    return [`${marker} is missing the Preview read-back total ${total}`];
  }
  return [];
}

function texteditFile({ dir }) {
  const file = join(dir, 'roster.txt');
  if (!existsSync(file)) return [`missing ${file}`];
  const body = readFileSync(file, 'utf8');
  const problems = [];
  const lines = body.split(/\r?\n/);
  for (const row of ROSTER) {
    const rows = lines.filter((line) => line.includes(row.name));
    const line = rows[0] || '';
    const hours = line.slice(line.indexOf(row.name) + row.name.length).match(/[+-]?\d+(?:[.,]\d+)*/)?.[0];
    if (rows.length !== 1 || ROSTER.filter((r) => line.includes(r.name)).length !== 1 || hours !== row.hours) {
      problems.push(`${file} is missing ${row.name} ${row.hours}`);
    }
  }
  return problems;
}

function noteFile({ task, dir }) {
  const file = join(dir, task.native.file);
  if (!existsSync(file)) return [`missing ${file}`];
  if (readFileSync(file, 'utf8').replaceAll('\r\n', '\n').trim() !== `${NOTE.title}\n${NOTE.body}`) {
    return [`${file} does not contain the delivery note`];
  }
  return [];
}

// The page log and saved artifacts are checked independently of the RESULT line.
export function gradeNative({ task, dir, site, extractPdf = extractPdfText } = {}) {
  if (!task?.native) return { problems: [] };
  const problems = siteProblems(task, site);
  if (task.native.kind === 'preview-pdf') problems.push(...previewPdf({ task, dir, extractPdf }));
  else if (task.native.kind === 'textedit-file') problems.push(...texteditFile({ dir }));
  else if (task.native.kind === 'note-file') problems.push(...noteFile({ task, dir }));
  else problems.push(`unknown native kind ${task.native.kind}`);
  return { problems };
}

export function cleanupNative(dir) {
  for (const name of NATIVE_FILES) {
    try { unlinkSync(join(dir, name)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}
