import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const load = async (rel) => {
  const module = await import(new URL(rel, import.meta.url).href).catch((err) => {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    return undefined;
  });
  assert.ok(module, `${rel} is absent`);
  return module;
};

test('three hand-off tasks name a local page, a native step, a site log and a file or mail check', async () => {
  const tasks = JSON.parse(readFileSync(join(root, 'bench/fowl/handoff.json'), 'utf8'));
  assert.equal(tasks.length, 3);
  assert.deepEqual(tasks.map((t) => t.name), ['invoice-preview', 'table-textedit', 'mailto-draft']);
  for (const task of tasks) {
    assert.match(task.prompt, /\{browser\}/);
    assert.match(task.prompt, new RegExp(`http://127\\.0\\.0\\.1:5431/t/${task.name}/`));
    assert.ok(task.site?.log?.includes(`/t/${task.name}/api/log`));
    assert.ok(Array.isArray(task.site.expect) && task.site.expect.length > 0);
    assert.ok(task.native?.kind);
    assert.ok(task.budgetSeconds > 0);
  }
  assert.equal(tasks[0].native.kind, 'preview-pdf');
  assert.equal(tasks[0].native.file, 'invoice.pdf');
  assert.match(tasks[0].prompt, /\{out\}\/invoice\.pdf/);
  assert.match(tasks[0].prompt, /Preview/);
  assert.equal(tasks[1].native.kind, 'textedit-file');
  assert.equal(tasks[1].native.file, 'roster.txt');
  assert.match(tasks[1].prompt, /\{out\}\/roster\.txt/);
  assert.match(tasks[1].prompt, /TextEdit/);
  assert.equal(tasks[2].native.kind, 'mail-draft');
  assert.match(tasks[2].prompt, /mailto|Mail/);
  assert.match(tasks[2].prompt, /do not send/i);
});

test('invoice grader needs the saved PDF with the page total, not the answer text', async () => {
  const { gradeNative, INVOICE_TOTAL } = await load('../bench/fowl/grade.mjs');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-handoff-inv-')));
  const task = {
    name: 'invoice-preview',
    native: { kind: 'preview-pdf', file: 'invoice.pdf', total: INVOICE_TOTAL },
    site: { expect: ['^view /', '^download /invoice.pdf'] },
  };
  const site = { lines: ['view /', 'download /invoice.pdf'] };
  const answer = `RESULT: the total is $${INVOICE_TOTAL}`;
  assert.ok(gradeNative({ task, dir, site, answer }).problems.length > 0, 'missing file fails');
  writeFileSync(join(dir, 'invoice.pdf'), '%PDF-1.4\n(Total: $0.00)\n');
  assert.match(gradeNative({ task, dir, site, answer }).problems.join('\n'), /total/);
  writeFileSync(join(dir, 'invoice.pdf'), `%PDF-1.4\n(Invoice INV-4419)\n(Total: $${INVOICE_TOTAL})\n`);
  assert.deepEqual(gradeNative({ task, dir, site, answer }).problems, []);
  assert.ok(gradeNative({ task, dir, site: { lines: ['view /'] }, answer }).problems.length > 0, 'download log required');
});

test('table grader needs the saved TextEdit file to contain every roster row', async () => {
  const { gradeNative, ROSTER } = await load('../bench/fowl/grade.mjs');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-handoff-tab-')));
  const task = { name: 'table-textedit', native: { kind: 'textedit-file', file: 'roster.txt' }, site: { expect: ['^view /'] } };
  const site = { lines: ['view /'] };
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0);
  writeFileSync(join(dir, 'roster.txt'), 'not the table\n');
  assert.ok(gradeNative({ task, dir, site }).problems.length > 0);
  writeFileSync(join(dir, 'roster.txt'), ROSTER.map((r) => `${r.name}\t${r.role}\t${r.hours}`).join('\n'));
  assert.deepEqual(gradeNative({ task, dir, site }).problems, []);
});

test('mail grader needs a matching unsent draft with the confirmation line, and the mailto click', async () => {
  const { gradeNative, MAIL } = await load('../bench/fowl/grade.mjs');
  const task = { name: 'mailto-draft', native: { kind: 'mail-draft' }, site: { expect: ['^pointer /'] } };
  const site = { lines: ['view /', `pointer / ${MAIL.href}`] };
  const draft = { to: MAIL.to, subject: MAIL.subject, body: MAIL.token, sent: false };
  assert.ok(gradeNative({ task, site, mail: { drafts: [] } }).problems.length > 0);
  assert.ok(gradeNative({ task, site, mail: { drafts: [{ ...draft, body: 'hello' }] } }).problems.length > 0);
  assert.ok(gradeNative({ task, site, mail: { drafts: [{ ...draft, sent: true }] } }).problems.length > 0);
  assert.deepEqual(gradeNative({ task, site, mail: { drafts: [draft] } }).problems, []);
  assert.ok(gradeNative({ task, site: { lines: ['view /'] }, mail: { drafts: [draft] } }).problems.length > 0);
});

test('cleanup deletes the native files under the task dir and leaves other names', async () => {
  const { cleanupNative } = await load('../bench/fowl/grade.mjs');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-handoff-cln-')));
  writeFileSync(join(dir, 'invoice.pdf'), 'pdf');
  writeFileSync(join(dir, 'roster.txt'), 'table');
  writeFileSync(join(dir, 'keep.md'), 'stay');
  cleanupNative(dir);
  assert.equal(readFileSync(join(dir, 'keep.md'), 'utf8'), 'stay');
  assert.throws(() => readFileSync(join(dir, 'invoice.pdf')));
  assert.throws(() => readFileSync(join(dir, 'roster.txt')));
});

test('the local site serves the invoice PDF, table and mailto, and logs download and click', async (t) => {
  const { startServer, INVOICE_TOTAL, ROSTER, MAIL } = await load('../bench/fowl/site/server.mjs');
  const server = await startServer({ port: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const get = async (path, init) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  };
  const invoice = await get('/t/invoice-preview/');
  assert.equal(invoice.status, 200);
  assert.match(invoice.text, new RegExp(INVOICE_TOTAL.replace('.', '\\.')));
  assert.match(invoice.text, /invoice\.pdf/);
  const pdf = await get('/t/invoice-preview/invoice.pdf');
  assert.equal(pdf.status, 200);
  assert.match(pdf.type, /pdf/);
  assert.match(pdf.text, /%PDF/);
  assert.match(pdf.text, new RegExp(INVOICE_TOTAL.replace('.', '\\.')));
  const table = await get('/t/table-textedit/');
  assert.equal(table.status, 200);
  for (const row of ROSTER) {
    assert.match(table.text, new RegExp(row.name));
    assert.match(table.text, new RegExp(row.hours.replace('.', '\\.')));
  }
  const mail = await get('/t/mailto-draft/');
  assert.equal(mail.status, 200);
  assert.match(mail.text, new RegExp(`mailto:${MAIL.to}`));
  assert.match(mail.text, new RegExp(MAIL.subject.replace(/[()]/g, '\\$&')));
  const log = JSON.parse((await get('/t/invoice-preview/api/log')).text);
  assert.ok(log.lines.some((l) => /^view \//.test(l)));
  assert.ok(log.lines.some((l) => /^download \/invoice\.pdf/.test(l)));
  await get('/t/mailto-draft/api/log', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'pointer', path: '/', field: MAIL.href }) });
  const mailLog = JSON.parse((await get('/t/mailto-draft/api/log')).text);
  assert.ok(mailLog.lines.some((l) => l.includes(MAIL.to)));
  await server.close();
});

test('origin-hook accepts the hand-off apps and 127.0.0.1, and declines other apps', async () => {
  const { answer } = await load('../bench/fowl/origin-hook.mjs');
  const hook = (message) => ({ mcp_server_name: 'plugin:sleight:computer', message });
  assert.equal(answer(hook('Allow Browser use to access http://127.0.0.1:5431?')), 'accept');
  for (const app of ['Preview', 'TextEdit', 'Mail', 'Google Chrome', 'Helium']) {
    assert.equal(answer(hook(`Allow Computer Use to use "${app}"?`)), 'accept', app);
  }
  assert.equal(answer(hook('Allow Computer Use to use "Safari"?')), 'decline');
  assert.equal(answer(hook('Allow Browser use to access https://example.com?')), 'decline');
});

test('fowl+sleight setup loads FowlBrowser for tabs and computer-only sleight for apps', async () => {
  const { fowlSleightSetup } = await load('../bench/fowl/surface.mjs');
  const setup = fowlSleightSetup({
    dir: '/tmp/fb-rounds/x/invoice-preview', mcpRoot: '/fowl', sleightRepo: root, label: '🧪 invoice-preview',
  });
  assert.equal(setup.mcpServers.fowlbrowser.command, join('/fowl', 'mcp/bin/fowlbrowser-mcp'));
  assert.equal(setup.mcpServers.fowlbrowser.env.FOWLBROWSER_LABEL, '🧪 invoice-preview');
  assert.equal(setup.mcpServers['plugin:sleight:computer'].command, join(root, 'plugins/sleight/bin/sleight-mcp'));
  assert.equal(setup.mcpServers['plugin:sleight:computer'].env.SLEIGHT_SURFACES, 'computer');
  assert.match(setup.allowed, /mcp__fowlbrowser/);
  assert.match(setup.allowed, /mcp__plugin_sleight_computer__js/);
  assert.match(setup.promptPrefix, /FowlBrowser/);
  assert.match(setup.promptPrefix, /plugin_sleight_computer__js/);
  assert.equal(setup.pluginDir, join(root, 'plugins/sleight'));
});

test('the surface patch applies on the pinned FowlBrowser commit and adds fowl+sleight', () => {
  const cache = join(process.env.HOME, 'Library/Caches/sleight-bench/fowlbrowser');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-handoff-patch-')));
  const orig = spawnSync('git', ['-C', cache, 'show', '8b68924:tools/rounds.mjs'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(orig.status, 0, orig.stderr);
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'tools/rounds.mjs'), orig.stdout);
  const apply = spawnSync('git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr + apply.stdout);
  const patched = readFileSync(join(dir, 'tools/rounds.mjs'), 'utf8');
  assert.match(patched, /fowl\+sleight/);
  assert.match(patched, /replaceAll\('\{out\}'/);
  assert.match(patched, /gradeNative/);
  assert.match(patched, /bench\/fowl\/surface\.mjs/);
});
