// Held-out document tasks for the WB1 and WB2 A/B (2026-10-18). The owner's rule: a generic fix that also touches a task
// sleight already wins is measured on tasks it was never tuned on, so these are not claim tasks (bench/claim-tasks.txt,
// bench/world/suite.json "heldOut"), and a world pass without --tasks leaves them out (shop.mjs selectSuiteTasks).
// Two Word documents with other headings, replacements and table shapes than word-edit, and a TextEdit rich text document
// with a replacement and a table, where WB1 applies and WB2 has no Undo item to read.
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { acquireFixture } from './real-run.mjs';
import { openFixture, closeFixtures } from './real-fixture.mjs';
import { prepareWordDocument, wordChecker } from './real-office.mjs';
import { officeGuard } from './tasks-office.mjs';

const word = (id, name, lines, instructions, expect) => ({
  id, app: 'Microsoft Word', bundle: 'com.microsoft.Word', stopOnAppDialog: true, heldOut: true,
  prepare: ctx => prepareWordDocument(ctx, name, lines(ctx)),
  setup: open => async ctx => {
    prepareWordDocument(ctx, name, lines(ctx));
    await acquireFixture(ctx, 'office', () => open(ctx, { app: 'Microsoft Word', bundle: 'com.microsoft.Word', target: ctx.officePath,
      token: basename(ctx.officePath), mode: 'document', stopOnAppDialog: true }));
  },
  prompt: ctx => `Using computer use in Microsoft Word, edit only ${ctx.officePath}. ${instructions(ctx)} ${officeGuard}`,
  check: wordChecker(expect), cleanup: closeFixtures,
});

const memo = word('word-memo', 'Memo', ctx => [`Memo ${ctx.nonce}`, 'Summary', 'The copper order shipped on time.', `Keep this line ${ctx.nonce}.`],
  ctx => `Apply the built-in Heading 1 paragraph style to "Memo ${ctx.nonce}" and the built-in Heading 2 paragraph style to "Summary". ` +
    'Use Find and Replace to replace copper with silver. Keep all other existing text unchanged. ' +
    'At the end of the document insert one 3-row, 2-column table. Its rows are Name | Role, Ada | Lead and Lin | Review. Do not add any other text.',
  { paragraphs: ctx => [`Memo ${ctx.nonce}`, 'Summary', 'The silver order shipped on time.', `Keep this line ${ctx.nonce}.`], headings: [1, 2],
    table: [['Name', 'Role'], ['Ada', 'Lead'], ['Lin', 'Review']] });

const brief = word('word-brief', 'Brief', ctx => [`Brief ${ctx.nonce}`, 'Pack the blue crate first.', 'Load the blue crate last.', `Keep this line ${ctx.nonce}.`],
  ctx => `Apply the built-in Heading 2 paragraph style to "Brief ${ctx.nonce}". Use Find and Replace to replace every blue crate with green crate. ` +
    'Keep all other existing text unchanged. At the end of the document insert one 2-row, 3-column table. ' +
    'Its first row is Day | Item | Qty, and its second row is Mon | Rope | 2. Do not add any other text.',
  { paragraphs: ctx => [`Brief ${ctx.nonce}`, 'Pack the green crate first.', 'Load the green crate last.', `Keep this line ${ctx.nonce}.`], headings: [2],
    table: [['Day', 'Item', 'Qty'], ['Mon', 'Rope', '2']] });

// A bounded reader for the rich text TextEdit saves: paragraphs and table rows in order, with no file, font or picture
// destinations. Nested tables, pictures and objects are refused rather than read.
const SKIPPED = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable', 'expandedcolortbl', 'header', 'footer']);
export function rtfBlocks(source) {
  if (typeof source !== 'string' || source.length > 1024 * 1024 || !source.startsWith('{\\rtf1')) throw new Error('not rich text');
  const blocks = [], stack = [];
  let text = '', cells = [], skip = 0, depth = 0, unicodeSkip = 1, pendingSkip = 0, groupStart = false;
  const emit = char => { if (pendingSkip > 0) { pendingSkip--; return; } if (!skip) text += char; };
  const paragraph = () => { if (cells.length && !text.trim()) return; blocks.push({ paragraph: text }); text = ''; };
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (c === '{') { stack.push({ skip, unicodeSkip }); depth++; groupStart = true; i++; continue; }
    if (c === '}') {
      const state = stack.pop(); if (!state) throw new Error('unbalanced rich text');
      ({ skip, unicodeSkip } = state); depth--; groupStart = false; i++; continue;
    }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (c !== '\\') { emit(c); groupStart = false; i++; continue; }
    const next = source[i + 1];
    if (next === '\n' || next === '\r') { if (!skip) paragraph(); i += 2; groupStart = false; continue; }
    if (next === '*') { if (groupStart) skip = depth; i += 2; continue; }
    if (next === "'") { emit(String.fromCharCode(parseInt(source.slice(i + 2, i + 4), 16))); i += 4; groupStart = false; continue; }
    if (/[\\{}]/.test(next)) { emit(next); i += 2; groupStart = false; continue; }
    if (next === '~') { emit(' '); i += 2; continue; }
    if (/[-_|:]/.test(next)) { i += 2; continue; }
    const word = /^\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(source.slice(i, i + 48));
    if (!word) throw new Error('invalid rich text control');
    i += word[0].length;
    const [, name, number] = word;
    if (groupStart && SKIPPED.has(name)) skip = depth;
    groupStart = false;
    if (skip) continue;
    if (['pict', 'object', 'nesttableprops', 'nestcell', 'nestrow', 'field'].includes(name)) throw new Error(`unsupported rich text ${name}`);
    if (name === 'itap' && Number(number) > 1) throw new Error('nested rich text table');
    if (name === 'uc') unicodeSkip = Number(number ?? 1);
    else if (name === 'u') { const code = Number(number); text += String.fromCharCode(code < 0 ? code + 65536 : code); pendingSkip = unicodeSkip; }
    else if (name === 'par') paragraph();
    else if (name === 'tab') emit('\t');
    else if (name === 'line') emit('\n');
    else if (name === 'cell') { cells.push(text); text = ''; }
    else if (name === 'row') { blocks.push({ row: cells }); cells = []; text = ''; }
  }
  if (depth !== 0 || stack.length) throw new Error('unbalanced rich text');
  if (text) blocks.push({ paragraph: text });
  if (cells.length) throw new Error('unterminated rich text table row');
  return blocks.filter(block => block.row || block.paragraph.trim() !== '');
}

const rtf = lines => '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2822\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n{\\colortbl;\\red255\\green255\\blue255;}\n' +
  '\\pard\\tx720\\pardeftab720\\partightenfactor0\n\n\\f0\\fs24 \\cf0 ' + lines.join('\\\n') + '}';
const notesLines = ctx => [`Notes ${ctx.nonce}`, 'The amber lamp is on.', `Keep this line ${ctx.nonce}.`];
function prepareNotes(ctx) {
  if (typeof ctx.nonce !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/.test(ctx.nonce)) throw new Error('unsafe fixture nonce');
  ctx.document = join(ctx.dir, `Notes-${ctx.nonce}.rtf`);
  writeFileSync(ctx.document, rtf(notesLines(ctx)), { flag: 'wx', mode: 0o600 });
}
export function checkNotes(ctx) {
  try {
    if (dirname(resolve(ctx.document)) !== resolve(ctx.dir) || !lstatSync(ctx.document).isFile()) return 'HELD_OUT_RTF_UNSAFE_PATH';
    const blocks = rtfBlocks(readFileSync(ctx.document, 'latin1'));
    const paragraphs = blocks.filter(block => !block.row).map(block => block.paragraph.trim());
    const rows = blocks.filter(block => block.row).map(block => block.row.map(cell => cell.trim()));
    if (JSON.stringify(paragraphs) !== JSON.stringify([`Notes ${ctx.nonce}`, 'The violet lamp is on.', `Keep this line ${ctx.nonce}.`])) return 'HELD_OUT_RTF_TEXT_MISMATCH';
    if (JSON.stringify(rows) !== JSON.stringify([['Item', 'Count'], ['Crates', '7']])) return 'HELD_OUT_RTF_TABLE_MISMATCH';
    if (!blocks.at(-1)?.row || blocks.findIndex(block => block.row) < blocks.length - 2) return 'HELD_OUT_RTF_TABLE_NOT_AT_END';
    return true;
  } catch (error) { return `HELD_OUT_RTF_UNREADABLE: ${error.message}`; }
}
const notes = {
  id: 'textedit-notes-table', app: 'TextEdit', bundle: 'com.apple.TextEdit', heldOut: true, prepare: prepareNotes,
  setup: open => async ctx => {
    prepareNotes(ctx);
    await acquireFixture(ctx, 'document0', () => open(ctx, { app: 'TextEdit', bundle: 'com.apple.TextEdit', target: ctx.document,
      token: basename(ctx.document), mode: 'document' }));
  },
  prompt: ctx => `In TextEdit, use only the fixture document ${ctx.document}. Use Find and Replace to replace amber with violet. ` +
    'Keep all other existing text unchanged. At the end of the document insert one 2-row, 2-column table. Its first row is ' +
    'Item | Count, and its second row is Crates | 7. Do not add any other text. Save the same rich text file and leave it open for cleanup.',
  check: checkNotes, cleanup: closeFixtures,
};

export const HELD_OUT_TASKS = ['word-memo', 'word-brief', 'textedit-notes-table'];
export const heldOutTasks = (open = openFixture) => [memo, brief, notes].map(task => ({ ...task, setup: task.setup(open) }));
