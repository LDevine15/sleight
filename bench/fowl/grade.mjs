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

function previewPdf({ task, dir }) {
  const file = join(dir, task.native.file || 'invoice.pdf');
  const total = task.native.total || INVOICE_TOTAL;
  if (!existsSync(file)) return [`missing ${file}`];
  const body = readFileSync(file, 'utf8');
  if (!body.startsWith('%PDF-')) return [`${file} is not a PDF`];
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
  for (const row of ROSTER) {
    const hours = new RegExp(`(?:^|[^\\d.])${row.hours.replace('.', '\\.')}($|[^\\d.])`);
    if (!body.split(/\r?\n/).some((line) => line.includes(row.name) && hours.test(line))) {
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
export function gradeNative({ task, dir, site } = {}) {
  if (!task?.native) return { problems: [] };
  const problems = siteProblems(task, site);
  if (task.native.kind === 'preview-pdf') problems.push(...previewPdf({ task, dir }));
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
