import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { BrowserRecovery } from '../plugins/sleight/lib/browser-recovery.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const reply = (id = '7', url = 'https://example.test/page', extra = {}) => ({ result: {
  content: [{ type: 'text', text: `Browser tab: ${id}, Title: "Page", URL: "${url}".\n0 AXWebArea Page` }],
  _meta: { 'codex/toolSurface': { kind: 'browserUse' } }, ...extra,
} });
function known() {
  const recovery = new BrowserRecovery();
  recovery.observe('let b = await cua.getBrowser({ extensionInstanceId: "session-browser" });', reply());
  recovery.observe('let tab = await cua.createBrowserTab(b.browserId, "https://example.test/page");', reply());
  return recovery;
}
function runtime(tabs = [{ id: '7', url: 'https://example.test/page' }]) {
  const calls = [], notes = [];
  const browser = { browserId: 'actual-browser', tabs: {
    list: async () => tabs,
    get: async id => { calls.push(['tab', id]); return { id, getAXState: async () => 'read', click: async index => calls.push(['click', id, index]) }; },
  } };
  const cua = {
    getBrowser: async selector => { calls.push(['browser', selector]); return browser; },
    getTab: async (...args) => { calls.push(['getTab', ...args]); return { id: args[0] }; },
  };
  return { context: createContext({ cua, nodeRepl: { write: text => notes.push(text) } }), calls, notes };
}
const run = (context, code) => runInContext('(async () => { ' + code + '\n})()', context);

test('after reset, restores only the observed browser and tab before the caller runs', async () => {
  const recovery = known(), h = runtime();
  recovery.reset();
  await run(h.context, recovery.code('nodeRepl.write(await tab.getAXState());'));
  assert.equal(h.context.b, undefined);
  assert.equal(h.context.tab.id, '7');
  assert.equal(h.calls.filter(c => c[0] === 'tab').length, 1);
  assert.match(h.notes[0], /restored session handles tab/);
  assert.equal(h.notes.at(-1), 'read');
});

test('a reused id with another URL fails before binding or caller input', async () => {
  const recovery = known(), h = runtime([{ id: '7', url: 'https://other.test' }]);
  recovery.reset();
  await assert.rejects(run(h.context, recovery.code('await tab.click(1);')), /gone or changed/);
  assert.equal(h.context.tab, undefined);
  assert.equal(h.calls.some(c => c[0] === 'tab'), false);
});

test('never restores a tab from an unsuccessful, native or unrelated reply', async () => {
  for (const result of [reply('7', undefined, { isError: true }), { result: { content: reply().result.content } }, reply('8')]) {
    const recovery = new BrowserRecovery();
    recovery.observe('let b = await cua.getBrowser({ id: "one" });', reply());
    recovery.observe('let tab = await b.tabs.get("7");', result);
    recovery.reset();
    assert.equal(recovery.code('await tab.getAXState();'), 'await tab.getAXState();');
  }
});

test('caller declarations retain their code and native calls are unchanged', () => {
  const recovery = known(); recovery.reset();
  for (const code of ['let tab = await b.tabs.get("9");', 'const b = await cua.getBrowser({id:"two"});']) assert.ok(recovery.code(code).endsWith(code));
  const native = 'let app = await cua.getApp("Editor"); await app.click(1);';
  assert.equal(recovery.code(native), native);
});

test('getTab by URL searches only observed tabs in the session browsers', async () => {
  const recovery = known(), h = runtime([{ id: '7', url: 'https://example.test/page' }, { id: '8', url: 'https://foreign.test' }]);
  await run(h.context, recovery.code('let url = "https://example.test/page"; nodeRepl.write((await cua.getTab({url})).id);'));
  assert.equal(h.notes.at(-1), '7');
  assert.ok(h.calls.some(c => c[0] === 'getTab' && c[1] === '7' && c[2].browser === 'actual-browser'));
  await assert.rejects(run(h.context, recovery.code('await cua.getTab({url:"https://foreign.test"});')), /session tab/);
});

test('an explicit browser option is passed through unchanged', async () => {
  const recovery = known(), h = runtime();
  await run(h.context, recovery.code('await cua.getTab({url:"https://other.test"},{browser:"explicit"});'));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][2].browser, 'explicit');
});

test('repeated engine docs mark recovery pending without replaying the failed call', async () => {
  const recovery = known();
  const docs = { result: { content: [{ type: 'text', text: '## Computer Use\nDocs' }] } };
  recovery.observe('await tab.getAXState();', docs);
  recovery.observe('await tab.click(1);', docs);
  const h = runtime();
  await run(h.context, recovery.code('nodeRepl.write(await tab.getAXState());'));
  assert.equal(h.context.tab.id, '7');
  assert.equal(h.calls.filter(c => c[0] === 'tab').length, 1);
});

test('comments and strings cannot establish a browser or tab binding', () => {
  const recovery = new BrowserRecovery();
  recovery.observe('// let b = await cua.getBrowser({id:"one"});\n"let tab = await b.tabs.get(\"7\");"', reply());
  recovery.reset();
  assert.equal(recovery.code('await tab.click(1);'), 'await tab.click(1);');
});

test('ambiguous syntax and nested bindings do not become recovery records', () => {
  for (const code of ['const re = /let b = await cua.getBrowser({id:"fake"})/;',
    'async function other() { let b = await cua.getBrowser({id:"fake"}); }',
    '`let b = await cua.getBrowser({id:"fake"})`']) {
    const recovery = new BrowserRecovery();
    recovery.observe(code, reply());
    recovery.observe('let tab = await cua.createBrowserTab(b.browserId, "https://example.test/page");', reply());
    recovery.reset();
    assert.equal(recovery.code('await tab.click(1);'), 'await tab.click(1);');
  }
});

test('emoji before a binding does not change the source offsets', async () => {
  const recovery = new BrowserRecovery(), h = runtime();
  recovery.observe('"🧪"; let b = await cua.getBrowser({id:"one"});', reply());
  recovery.observe('let tab = await b.tabs.get("7");', reply());
  recovery.reset();
  await run(h.context, recovery.code('await tab.getAXState();'));
  assert.equal(h.context.tab.id, '7');
});

test('URL lookup refuses duplicate observed matches across browsers', async () => {
  const recovery = known(), h = runtime();
  recovery.observe('let other = await cua.getBrowser({id:"second"});', reply());
  recovery.observe('let secondTab = await other.tabs.get("7");', reply());
  await assert.rejects(run(h.context, recovery.code('await cua.getTab({url:"https://example.test/page"});')), /exactly one/);
  assert.equal(h.calls.some(c => c[0] === 'getTab'), false);
});

test('the relay records confirmed pairs and restores after js_reset', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => relay.close());
  const call = (id, code, name = 'js') => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n');
  const result = (id, data) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, ...data }) + '\n');
  call(1, 'let b = await cua.getBrowser({id:"one"});'); result(1, reply());
  call(2, 'let tab = await b.tabs.get("7");'); result(2, reply());
  call(3, '', 'js_reset'); result(3, { result: { content: [] } });
  call(4, 'await tab.getAXState();');
  assert.match(sent.find(m => m.id === 4).params.arguments.code, /restored session handles/);
});

test('a missing handle marks recovery for the next call without replaying input', async () => {
  const recovery = known(), h = runtime();
  recovery.observe('await tab.click(1);', { result: { isError: true, content: [{ type: 'text', text: 'ReferenceError: tab is not defined' }] } });
  await run(h.context, recovery.code('nodeRepl.write(await tab.getAXState());'));
  assert.equal(h.context.tab.id, '7');
  assert.equal(h.notes.at(-1), 'read');
});

test('malformed header strings cannot crash identity observation', () => {
  const recovery = new BrowserRecovery();
  recovery.observe('let b = await cua.getBrowser({id:"one"});', reply());
  assert.doesNotThrow(() => recovery.observe('let tab = await b.tabs.get("7");', {
    result: { _meta: { 'codex/toolSurface': { kind: 'browserUse' } },
      content: [{ type: 'text', text: 'Browser tab: 7, Title: "Page", URL: "\\x".' }] },
  }));
  recovery.reset();
  assert.equal(recovery.code('await tab.click(1);'), 'await tab.click(1);');
});

test('reset restores tab from its own record when another tab was read last', async () => {
  const recovery = known(), h = runtime([{ id:'7',url:'https://example.test/page' },{ id:'8',url:'https://example.test/other' }]);
  recovery.observe('let other = await b.tabs.get("8");',reply('8','https://example.test/other'));
  recovery.reset();
  await run(h.context,recovery.code('await tab.click(2);'));
  assert.equal(h.context.tab.id,'7');
  assert.deepEqual(h.calls.at(-1),['click','7',2]);
});

test('reset restores b independently from the browser of the most recent tab', async () => {
  const recovery = known(), h = runtime();
  recovery.observe('let otherBrowser = await cua.getBrowser({id:"second"});',reply());
  recovery.observe('let other = await otherBrowser.tabs.get("8");',reply('8','https://example.test/other'));
  const original = h.context.cua.getBrowser;
  h.context.cua.getBrowser = async selector => selector.id === 'second' ? {
    browserId:'second-browser',tabs:{list:async()=>[{id:'8',url:'https://example.test/other'}],get:async id=>({id})},
  } : original(selector);
  recovery.reset();
  await run(h.context,recovery.code('nodeRepl.write(b.browserId);'));
  assert.equal(h.context.b.browserId,'actual-browser');
  assert.equal(h.context.tab,undefined);
});

for (const name of ['b','tab']) test(`an unknown ${name} redeclaration removes only that recovery record`, async () => {
  const recovery = known(), h = runtime();
  recovery.observe(`let ${name} = unknownCall();`,{result:{content:[{type:'text',text:'unknown result'}]}});
  recovery.reset();
  await run(h.context,recovery.code(`nodeRepl.write(typeof ${name});`));
  assert.equal(h.context[name],undefined);
});

for (const code of ['tab = await b.tabs.get("8");', 'b = await cua.getBrowser({id:"second"});',
  '({tab} = unknownCall());', '[b] = unknownCall();', '({outer:{tab}} = unknownCall());',
  '({target: b = fallback} = unknownCall());', 'tab ||= unknownCall();', 'globalThis.tab = unknownCall();']) {
  test(`successful reassignment discards the changed recovery record: ${code}`, async () => {
    const recovery=known(), h=runtime();
    const name=/\bb\b/.test(code)&&!code.startsWith('tab')?'b':'tab';
    recovery.observe(code,reply('8','https://example.test/other'));
    recovery.reset();
    await run(h.context,recovery.code(`nodeRepl.write(typeof ${name});`));
    assert.equal(h.context[name],undefined);
  });
}

test('a stale tab record cannot prevent recovery of a referenced browser', async () => {
  const recovery=known(), h=runtime([]); recovery.reset();
  await run(h.context,recovery.code('nodeRepl.write(b.browserId);'));
  assert.equal(h.context.b.browserId,'actual-browser');
  assert.equal(h.context.tab,undefined);
  assert.equal(h.calls.some(call=>call[0]==='tab'),false);
});

for(const code of ['nodeRepl.write(`unrelated`);', 'const match = /x/.test("x");',
  'const ratio = 4 / 2; nodeRepl.write(ratio);', 'let note = `another value`;']) {
  test(`untrackable code without handle mutations preserves both records: ${code}`, async () => {
    const recovery=known(), h=runtime(); recovery.observe(code,reply()); recovery.reset();
    await run(h.context,recovery.code('nodeRepl.write(b.browserId); nodeRepl.write(await tab.getAXState());'));
    assert.equal(h.context.b.browserId,'actual-browser'); assert.equal(h.context.tab.id,'7');
  });
}

test('an untrackable assignment discards only the assigned handle', async () => {
  const recovery=known(), h=runtime(); recovery.observe('tab = await b.tabs.get(`8`);',reply('8','https://example.test/other')); recovery.reset();
  await run(h.context,recovery.code('nodeRepl.write(b.browserId); nodeRepl.write(typeof tab);'));
  assert.equal(h.context.b.browserId,'actual-browser'); assert.equal(h.context.tab,undefined);
});

for (const declaration of ['const { tab } = { tab: {id:"fresh"} }', 'let [tab] = [{id:"fresh"}]',
  'const { source: tab } = {source:{id:"fresh"}}', 'const { outer: { tab } } = {outer:{tab:{id:"fresh"}}}',
  'const { tab = {id:"fresh"} } = {}', 'var { tab } = {tab:{id:"fresh"}}',
  'let other = 1, tab = {id:"fresh"}', 'class tab {}', 'function tab() {}']) {
  test(`caller declaration is never probed or restored: ${declaration}`, async () => {
    const recovery = known(), h = runtime(); recovery.reset();
    await run(h.context,recovery.code(`${declaration}; nodeRepl.write(typeof tab);`));
    assert.equal(h.context.tab,undefined);
    assert.equal(h.calls.some(call=>call[0] === 'tab'),false);
  });
}

test('recorded CDP timeout wording starts recovery for the next call', async () => {
  const recovery = known(), h = runtime();
  recovery.observe('await tab.getAXState();',{result:{isError:true,content:[{type:'text',text:'Timed out after 3000ms waiting for CDP command DOM.getDocument'}]}});
  await run(h.context,recovery.code('await tab.getAXState();'));
  assert.equal(h.context.tab.id,'7');
});

test('untrackable successful code cannot leave a stale name available for restoration', async () => {
  const recovery = known(), h = runtime();
  recovery.observe('let tab = await b.tabs.get(`8`);',reply('8','https://example.test/other'));
  recovery.reset();
  await run(h.context,recovery.code('nodeRepl.write(typeof tab);'));
  assert.equal(h.context.tab,undefined);
  assert.equal(h.calls.length,0);
});

for (const assignment of ['tab = await b.tabs.get("9")', 'globalThis.tab = await b.tabs.get("9")',
  '[tab] = [await b.tabs.get("9")]']) {
  test(`after reset an explicit assignment bypasses the old tab: ${assignment}`, async () => {
    const recovery = known(), h = runtime([]); recovery.reset();
    await run(h.context, recovery.code(`${assignment}; nodeRepl.write(await tab.getAXState());`));
    assert.equal(h.context.b.browserId, 'actual-browser');
    assert.equal(h.context.tab.id, '9');
    assert.deepEqual(h.calls.filter(c => c[0] === 'tab'), [['tab', '9']]);
    assert.equal(h.notes.at(-1), 'read');
  });
}

test('an explicit browser assignment bypasses its old browser record', async () => {
  const recovery = known(), h = runtime(); recovery.reset();
  const code = 'b = await cua.getBrowser({id:"fresh"}); nodeRepl.write(b.browserId);';
  assert.equal(recovery.code(code), code);
  await run(h.context, recovery.code(code));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1].id, 'fresh');
});

for (const [code, name] of [
  ['let b = await cua.getBrowser({id:"old"}); b = await cua.getBrowser({id:"fresh"});', 'b'],
  ['let tab = await b.tabs.get("7"); tab = unknownTab();', 'tab'],
]) {
  test(`a later assignment wins over a factory declaration of ${name}`, () => {
    const recovery = known(); recovery.observe(code, reply());
    assert.equal(recovery[name === 'b' ? 'browsers' : 'tabs'].has(name), false);
  });
}

test('factory declarations without later assignments still establish recoverable handles', () => {
  const recovery = known();
  assert.equal(recovery.browsers.get('b').extensionInstanceId, 'session-browser');
  assert.equal(recovery.tabs.get('tab').id, '7');
});
