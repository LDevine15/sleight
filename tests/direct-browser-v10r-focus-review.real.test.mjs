import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { check } from '../plugins/sleight/lib/direct-browser/rules.mjs';
const skip=process.env.SLEIGHT_LIVE_DOM_TEST !== '1' ? 'review real-page proof runs through sleight-arch host runner' : false;
async function fixture(t) {
  const {chromium}=await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  const spec=JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json',import.meta.url))).browsers.find(b=>b.name==='chromium-headless-shell');
  const platform=process.platform==='darwin' ? 'mac-'+process.arch : 'linux64';
  const executablePath=join(homedir(),'Library/Caches/ms-playwright','chromium_headless_shell-'+spec.revision,'chrome-headless-shell-'+platform,'chrome-headless-shell');
  assert.ok(existsSync(executablePath),'pinned Chromium required; real proof cannot skip');
  const sockets=new Set(), server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(`<main>
    <h2 id="e9">Ordinary heading</h2><form id="payment"><label>Card<input autocomplete="cc-number"></label><button id="e1">Continue</button></form>
    <output id="count">0</output></main><script>document.querySelector('form').onsubmit=event=>{event.preventDefault();document.querySelector('#count').textContent++;};</script>`);});
  server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(resolve=>server.close(resolve));t.diagnostic('fixture server and sockets collected');});
  const browser=await chromium.launch({headless:true,executablePath});
  t.after(async()=>{await browser.close();t.diagnostic('owned headless Chromium closed');});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  page.getByRef=ref=>page.locator('#'+ref);
  const binding=createV3TurnBinding({source:'user',session:'session',turn:'turn',id:'read-request',text:'Read only. Do not pay.'},()=>true);
  const ctx=createV3Context({binding,browser:'bfixture'});t.after(()=>ctx.dispose());
  let clock=Date.now();
  const run=createActionRunner({check,snapshot:async()=>({text:'untrusted fixture',number:1}),now:()=>clock,sleep:async ms=>{clock+=ms;}});
  return {page,ctx,run,tab:{page,state:{snapshotNo:0,submitUnconfirmed:false}}};
}

test('review: page activeElement getter cannot authorize Enter on a different native receiver', {skip},async t=>{
  const f=await fixture(t);
  await f.page.locator('#e1').focus();
  assert.equal(await f.page.evaluate(()=>document.activeElement.id),'e1');
  await f.page.evaluate(()=>{const heading=document.querySelector('#e9');Object.defineProperty(document,'activeElement',{configurable:true,get:()=>heading});});
  const result=await f.run(f.tab,[{do:'press',ref:'e9',key:'Enter'}],f.ctx);
  const count=await f.page.locator('#count').innerText();
  t.diagnostic(JSON.stringify({lines:result.lines,count,submitUnconfirmed:!!f.tab.state.submitUnconfirmed}));
  assert.equal(count,'0','the native Pay receiver must never receive an unchecked Enter');
});

test('review: page form getter cannot remove the native owning payment form', {skip},async t=>{
  const f=await fixture(t);
  assert.equal(await f.page.locator('#e1').evaluate(el=>el.form.id),'payment');
  await f.page.locator('#e1').evaluate(el=>{Object.defineProperty(el,'form',{configurable:true,get:()=>null});});
  const result=await f.run(f.tab,[{do:'click',ref:'e1'}],f.ctx);
  const count=await f.page.locator('#count').innerText();
  t.diagnostic(JSON.stringify({lines:result.lines,count,submitUnconfirmed:!!f.tab.state.submitUnconfirmed}));
  assert.equal(count,'0','native associated card-form submit must require payment authority');
});
