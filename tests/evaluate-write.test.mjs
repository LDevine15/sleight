import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { evaluateWrite } from '../plugins/sleight/lib/evaluate-write.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const writes = [
  ['document.querySelector("input").value = "x"', 'fill'],
  ['document.querySelector("input").checked = true', 'setChecked'],
  ['document.body.innerHTML = ""', 'tab.getAXState()'],
  ['document.querySelector("button").click()', 'click'],
  ['document.body.dispatchEvent(new Event("change"))', 'tab.getAXState()'],
  ['new CustomEvent("change")', 'tab.getAXState()'],
  ['new PointerEvent("pointerdown")', 'tab.getAXState()'],
  ['new MouseEvent("mousedown")', 'tab.getAXState()'],
  ['new KeyboardEvent("keydown")', 'tab.getAXState()'],
  ['new DragEvent("dragstart")', 'dragTo'],
  ['new DataTransfer()', 'dragTo'],
  ['fetch("/submit", { method: "POST" })', 'tab.getAXState()'],
  ['document.body.setAttribute("value", "x")', 'fill'],
  ['document.body.appendChild(document.querySelector("li"))', 'dragTo'],
  ['document.body.insertBefore(document.querySelector("li"), null)', 'dragTo'],
  ['document.body.removeChild(document.querySelector("li"))', 'dragTo'],
  ['document.body.replaceChild(document.querySelector("li"), document.body.firstChild)', 'dragTo'],
  ['document.body.scrollTop = 2', 'scroll'],
  ['document.querySelector("select").selectedIndex = 2', 'selectOption'],
  ['document.querySelector("form").onsubmit = () => false', 'tab.getAXState()'],
  ['window.fetch = async () => ({ ok: true })', 'tab.getAXState()'],
  ['document.querySelector("form").addEventListener("submit", () => {})', 'tab.getAXState()'],
  ['document.createEvent("MouseEvents")', 'tab.getAXState()'],
];
for (const [statement, action] of writes) test(`evaluate refuses ${statement}`, () => {
  const notice = evaluateWrite(`const pw = tab.playwright;\nawait pw.evaluate(() => {\n  ${statement};\n});`);
  assert.match(notice, /Line 3:/);
  assert.match(notice, /evaluate.*read-only/);
  assert.ok(notice.includes(action), notice);
});

test('scroll preflight names no unverified action and never prints undefined advice', () => {
  const notice = evaluateWrite('await tab.playwright.evaluate(() => document.body.scrollTop = 2)');
  assert.match(notice, /scrollTop cannot run there/);
  assert.doesNotMatch(notice, /\.ax\.|Use |undefined/);
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

for (const source of [
  'new KeyboardEvent("keyup", {key:"ArrowDown"})',
  'new CustomEvent("reorder")',
  'document.body.dispatchEvent(new Event("change"))',
]) test(`an event without a known input intent explains the boundary: ${source}`, t => {
  const h = harness(t);
  h.call(1, `await tab.playwright.evaluate(() => { ${source}; })`);
  assert.equal(h.sent.length, 0);
  const text = h.replies[0].result.content[0].text;
  assert.match(text, /evaluate is read-only/);
  assert.doesNotMatch(text, /locator\.click|locator\.fill|pressKey/);
});

for (const source of [
  'fetch = async () => ({ok:true})',
  'document.querySelector("li").draggable = true',
  'document.body.append(document.querySelector("li"))',
  'document.body.style.cssText = "color:red"',
]) test(`unsupported page mutation is rejected before the engine: ${source}`, t => {
  const h = harness(t);
  h.call(1, `await tab.playwright.evaluate(() => { ${source}; })`);
  assert.equal(h.sent.length, 0);
  assert.equal(h.replies[0].result.isError, true);
  assert.match(h.replies[0].result.content[0].text, /evaluate is read-only.*Rejected before the engine call/);
  assert.doesNotMatch(h.replies[0].result.content[0].text, /locator\.click|locator\.fill|sleight\.dragTo/);
});

test('callback-local fetch and drag data remain ordinary read-only computation', () => {
  for (const source of [
    'const fetch = 1; fetch = 2; return fetch',
    'const data = {}; data.draggable = true; data.cssText = "x"; return data',
    'return document.querySelector("li").draggable',
  ]) assert.equal(evaluateWrite(`await tab.playwright.evaluate(() => { ${source}; })`), undefined);
  for (const callback of ['fetch => { fetch = 2; return fetch; }',
    '(fetch) => { fetch = 2; return fetch; }', 'function (fetch) { fetch = 2; return fetch; }']) {
    assert.equal(evaluateWrite(`await tab.playwright.evaluate(${callback}, 1)`), undefined);
  }
});

for (const method of ['append', 'prepend', 'replaceWith', 'remove', 'insertAdjacentHTML']) {
  test(`local ${method} computes a value without a page mutation`, () => {
    const body = `class Local { ${method}(value) { return value; } }
      const data = new Local(); return data.${method}('read-only computation');`;
    assert.equal(new Function(body)(), 'read-only computation');
    assert.equal(evaluateWrite(`await tab.playwright.evaluate(() => { ${body} });`), undefined);
  });
  test(`known DOM ${method} still refuses through a page alias`, () => {
    const source = `const container = document.body; container.${method}('value');`;
    assert.match(evaluateWrite(`await tab.playwright.evaluate(() => { ${source} });`), /cannot run there/);
  });
}
test('an uncertain collection receiver reaches the actual read-only engine boundary', () => {
  assert.equal(evaluateWrite('await tab.playwright.evaluate(() => collection.append("value"))'), undefined);
});

for (const helper of [
  'const identity = fetch => fetch;',
  'const identity = (fetch) => { return fetch; };',
  'function identity(fetch) { return fetch; }',
  'const identity = function(fetch) { return fetch; };',
  'const identity = ({fetch}) => fetch;',
  'const identity = ({fetch: value}) => value;',
  'const identity = (value = fetch) => value;',
  'const identity = fetch => fetch\n',
]) test(`a nested parameter does not hide an outer global fetch: ${helper.trim()}`, () => {
  assert.match(evaluateWrite(`await tab.playwright.evaluate(() => { ${helper}\n return fetch('/fixture'); });`) ?? '', /fetch cannot run there/);
});
test('a nested fetch parameter does not hide a global fetch assignment', () => {
  const code = 'await tab.playwright.evaluate(() => { const identity = fetch => fetch; fetch = () => 1; })';
  assert.match(evaluateWrite(code) ?? '', /fetch cannot run there/);
});
test('a local fetch parameter does not shadow window.fetch', () => {
  assert.match(evaluateWrite('await tab.playwright.evaluate(fetch => window.fetch("/fixture"), 1)') ?? '', /fetch cannot run there/);
});
for (const callback of [
  'fetch => fetch("local")',
  '(fetch) => { return fetch("local"); }',
  'function(fetch) { return fetch("local"); }',
  '({fetch}) => fetch("local")',
  '({value: fetch}) => { fetch = 2; return fetch; }',
  '(fetch = 1) => { fetch = 2; return fetch; }',
]) test(`fetch stays local inside its own parameter scope: ${callback}`, () => {
  const code = `await tab.playwright.evaluate(() => { const identity = ${callback}; return 1; })`;
  assert.equal(evaluateWrite(code), undefined);
});
test('a named outer callback retains its local parameter scope', () => {
  const code = 'function read(fetch) { fetch = 2; return fetch; } await tab.playwright.evaluate(read, 1)';
  assert.equal(evaluateWrite(code), undefined);
});
test('the relay forwards local computation but refuses global fetch before an engine call', t => {
  const h = harness(t), local = `await tab.playwright.evaluate(() => {
    class Local { append(value) { return value; } }
    const data = new Local(); return data.append('local');
  });`;
  h.call(1, local);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].method, 'tools/call');
  assert.equal(h.sent[0].params.name, 'js');
  assert.ok(h.sent[0].params.arguments.code.includes(local));
  h.call(2, 'await tab.playwright.evaluate(() => { const identity = fetch => fetch; return fetch("/fixture"); })');
  assert.equal(h.sent.length, 1);
  assert.match(h.replies.find(row => row.id === 2)?.result.content[0].text ?? '', /fetch cannot run there/);
});
test('the relay keeps a confirmed DOM append refusal before any engine request', t => {
  const h = harness(t);
  h.call(1, 'await tab.playwright.evaluate(() => { const el = document.body; el.append("value"); })');
  assert.equal(h.sent.length, 0);
  assert.match(h.replies[0].result.content[0].text, /append cannot run there/);
});

for (const body of [
  "const identity = fetch => fetch\nfetch('/fixture')\nreturn document.title;",
  "const identity = fetch => fetch\nfetch = () => 1; return document.title;",
]) test('Q1-2R2 ASI ends a helper parameter before a global call or assignment: '+body.split('\n')[1], t => {
  assert.equal(typeof new Function(body),'function');
  const code=`await tab.playwright.evaluate(() => { ${body} });`;
  assert.match(evaluateWrite(code)??'',/fetch cannot run there/);
  const h=harness(t);h.call(1,code);
  assert.equal(h.sent.length,0,'a confirmed write must never reach the fake engine');
  assert.equal(h.replies[0].result.isError,true);
});
for (const expression of [
  "fetch\n('/fixture')", "fetch\n?.('/fixture')", "fetch\n['value']", "fetch\n+ fetch('/fixture')",
  "fetch\n? fetch('/fixture')\n: 'none'", "fetch\n= () => 1", "fetch\n`fixture`",
  "Promise.resolve(fetch)\n.then(fetch => fetch('/fixture'))",
]) test('Q1-2R2 real multiline expression remains inside its parameter scope: '+expression, t=>{
  const code=`await tab.playwright.evaluate(() => {const helper = fetch => ${expression}; return document.title;});`;
  assert.equal(evaluateWrite(code),undefined);const h=harness(t);h.call(1,code);
  assert.equal(h.sent.length,1);assert.ok(h.sent[0].params.arguments.code.includes(code));
});

for (const expression of ["fetch\n+ fetch('/fixture')","fetch\n?.('/fixture')","fetch\n['value']","fetch\n`fixture`"]) test('Q1-2R2 outer callback retains a complete multiline expression: '+expression,t=>{
  const code=`await tab.playwright.evaluate(fetch => ${expression})`;
  assert.equal(evaluateWrite(code),undefined);const h=harness(t);h.call(1,code);assert.equal(h.sent.length,1);
});

for (const [name, expression, fields] of [
  ['private field', 'this.#value', '#value = 1;'],
  ['super property', 'super.value', ''],
]) for (const global of ["fetch('/fixture');", 'fetch = () => 1;']) {
  test(`Q1-2R3 class-context helper does not shadow a following global: ${name}, ${global}`, t => {
    const code = `await tab.playwright.evaluate(() => {
      class Box extends Object { ${fields} run() {
        const identity = fetch => ${expression}
        ${global}
      }}
      new Box().run(); return document.title;
    });`;
    assert.equal(typeof new Function('return async () => {' + code + '}'), 'function');
    assert.match(evaluateWrite(code) ?? '', /fetch cannot run there/);
    const h = harness(t); h.call(1, code);
    assert.equal(h.sent.length, 0); assert.equal(h.replies[0].result.isError, true);
  });
}
for (const [name, expression, fields] of [
  ['private field', 'this.#value', '#value = 1;'],
  ['private multiline', "this.#value\n+ fetch('/local')", '#value = 1;'],
  ['super property', 'super.toString', ''],
  ['super multiline', "super.toString\n.call(fetch('/local'))", ''],
  ['unicode private field', "this.#café\n+ fetch('/local')", '#café = 1;'],
  ['private tagged template', 'this.#value\n`local`', '#value = value => value;'],
]) test('Q1-2R3 class-local expression retains its parameter scope: ' + name, t => {
  const code = `await tab.playwright.evaluate(() => {
    class Box extends Object { ${fields} run() { const identity = fetch => ${expression}; return identity; } }
    return new Box().run();
  });`;
  assert.equal(typeof new Function('return async () => {' + code + '}'), 'function');
  assert.equal(evaluateWrite(code), undefined);
  const h = harness(t); h.call(1, code);
  assert.equal(h.sent.length, 1); assert.ok(h.sent[0].params.arguments.code.includes(code));
});
test('Q1-2R3 boundary parsing never executes the surrounding program', () => {
  const code = "throw Error('outer code ran'); await tab.playwright.evaluate(() => { const identity = fetch => fetch\nfetch('/fixture'); });";
  assert.match(evaluateWrite(code) ?? '', /fetch cannot run there/);
});
