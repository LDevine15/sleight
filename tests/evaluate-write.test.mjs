import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { evaluateWrite } from '../plugins/sleight/lib/evaluate-write.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const writes = [
  ['document.querySelector("input").value = "x"', 'fill'],
  ['document.querySelector("input").checked = true', 'setChecked'],
  ['document.body.innerHTML = ""', 'tab.ax.write'],
  ['document.querySelector("button").click()', 'click'],
  ['document.body.dispatchEvent(new Event("change"))', 'click'],
  ['new CustomEvent("change")', 'click'],
  ['new PointerEvent("pointerdown")', 'click'],
  ['new MouseEvent("mousedown")', 'click'],
  ['new KeyboardEvent("keydown")', 'click'],
  ['new DragEvent("dragstart")', 'dragTo'],
  ['new DataTransfer()', 'dragTo'],
  ['fetch("/submit", { method: "POST" })', 'tab.ax.write'],
  ['document.body.setAttribute("value", "x")', 'fill'],
  ['document.body.appendChild(document.querySelector("li"))', 'dragTo'],
  ['document.body.insertBefore(document.querySelector("li"), null)', 'dragTo'],
  ['document.body.removeChild(document.querySelector("li"))', 'dragTo'],
  ['document.body.replaceChild(document.querySelector("li"), document.body.firstChild)', 'dragTo'],
  ['document.body.scrollTop = 2', 'scroll'],
  ['document.querySelector("select").selectedIndex = 2', 'selectOption'],
  ['document.querySelector("form").onsubmit = () => false', 'tab.ax.write'],
  ['window.fetch = async () => ({ ok: true })', 'tab.ax.write'],
  ['document.querySelector("form").addEventListener("submit", () => {})', 'tab.ax.write'],
  ['document.createEvent("MouseEvents")', 'click'],
];
for (const [statement, action] of writes) test(`evaluate refuses ${statement}`, () => {
  const notice = evaluateWrite(`const pw = tab.playwright;\nawait pw.evaluate(() => {\n  ${statement};\n});`);
  assert.match(notice, /Line 3:/);
  assert.match(notice, /evaluate.*read-only/);
  assert.ok(notice.includes(action), notice);
});

const reads = [
  'await tab.playwright.evaluate(() => document.querySelector("input").value)',
  'await tab.playwright.evaluate(() => Object.fromEntries(new FormData(document.querySelector("form")).entries()))',
  'await tab.playwright.evaluate(() => [...document.querySelectorAll("input")].map(el => ({ value: el.value, checked: el.checked })))',
  'await tab.playwright.evaluate(() => document.body.innerHTML)',
  'await tab.playwright.evaluate(() => "new Event(); el.value = 1; fetch()")',
  'await tab.playwright.evaluate(() => { /* el.click(); */ return document.title; })',
  'await tab.playwright.evaluate(() => { // new MouseEvent()\n return document.title; })',
  'await tab.playwright.evaluate(() => /el.value = 1; new Event(); fetch()/.test(document.title))',
  'await tab.playwright.evaluate(() => /["\/]click()/.test(document.title))',
  'await tab.playwright.evaluate(() => document.title.replace(/\\s+/g, " "))',
  'await tab.playwright.evaluate(() => { const a = 4, b = 2; return a/2 + b/2; })',
  'await tab.playwright.evaluate(() => { const done = 1, total = 2; return done/total*100; })',
  'await tab.playwright.evaluate(() => `el.click() ${document.title}`)',
  'await tab.playwright.evaluate(() => { const result = {}; result.value = document.title; return result; })',
  'await tab.playwright.evaluate(() => { const result = { click() { return document.title; } }; return result.click(); })',
  'await tab.playwright.evaluate(() => { const result = { nested: {} }; result.nested.value = document.title; return result; })',
  'await tab.playwright.evaluate(() => { const result = {}; const copy = result; copy.value = document.title; return copy; })',
  'await tab.playwright.evaluate(() => { const result = JSON.parse(document.title); result.value = "x"; return result; })',
  'await tab.playwright.evaluate(() => { const punctuation = ["}", ";", ",", "function"]; return punctuation; })',
  'await tab.playwright.evaluate(() => { const Event = class {}; return new Event(); })',
  'function read() { return document.title; } await tab.click(1); await tab.playwright.evaluate(read)',
  'await tab.playwright.evaluate(() => { const data = { Event: class {} }; return new data.Event(); })',
  'await tab.playwright.locator("input").evaluate(el => el.value)',
  'await tab.playwright.evaluate(() => { let value = document.title; value = value.trim(); return value; })',
  'await tab.playwright.evaluate(() => document.body.getAttribute("onclick"))',
  'await tab.playwright.evaluate(() => { const s = "a"; return s === "fetch()"; })',
  'await tab.playwright.evaluate(() => { const t = `new Event()`; return t; }, { value: "el.click()" })',
  'await tab.playwright.locator("input").fill("x")',
  'await app.click(12)',
];
for (const [index, code] of reads.entries()) test(`read ${index + 1} stays allowed`, () => assert.equal(evaluateWrite(code), undefined));

for (const code of [
  'await tab.playwright.evaluate(() => `${document.body.innerHTML = ""}`)',
  'await tab.playwright.evaluate(() => { const el = document.querySelector("input"); el["value"] = "x"; })',
  'await tab.playwright.locator("input").evaluate(el => el.value = "x")',
  'await tab.playwright.evaluate(function () { document.body.click(); })',
  'const change = () => { document.body.click(); }; await tab.playwright.evaluate(change)',
  'function change() { document.body.click(); } await tab.playwright.evaluate(change)',
  'await tab.playwright["evaluate"](() => document.body.click())',
  'await tab.playwright.evaluate(() => { const r = /["\/]click()/; document.body.click(); })',
  'await tab.playwright.evaluate(() => { const x = 2/2; document.body.click(); })',
  'await tab.playwright.evaluate(() => { const s = ";"; document.body.click(); })',
  'await tab.playwright.evaluate(() => { const s = "}"; document.body.click(); })',
  'await tab.playwright.evaluate(() => new window.MouseEvent("mousedown"))',
  'await tab.playwright.evaluate(() => new globalThis.CustomEvent("change"))',
  'await tab.playwright.evaluate(() => document.body.click?.())',
  'await tab.playwright.evaluate?.(() => document.body.click())',
]) test(`nested and named callback write: ${code}`, () => assert.ok(evaluateWrite(code)));

function harness(t) {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], replies = [];
  for (const [stream, messages] of [[serverIn, sent], [clientOut, replies]]) {
    stream.setEncoding('utf8').on('data', data => data.trim().split('\n').filter(Boolean).forEach(line => messages.push(JSON.parse(line))));
  }
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'evaluate-preflight', changeReview: false });
  t.after(() => relay.dispose());
  return { sent, replies, call: (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n') };
}

test('preflight refuses the whole call before any engine or acquisition-prefix call', t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Example"); await app.click(1);\nawait tab.playwright.evaluate(() => document.body.click())');
  assert.equal(h.sent.length, 0);
  assert.equal(h.replies.length, 1);
  assert.equal(h.replies[0].result.isError, true);
  assert.match(h.replies[0].result.content[0].text, /Line 2:.*Rejected before the engine call/);
  h.call(2, 'await tab.playwright.evaluate(() => document.title)');
  assert.equal(h.sent.length, 1, 'the refused call does not leave the relay blocked');
});

test('a pure read is forwarded with its callback unchanged', t => {
  const h = harness(t), code = 'await tab.playwright.evaluate(() => document.title.replace(/\\s+/g, " "))';
  h.call(1, code);
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].params.arguments.code.includes(code));
});
