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
async function fixture(t, text = 'Read only. Do not pay.') {
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
  const binding=createV3TurnBinding({source:'user',session:'session',turn:'turn',id:'read-request',text},()=>true);
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

for (const prototype of [false, true]) test('review: focus on an unfocusable label cannot spoof the native receiver; prototype=' + prototype, {skip}, async t => {
  const f=await fixture(t);
  await f.page.evaluate(prototype => {
    const label=document.createElement('label'); label.id='e8'; label.textContent='Ordinary label'; document.querySelector('main').prepend(label);
    document.querySelector('#e1').focus();
    Object.defineProperty(prototype ? Document.prototype : document,'activeElement',{configurable:true,get:()=>label});
  },prototype);
  const result=await f.run(f.tab,[{do:'press',ref:'e8',key:'Enter'}],f.ctx);
  assert.match(result.lines[0],/not run:/);
  assert.equal(await f.page.locator('#count').innerText(),'0');
});
for (const external of [false, true]) test('review: prototype form getter cannot conceal native payment ownership; external=' + external, {skip}, async t => {
  const f=await fixture(t);
  await f.page.evaluate(external => {
    const button=document.querySelector('#e1');
    if(external) { button.setAttribute('form','payment'); document.querySelector('main').append(button); }
    Object.defineProperty(HTMLButtonElement.prototype,'form',{configurable:true,get:()=>null});
  },external);
  const result=await f.run(f.tab,[{do:'click',ref:'e1'}],f.ctx);
  assert.match(result.lines[0],/not run:.*confirmation required/);
  assert.equal(await f.page.locator('#count').innerText(),'0');
});
test('review: main-world attribute and text prototypes cannot hide payment classification', {skip}, async t => {
  const f=await fixture(t);
  await f.page.evaluate(() => {
    const button=document.querySelector('#e1'); document.querySelector('main').append(button); button.textContent='Pay now';
    Object.defineProperty(Node.prototype,'textContent',{configurable:true,get:()=> 'Continue'});
    Element.prototype.getAttribute=function(){return null;};
  });
  const result=await f.run(f.tab,[{do:'click',ref:'e1'}],f.ctx);
  assert.match(result.lines[0],/not run:.*confirmation required/);
  assert.equal(await f.page.locator('#count').innerText(),'0');
});
test('review: main-world terms and visibility getters cannot grant the requested amount', {skip}, async t => {
  const terms={item:'Fixture item',amount:'18.00',payee:'Fixture shop',method:'Fixture card',currency:'USD'};
  const f=await fixture(t,'Pay '+JSON.stringify(terms));
  await f.page.evaluate(() => {
    const form=document.querySelector('form');
    for(const [key,value] of Object.entries({item:'Fixture item',amount:'19.00',payee:'Fixture shop',currency:'USD'})) {
      const node=document.createElement('p'); node.setAttribute('data-payment-'+key,value);node.textContent=key+': '+value;form.prepend(node);
    }
    const nativeAttribute=Element.prototype.getAttribute;
    Element.prototype.getAttribute=function(key){return key==='data-payment-amount'?'18.00':nativeAttribute.call(this,key);};
    const walker=Document.prototype.createTreeWalker;
    Document.prototype.createTreeWalker=function(root,...args){
      if(root.hasAttribute?.('data-payment-amount')) { const part={nodeType:3,parentElement:root,textContent:'Amount: 18.00'};let returned=false;return {nextNode:()=>returned?null:(returned=true,part)}; }
      return walker.call(this,root,...args);
    };
    const range=Document.prototype.createRange;
    Document.prototype.createRange=function(){const value=range.call(this);value.selectNodeContents=()=>{};value.getClientRects=()=>[{left:10,top:10,right:210,bottom:30}];return value;};
  });
  const result=await f.run(f.tab,[{do:'click',ref:'e1'}],f.ctx);
  assert.match(result.lines[0],/not run:.*confirmation required/);
  assert.equal(await f.page.locator('#count').innerText(),'0');
});


test('V10R4: img named activeElement cannot send Enter to the native Pay receiver', {skip}, async t => {
  const f=await fixture(t);
  await f.page.evaluate(() => {
    const image=document.createElement('img'); image.id='e8'; image.name='activeElement';
    image.setAttribute('role','button'); image.setAttribute('aria-label','Ordinary image');
    document.querySelector('main').prepend(image); document.querySelector('#e1').focus();
  });
  assert.equal(await f.page.evaluate(() => document.activeElement.id),'e8','the shared DOM clobbers every world');
  assert.equal(await f.page.evaluate(() => Object.getOwnPropertyDescriptor(Document.prototype,'activeElement').get.call(document).id),'e1');
  const result=await f.run(f.tab,[{do:'press',ref:'e8',key:'Enter'}],f.ctx);
  const count=await f.page.locator('#count').innerText();
  t.diagnostic(JSON.stringify({lines:result.lines,count,productionBase:'70528f80dd5d70fefbf21fa465f40b2abdf10714'}));
  assert.equal(count,'0','the native Pay receiver must never receive an unchecked Enter');
  assert.match(result.lines[0],/not run:/);
});
