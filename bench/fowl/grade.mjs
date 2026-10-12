import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { INVOICE_TOTAL, MAIL, NATIVE_FILES, ROSTER } from './data.mjs';

export { INVOICE_TOTAL, MAIL, NATIVE_FILES, ROSTER };

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
  if (!body.includes('%PDF')) return [`${file} is not a PDF`];
  if (!body.includes(total)) return [`${file} does not contain the invoice total ${total}`];
  return [];
}

function texteditFile({ dir }) {
  const file = join(dir, 'roster.txt');
  if (!existsSync(file)) return [`missing ${file}`];
  const body = readFileSync(file, 'utf8');
  const problems = [];
  for (const row of ROSTER) {
    if (!body.includes(row.name) || !body.includes(row.hours)) {
      problems.push(`${file} is missing ${row.name} ${row.hours}`);
    }
  }
  return problems;
}

function mailDraft({ mail }) {
  const drafts = mail?.drafts || [];
  const hit = drafts.find((d) => (d.to || '').toLowerCase() === MAIL.to.toLowerCase()
    && (d.subject || '').includes(MAIL.subject) && (d.body || '').includes(MAIL.token));
  if (!hit) return ['no matching Mail draft with the confirmation line'];
  if (hit.sent) return ['the Mail draft was sent'];
  if ((mail.sent || []).length) return ['Mail recorded a send'];
  return [];
}

// Native step for a hand-off task. Also checks task.site.expect so a passing grade is the page log
// plus a file or an unsent draft, never the RESULT line alone. mail is injected (unit tests stub it;
// a live round that cannot read Mail will fail this check, which sleight-arch has to supply).
export function gradeNative({ task, dir, site, mail } = {}) {
  if (!task?.native) return { problems: [] };
  const problems = siteProblems(task, site);
  if (task.native.kind === 'preview-pdf') problems.push(...previewPdf({ task, dir }));
  else if (task.native.kind === 'textedit-file') problems.push(...texteditFile({ dir }));
  else if (task.native.kind === 'mail-draft') problems.push(...mailDraft({ mail }));
  else problems.push(`unknown native kind ${task.native.kind}`);
  return { problems };
}

export function cleanupNative(dir) {
  for (const name of NATIVE_FILES) {
    try { unlinkSync(join(dir, name)); } catch { /* already gone */ }
  }
}
