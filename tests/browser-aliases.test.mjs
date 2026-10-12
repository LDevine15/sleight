import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { browserAliasesCode, createBrowserAliasNotices } from '../plugins/sleight/lib/browser-aliases.mjs';
import { createRelay, unawaitedAction } from '../plugins/sleight/lib/relay.mjs';

function fixture() {
  const calls = [], notes = [], locators = new Map();
  const locator = label => {
    if (locators.has(label)) return locators.get(label);
    const loc = { label, click: async () => calls.push(['click', label]), evaluate: async () => label,
      filter: options => { assert.equal(options.has, locator('target')); return loc; },
      nth: i => locator(label + i), first: () => loc, all: async () => [loc, locator('other')],
      locator: value => locator(value), getByText: value => locator(value) };
    locators.set(label, loc); return loc;
  };
  const playwright = { evaluate: async (...args) => { calls.push(['evaluate', ...args]); return 'value'; },
    waitForTimeout: async (...args) => calls.push(['timeout', ...args]),
    waitForLoadState: async (...args) => calls.push(['load', ...args]),
    locator, getByRole: locator, getByText: locator, getByLabel: locator };
  const tab = { id: '1', playwright, pressKey: async (...args) => calls.push(['key', ...args]),
    getAXState: async () => 'state' };
  const cua = { getTab: async () => tab, createBrowserTab: async () => tab,
    getBrowser: async () => ({ tabs: { get: async () => tab, new: async () => tab } }),
    getApp: async () => ({ click: async () => calls.push(['native']) }) };
  const context = createContext({ cua, nodeRepl: { write: value => notes.push(value) },
    sleight: { dragTo: async (t, from, to) => { assert.equal(t, tab); calls.push(['drag', from.label, to.label]); return 'moved'; } } });
  const run = code => runInContext(`(async () => { ${browserAliasesCode(code)} })()`, context);
  return { calls, notes, run, context, tab, cua };
}

for (const name of ['evaluate', 'locator', 'getByRole', 'getByText', 'getByLabel', 'waitForTimeout', 'waitForLoadState']) {
  test(`tab.${name} forwards to the real Playwright method`, async () => {
    const f = fixture();
    await f.run(`var tab = await cua.getTab('1'); await tab.${name}('value');`);
    assert.match(f.notes.join('\n'), new RegExp(`tab\\.${name}.*tab\\.playwright\\.${name}`));
  });
}

test('playwright.press forwards a key with the required null element index', async () => {
  const f = fixture();
  await f.run("var tab = await cua.getTab('1'); await tab.playwright.press('ArrowDown', { delay: 20 });");
  assert.equal(f.calls[0][0], 'key'); assert.equal(f.calls[0][1], null); assert.equal(f.calls[0][2], 'ArrowDown');
  assert.equal(f.calls[0][3].delay, 20);
  assert.match(f.notes[0], /tab.pressKey\(null, key\)/);
});

test('locator chains, all arrays and filter arguments retain raw locator identity', async () => {
  const f = fixture();
  await f.run("var tab = await cua.getTab('1'); var target = tab.playwright.locator('target'); var source = tab.getByText('source').filter({has:target}).first(); var items = await source.all(); await items[0].dragTo(target);");
  assert.deepEqual(f.calls, [['drag', 'source', 'target']]);
  assert.match(f.notes.join('\n'), /locator.dragTo.*sleight.dragTo/);
});

test('forwarding notes appear once per session and preserve real methods', async () => {
  const f = fixture();
  await f.run("globalThis.tab = await cua.getTab('1'); await tab.waitForTimeout(1); await tab.waitForTimeout(2);");
  await f.run('await tab.waitForTimeout(3); await tab.pressKey(null, "Enter");');
  assert.equal(f.notes.length, 1);
  assert.equal(f.calls.at(-1)[2], 'Enter');
});

for (const source of ["await cua.createBrowserTab('b')", "await (await cua.getBrowser({id:'b'})).tabs.new()", "await (await cua.getBrowser({id:'b'})).tabs.get('1')"]) {
  test(`tab aliases survive acquisition through ${source}`, async () => {
    const f = fixture();
    await f.run(`var tab = ${source}; await tab.getByLabel('source').click();`);
    assert.deepEqual(f.calls, [['click', 'source']]);
  });
}

for (const [code, hint] of [
  ['await cua.getAXState()', /tab.getAXState\(\).*app.getAXState\(\)/],
  ['await cua.readBrowserTab()', /tab.getAXState\(\)/],
  ['await cua.getTabState()', /tab.getAXState\(\)/],
  ['await tab.readState()', /tab.getAXState\(\)/],
  ['await tab.readDOMState()', /tab.playwright.domSnapshot\(\)/],
  ['await tab.waitForLoad()', /tab.playwright.waitForLoadState/],
  ['await tab.playwright.keyboard.press("Enter")', /tab.pressKey\(null, key\)/],
  ['await tab.playwright.mouse.move(1,2)', /sleight.dragTo/],
  ['await tab.playwright.locator("source").hover()', /locator.click/],
  ['await tab.playwright.locator("source").boundingBox()', /locator.evaluate/],
]) test(`${code} names a real next call instead of an undefined API`, async () => {
  const f = fixture();
  await assert.rejects(f.run(`var tab = await cua.getTab('1'); ${code};`), hint);
  assert.deepEqual(f.calls, []);
});

test('native handles and existing APIs are unchanged', async () => {
  const f = fixture();
  await f.run('var app = await cua.getApp("Example"); await app.click(1);');
  assert.deepEqual(f.calls, [['native']]); assert.deepEqual(f.notes, []);
});

test('evaluate aliases keep the engine read-only refusal', async () => {
  const f = fixture();
  f.tab.playwright.evaluate = async () => { throw new Error('read-only scope'); };
  await assert.rejects(f.run("var tab = await cua.getTab('1'); await tab.evaluate(() => 1);"), /read-only scope/);
  assert.match(f.notes[0], /tab.playwright.evaluate/);
});

test('locators from different tabs cannot be dragged together', async () => {
  const f = fixture();
  const other = { ...f.tab, id: '2', playwright: { ...f.tab.playwright } };
  f.cua.getTab = async id => id === '1' ? f.tab : other;
  await assert.rejects(f.run("var a = await cua.getTab('1'); var b = await cua.getTab('2'); await a.getByText('source').dragTo(b.getByText('target'));"), /same tab/);
  assert.deepEqual(f.calls, []);
});

test('relay notice filtering remains once per session across kernel resets', () => {
  const filter = createBrowserAliasNotices();
  const text = 'sleight: API alias tab.evaluate forwards to tab.playwright.evaluate.';
  assert.deepEqual(filter([{ type: 'text', text }]), [{ type: 'text', text }]);
  const image = { type: 'image', data: 'AA' };
  assert.deepEqual(filter([{ type: 'text', text: 'own\n' + text + '\nlast' }, image]), [{ type: 'text', text: 'own\nlast' }, image]);
});

test('relay installs the aliases and drag helper around a browser call', () => {
  const [clientIn, clientOut, serverIn, serverOut] = Array.from({ length: 4 }, () => new PassThrough());
  const sent = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  try {
    clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: "var tab = await cua.getTab('1'); await tab.getByText('source').dragTo(tab.getByText('target'));" } } }) + '\n');
    assert.match(sent.at(-1).params.arguments.code, /__sleightBrowserAliases/);
    assert.match(sent.at(-1).params.arguments.code, /globalThis.sleight.dragTo/);
  } finally { relay.dispose(); }
});

test('new press and dragTo aliases require await before following code', () => {
  for (const code of ['tab.playwright.press("ArrowDown"); more();', 'src.dragTo(dst); more();']) {
    assert.ok(unawaitedAction(code), code);
    assert.equal(unawaitedAction('await ' + code), undefined);
    assert.equal(unawaitedAction('return ' + code), undefined);
  }
  assert.equal(unawaitedAction('tab.playwright.press("ArrowDown")'), undefined);
  assert.ok(unawaitedAction('src.dragTo(dst).then(done); more();'));
});

test('a second string argument to playwright.press refuses before input', async () => {
  const f = fixture();
  await assert.rejects(f.run('var tab = await cua.getTab("1"); await tab.playwright.press("#input", "Enter");'), /locator.*press/);
  assert.deepEqual(f.calls, []);
});

for (const root of ['tab', 'tab.playwright']) test(`${root}.mouse.click points to clicking, with the correct root`, async () => {
  const f = fixture();
  await assert.rejects(f.run(`var tab = await cua.getTab("1"); await ${root}.mouse.click(1,2);`), error => {
    assert.ok(error.message.includes(root + '.mouse.click'));
    assert.match(error.message, /tab.click|locator.click/);
    assert.doesNotMatch(error.message, /dragTo/);
    return true;
  });
});

test('missing mouse down and up do not suggest a drag', async () => {
  for (const action of ['down', 'up']) {
    const f = fixture();
    await assert.rejects(f.run(`var tab = await cua.getTab("1"); await tab.mouse.${action}();`), error => {
      assert.doesNotMatch(error.message, /dragTo/);
      return true;
    });
  }
});

test('a missing dev object stays absent, while an existing one can explain a missing method', async () => {
  const f = fixture();
  await f.run('globalThis.tab = await cua.getTab("1");');
  assert.equal(await f.run('return tab.dev;'), undefined);
  const g = fixture(); g.tab.dev = {};
  await assert.rejects(g.run('var tab = await cua.getTab("1"); await tab.dev.getNetworkActivity();'), /waitForLoadState/);
});

test('failed alias installation does not block a documented browser call', async () => {
  const f = fixture();
  f.context.cua = new Proxy(f.cua, { set() { throw Error('read-only browser API'); } });
  await f.run('var tab = await cua.getTab("1"); await tab.pressKey(null,"Return");');
  assert.equal(f.calls[0][0], 'key');
  assert.equal(f.calls[0][2], 'Return');
});
