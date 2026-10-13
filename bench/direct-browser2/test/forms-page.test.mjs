import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fillForm } from '../forms.mjs';
import { createFileAuthority } from '../files.mjs';

// Disposable headless fixture only. Never attaches to a user browser/profile.
const playwrightPath = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/mcp/node_modules/playwright-core/index.mjs');
const live = { skip: process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'set SLEIGHT_LIVE_DOM_TEST=1 for headless fixture pages' :
  !existsSync(playwrightPath) ? 'optional cached playwright-core is unavailable' : false };
const identity = {browserIncarnation:'fixture',brokerEpoch:1,clientSession:'fixture',turn:1,
  leaseGeneration:1,target:'owned',frame:'main',document:1,origin:'http://127.0.0.1'};
async function adapterFor(page) {
  const session = await page.context().newCDPSession(page);
  const refs = new Map(), backend = new Map(); let next = 1;
  const {root} = await session.send('DOM.getDocument', {depth:-1,pierce:true});
  function walk(node) {
    const attributes = Object.fromEntries(Array.from({length:(node.attributes?.length ?? 0)/2},(_,i)=>
      [node.attributes[i*2],node.attributes[i*2+1]]));
    if (attributes.id) { const ref=`r${next++}`; refs.set(attributes.id,ref); backend.set(ref,node.backendNodeId); }
    for (const child of [...(node.children ?? []),...(node.shadowRoots ?? [])]) walk(child);
  }
  walk(root);
  const selector = ref => `#${[...refs].find(([,v])=>v===ref)[0]}`;
  const adapter = { session,
    observe: async ref => {
      const state = await page.locator(selector(ref)).evaluate(el => {
        const kind = el.id === 'picker' ? 'date' : el.id === 'list' ? 'listbox' : el.id === 'switch' ? 'switch' :
          el.tagName === 'SELECT' ? 'select' : ['checkbox','number','date','file'].includes(el.type) ? el.type : 'text';
        return { kind, visible:!!(el.getClientRects().length), enabled:!el.disabled, readonly:!!el.readOnly,
          multiple:!!el.multiple || el.getAttribute('aria-multiselectable')==='true',
          protected:el.type==='password', source:el.id==='switch'?'page-reported':'native',
          value:el.type==='password'?null:kind==='checkbox'||kind==='switch'?el.checked:kind==='number'?el.valueAsNumber:
            kind==='select'&&el.multiple?[...el.selectedOptions].map(o=>o.value):kind==='listbox'?window.selections:el.value,
          valid:el.validity?.valid, options:el.options?[...el.options].map(o=>({value:o.value,label:o.label,disabled:o.disabled})):
            kind==='listbox'?[...el.querySelectorAll('[role=option]')].map(o=>({value:o.dataset.value,label:o.textContent})):undefined,
          strategies:kind==='switch'?['setChecked']:kind==='listbox'?['chooseOptions']:el.id==='picker'?['pickDate']:[],
          files:el.files?[...el.files].map(f=>({name:f.name,size:f.size})):undefined };
      });
      return {...identity,ref,node:backend.get(ref),...state};
    },
    authorize: async () => ({verdict:'allow'}), // public local fixture only
    dispatch: async (intent,fence) => {
      const loc=page.locator(selector(intent.ref));
      // Prepare actionability before the final fence. This fixture adapter
      // is not the production scoped adapter or a no-focus qualification.
      await loc.waitFor({state:'visible'});
      await fence();
      if (intent.action==='setChecked') {
        if (selector(intent.ref)==='#switch') {
          const {object} = await session.send('DOM.resolveNode',{backendNodeId:intent.node});
          const result=await session.send('Runtime.callFunctionOn',{objectId:object.objectId,
            functionDeclaration:'function(){ return this.getBoundingClientRect().toJSON(); }',returnByValue:true});
          const r=result.result.value;
          await session.send('Input.dispatchMouseEvent',{type:'mousePressed',x:r.x+5,y:r.y+5,button:'left',clickCount:1});
          await session.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:r.x+5,y:r.y+5,button:'left',clickCount:1});
        } else await loc.setChecked(intent.value);
      } else if (intent.action==='select') await loc.selectOption(intent.value);
      else if (intent.action==='chooseOptions') for (const value of intent.value)
        await loc.locator(`[data-value="${value}"]`).click();
      else if (intent.action==='pickDate') { await page.locator('#show-picker').click(); await page.locator('#day').click(); }
      else if (intent.action==='setFiles') {
        assert.ok(Array.isArray(intent.filePayloads));
        await loc.setInputFiles(intent.filePayloads);
      }
      else await loc.fill(String(intent.value));
    },
    // This fixture's prototype getter models private equality proof. It does
    // not qualify a trusted native/AX proof against a hostile page.
    proveProtected:async intent=>({matched:await page.locator(selector(intent.ref)).evaluate((el,value)=>
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').get.call(el)===value,intent.value),source:'native'}),
    waitForDependencies:async()=>{await page.locator('#languages').evaluate(el=>new Promise(resolve=>{
      const check=()=>el.disabled?setTimeout(check,1):resolve();check();}));},
  };
  return {adapter,refs};
}
async function fixture(t) {
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  // Same installed-shell fallback as tests/fill-form.test.mjs; no download.
  const executablePath = [chromium.executablePath(), ...[1234, 1228].map(version => join(homedir(),
    `Library/Caches/ms-playwright/chromium_headless_shell-${version}/chrome-headless-shell-mac-arm64/chrome-headless-shell`))]
    .find(path => existsSync(path));
  if (!executablePath) { t.skip('headless Chromium is not installed'); return; }
  const browser = await chromium.launch({ headless: true, executablePath });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('http://127.0.0.1/**', route => route.fulfill({ contentType: 'text/html',
    body: readFileSync(new URL('../fixtures/forms.html', import.meta.url), 'utf8') }));
  await page.goto('http://127.0.0.1/forms');
  return page;
}
test('ordinary, protected, date and dependent multi-select fill without submit',live, async t => {
  const page = await fixture(t);
  if (!page) return;
  const {adapter,refs}=await adapterFor(page);
  const fields=[['name','Public fixture'],['protected','public-secret'],['date',{date:'2026-10-13'}],
    ['country','B'],['languages',['C','D']]].map(([id,value])=>({ref:refs.get(id),value}));
  const receipt=await fillForm(adapter,{operation:'public',identity,fields});
  assert.deepEqual(receipt.fields.map(f=>f.status), ['verified','protected','verified','verified','verified']);
  assert.equal(await page.evaluate(()=>window.submits), 0);
  assert.ok(!JSON.stringify(receipt).includes('public-secret'));
});
test('readonly picker and custom listbox use observed controls',live, async t => {
  const page = await fixture(t);
  if (!page) return;
  const {adapter,refs}=await adapterFor(page);
  const receipt=await fillForm(adapter,{operation:'custom',identity,fields:[
    {ref:refs.get('picker'),value:{date:'2026-10-13'}},{ref:refs.get('list'),value:['B']}]});
  assert.equal(receipt.completed, 2);
  assert.deepEqual(receipt.fields.map(f=>f.status), ['verified','verified']);
});
test('closed-root getter reports page evidence and never toggles twice',live, async t => {
  const page = await fixture(t);
  if (!page) return;
  const {adapter,refs}=await adapterFor(page);
  const receipt=await fillForm(adapter,{operation:'switch',identity,fields:[{ref:refs.get('switch'),value:true}]});
  assert.equal(receipt.fields[0].status, 'unverifiable');
  assert.equal(await page.locator('#switch').evaluate(el=>el.checked), true);
});
test('autosave receives zero unapproved values and suffix stays untouched',live, async t => {
  const page = await fixture(t);
  if (!page) return;
  const {adapter,refs}=await adapterFor(page);
  adapter.authorize=async intent=>({verdict:intent.ref===refs.get('name')?'confirm':'allow'});
  const receipt=await fillForm(adapter,{operation:'blocked',identity,fields:[
    {ref:refs.get('name'),value:'private fixture'},{ref:refs.get('enabled'),value:true}]});
  assert.equal(receipt.completed, 0); assert.equal(receipt.fields[1].status, 'notAttempted');
  assert.deepEqual(await page.evaluate(()=>window.transmissions), []);
});
test('file capability uploads only approved fixture bytes',live, async t => {
  const page = await fixture(t);
  if (!page) return;
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'bp2-7-page-')));
  try {
    const path=join(directory,'public.txt');writeFileSync(path,'public');
    const {adapter,refs}=await adapterFor(page);
    const authority=createFileAuthority({approve:async()=>true}), stagedPaths=[];
    adapter.files={...authority,stage:(...args)=>{
      const staged=authority.stage(...args); stagedPaths.push(...staged.paths);
      writeFileSync(path,'replaced after approved bytes were staged');
      return staged;
    }};
    const ref=refs.get('file');
    const token=await adapter.files.issue([path],{...identity,operation:'file:0',ref});
    const receipt=await fillForm(adapter,{operation:'file',identity,fields:[{ref,value:{fileCapability:token}}]});
    assert.equal(receipt.completed, 1);
    assert.equal(stagedPaths.length, 1);
    assert.equal(existsSync(stagedPaths[0]), false);
    assert.equal(await page.locator('#file').evaluate(el=>el.files[0].text()), 'public');
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('approved file payloads remain exact after staged paths are cleaned', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'bp2-7-payload-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'public.bin'), bytes = Buffer.from([0, 1, 127, 255]);
  writeFileSync(path, bytes);
  const files = createFileAuthority({ approve: async () => true });
  const binding = { ...identity, operation: 'payload:0', ref: 'r1' };
  const token = await files.issue([path], binding), staged = files.stage(token, binding);
  t.after(() => staged.cleanup());
  assert.equal(Array.isArray(staged.payloads), true, 'File authority must supply checked bytes independently of browser path lifetime');
  writeFileSync(path, 'replaced after staging');
  assert.equal(staged.payloads[0].name, 'public.bin');
  assert.deepEqual(staged.payloads[0].buffer, bytes);
  staged.cleanup();
  assert.equal(existsSync(staged.paths[0]), false);
  assert.deepEqual(staged.payloads[0].buffer, bytes);
});
