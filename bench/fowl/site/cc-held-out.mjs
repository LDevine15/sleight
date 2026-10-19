import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const ccKinds = ['list', 'list-pop-up', 'calendar', 'calendar-ambiguous', 'dropdown', 'dropdown-slow', 'new-tab'];
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const first = 'Alder Amber Ash Aspen Birch Blue Cedar Cherry Copper Coral Cypress Dawn Elm Fern Fir Flint Hazel Holly Indigo Ivory Jade Juniper Laurel Linden Maple Moss Oak Olive Pearl Pine Rowan Willow'.split(' ');
const last = 'Archive Atrium Bay Court Depot Field Garden Grove Hall House Island Lake Library Lodge Mill Park Pier Ridge Studio Tower'.split(' ');

export function createCCFixture(kind, { nonce, seed = randomBytes(24).toString('hex'), delay = setTimeout } = {}) {
  if (!ccKinds.includes(kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(nonce)) throw Error('invalid CC fixture');
  const token = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  const rows = first.flatMap(a => last.map(b => `${a} ${b}`)).sort().map((name, index) => ({
    name, value: `COL-${String(index + 1).padStart(4, '0')}`, label: `${name}\nCOL-${String(index + 1).padStart(4, '0')}`, file: `${name}.txt`,
  }));
  const target = rows[380 + parseInt(token.slice(0, 4), 16) % 240];
  const expected = kind.startsWith('list') ? { selected: target.value }
    : kind.startsWith('calendar') ? { start: '2027-10-21', end: '2027-11-09' }
    : kind.startsWith('dropdown') ? { parent: 'coast', child: 'coast-harbor' } : { receipt: `Arrival ${token}` };
  return { kind, nonce, token, rows, target, expected, delay, views: [], childLoads: [], tabs: [], posted: undefined };
}

export const ccBase = fixture => `/held-out/${fixture.kind}/${fixture.nonce}/`;
const children = parent => parent === 'coast'
  ? [{ value: 'coast-dune', label: 'Dune workshop' }, { value: 'coast-harbor', label: 'Harbor workshop' }]
  : parent === 'forest' ? [{ value: 'forest-cedar', label: 'Cedar workshop' }, { value: 'forest-pine', label: 'Pine workshop' }] : undefined;

function page(fixture, path, origin) {
  const { kind } = fixture, base = ccBase(fixture);
  const common = `const base=${JSON.stringify(base)};
    const byId=id=>document.getElementById(id);
    const post=async (path,value)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});if(!response.ok)throw Error('Save failed');};
    const saved=()=>{byId('status').textContent='Saved';};`;
  let body, script;
  if (kind.startsWith('list')) {
    body = '<h1>Collection directory</h1><label>Display mode <select id="mode" autofocus><option>All collections</option><option>Recent collections</option></select></label>' +
      '<p>640 collections sorted by name.</p><div id="list" role="listbox" aria-label="Collection" tabindex="0" style="height:320px;overflow:auto;position:relative;border:1px solid #888"><div id="space" style="height:25600px"></div></div>' +
      '<p id="selection">No collection selected</p><button id="submit" disabled>Save collection</button>';
    script = `const rows=${JSON.stringify(fixture.rows.map(({ label, value }) => ({ label, value })))};
      const list=byId('list'),space=byId('space');let selected=null,active=0;
      function render(){space.replaceChildren();const first=Math.max(0,Math.floor(list.scrollTop/40));
        for(let i=first;i<Math.min(rows.length,first+9);i++){const row=document.createElement('div');
          row.setAttribute('role','option');row.setAttribute('aria-label',rows[i].label);row.setAttribute('aria-setsize',String(rows.length));row.setAttribute('aria-posinset',String(i+1));
          row.setAttribute('aria-selected',String(selected===rows[i].value));row.id='row-'+i;
          row.style.cssText='position:absolute;left:0;right:0;height:40px;top:'+i*40+'px;white-space:pre-line;line-height:19px;padding-left:8px;box-sizing:border-box';
          row.textContent=rows[i].label;row.onclick=()=>{active=i;selected=rows[i].value;list.focus();byId('selection').textContent=rows[i].label;byId('submit').disabled=false;render();};space.append(row);}}
      list.onscroll=()=>{active=Math.min(rows.length-1,Math.floor(list.scrollTop/40));render();};list.onkeydown=event=>{const steps={PageDown:8,PageUp:-8,ArrowDown:1,ArrowUp:-1,Home:-640,End:640};
        if(event.key in steps){event.preventDefault();active=Math.max(0,Math.min(rows.length-1,active+steps[event.key]));list.scrollTop=active*40;render();}
        if(event.key==='Enter'||event.key===' '){event.preventDefault();const row=byId('row-'+active);if(row)row.onclick();}};
      byId('submit').onclick=async()=>{await post('state',{selected});saved();};render();`;
  } else if (kind.startsWith('calendar')) {
    body = '<h1>Studio access dates</h1><p>Choose the first and last day of access.</p><section id="calendar" aria-label="Access date range"></section><button id="submit" disabled>Save dates</button>';
    script = `const ambiguous = ${kind === 'calendar-ambiguous'};let start=null,end=null;const calendar=byId('calendar');
      function render(){const summary=document.createElement('div');summary.textContent='Start: '+(start||'none')+' End: '+(end||'none');
        if(start){const clear=document.createElement('button');clear.textContent='Clear start date';clear.onclick=()=>{start=null;end=null;render();};summary.append(clear);}
        const panels=[['October',10,31],['November',11,30]].map(([month,number,count])=>{const panel=document.createElement('section');
          panel.setAttribute('aria-label',month+' 2027');const title=document.createElement('h2');title.textContent=month+' 2027';panel.append(title);
          const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(7,36px);gap:3px';
          for(const weekday of ['Su','Mo','Tu','We','Th','Fr','Sa']){const heading=document.createElement('span');heading.textContent=weekday;grid.append(heading);}
          for(let blank=0;blank<new Date(Date.UTC(2027,number-1,1)).getUTCDay();blank++){const spacer=document.createElement('span');spacer.setAttribute('aria-hidden','true');grid.append(spacer);}
          for(let day=1;day<=count;day++){const date='2027-'+number+'-'+String(day).padStart(2,'0'),button=document.createElement('button');
            button.textContent=String(day);button.setAttribute('aria-label',ambiguous?String(day):day+' '+month+' 2027');button.setAttribute('aria-pressed',String(date===start||date===end));
            button.onclick=()=>{if(!start||end){start=date;end=null;}else{end=date;}render();};grid.append(button);}panel.append(grid);return panel;});
        calendar.replaceChildren(summary,...panels);byId('submit').disabled=!(start&&end&&end>=start);}
      byId('submit').onclick=async()=>{await post('state',{start,end});saved();};render();`;
  } else if (kind.startsWith('dropdown')) {
    body = '<h1>Workshop assignment</h1><label>Region <select id="parent"><option value="">Choose a region</option><option value="coast">Coast</option><option value="forest">Forest</option></select></label>' +
      '<label>Workshop <select id="child" disabled><option>Choose a region first</option></select></label><p id="loading" role="status"></p><button id="submit" disabled>Save workshop</button>';
    script = `let generation=0;const parent=byId('parent'),child=byId('child');
      parent.onchange=async()=>{const current=++generation;child.disabled=true;child.setAttribute('aria-busy','true');child.replaceChildren(new Option('Loading workshops…',''));
        byId('loading').textContent='Loading workshops…';byId('submit').disabled=true;if(!parent.value){child.replaceChildren(new Option('Choose a region first',''));child.setAttribute('aria-busy','false');byId('loading').textContent='';return;}
        const response=await fetch(base+'children?parent='+encodeURIComponent(parent.value));const rows=await response.json();if(current!==generation)return;
        child.replaceChildren(new Option('Choose a workshop',''),...rows.map(row=>new Option(row.label,row.value)));child.disabled=false;child.setAttribute('aria-busy','false');byId('loading').textContent='Workshops ready';};
      child.onchange=()=>{byId('submit').disabled=!child.value;};byId('submit').onclick=async()=>{await post('state',{parent:parent.value,child:child.value});saved();};`;
  } else {
    const arrival = path === 'arrival';
    body = arrival ? `<h1>Archive arrival</h1><p>${esc(fixture.expected.receipt)}</p><button id="submit">Confirm arrival</button>`
      : `<h1>Archive departure</h1><p>Open this address in a new tab using Command-T, type the address and press Return:</p><code>${esc(origin + base + 'arrival')}</code><p>Keep this departure tab open.</p>`;
    script = `let tab=sessionStorage.getItem('cc-tab');if(!tab){tab=globalThis.crypto?.randomUUID?.()??(Date.now().toString(36)+'-'+Math.random().toString(36).slice(2));sessionStorage.setItem('cc-tab',tab);}
      await post('tab',{page:${JSON.stringify(arrival ? 'arrival' : 'start')},tab});` +
      (arrival ? `byId('submit').onclick=async()=>{await post('state',{receipt:${JSON.stringify(fixture.expected.receipt)},tab});saved();};` : '');
  }
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Held-out ${esc(kind)} ${esc(fixture.nonce)}</title>
    <style>body{font:16px system-ui;margin:24px;max-width:850px}label{display:block;margin:16px 0}button,select{font:inherit;padding:6px;margin:3px}#calendar{display:flex;gap:24px}#calendar>div{width:180px}#calendar section{width:280px}#calendar section button{width:36px;margin:0;padding:6px 0}code{overflow-wrap:anywhere}</style>
    <main>${body}<p id="status" role="status"></p></main><script>(async()=>{${common}\n${script}\n})().catch(error=>{document.getElementById('status').textContent=error.message;});</script></html>`;
}

export function ccHandler(fixture, origin) {
  return async (req, res) => {
    const send = (status, type, body = '') => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    const json = value => send(200, 'application/json', JSON.stringify(value));
    const url = new URL(req.url, origin), prefix = ccBase(fixture);
    if (req.headers.host !== new URL(origin).host || !url.pathname.startsWith(prefix)) return send(404, 'text/plain');
    if (req.headers.origin && req.headers.origin !== origin) return send(403, 'text/plain');
    const path = url.pathname.slice(prefix.length);
    if (req.method === 'POST' && ['state', 'tab'].includes(path)) {
      if (req.headers['content-type'] !== 'application/json') return send(400, 'text/plain');
      let body = '', bytes = 0;
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4096) { req.resume?.(); return send(413, 'text/plain'); }
        body += chunk;
      }
      let value;try { value = JSON.parse(body); } catch { return send(400, 'text/plain'); }
      if (path === 'state') fixture.posted = value;
      else {
        if (fixture.kind !== 'new-tab' || !['start', 'arrival'].includes(value?.page) || !/^[\w-]{1,80}$/.test(value?.tab)) return send(400, 'text/plain');
        fixture.tabs.push(value);
      }
      return send(204, 'text/plain');
    }
    if (req.method !== 'GET') return send(405, 'text/plain');
    if (path === 'children' && fixture.kind.startsWith('dropdown')) {
      const parent = url.searchParams.get('parent'), rows = children(parent);
      if (!rows) return send(400, 'text/plain');
      await new Promise(resolve => fixture.delay(resolve, fixture.kind === 'dropdown' ? 700 : 2100));
      fixture.childLoads.push(parent);
      return json(rows);
    }
    if (path !== '' && !(fixture.kind === 'new-tab' && path === 'arrival')) return send(404, 'text/plain');
    fixture.views.push(path);
    return send(200, 'text/html; charset=utf-8', page(fixture, path, origin));
  };
}

export function checkCCFixture(fixture, answer) {
  if (!fixture?.views?.includes('')) return 'CC_PAGE_NOT_READ';
  if (fixture.kind === 'calendar-ambiguous' || fixture.kind === 'list-pop-up') {
    const text = String(answer).trim(), fenced = /^\x60\x60\x60(?:json)?\s*\n([\s\S]*?)\n\x60\x60\x60$/i.exec(text);
    let refused;try { refused = JSON.parse(fenced ? fenced[1] : text); } catch { return 'CC_REFUSAL_NOT_REPORTED'; }
    return isDeepStrictEqual(refused, { refused: true }) && fixture.posted === undefined || 'CC_AMBIGUOUS_ACTION_NOT_STOPPED';
  }
  if (fixture.kind.startsWith('dropdown') && !fixture.childLoads.includes(fixture.expected.parent)) return 'CC_CHILD_LIST_NOT_LOADED';
  if (fixture.kind === 'new-tab') {
    const { tab, ...posted } = fixture.posted ?? {};
    if (!fixture.views.includes('arrival') || !fixture.tabs.some(row => row.page === 'start') ||
      !fixture.tabs.some(row => row.page === 'arrival' && row.tab === tab) || fixture.tabs.some(row => row.page === 'start' && row.tab === tab)) return 'CC_NEW_TAB_UNPROVEN';
    return isDeepStrictEqual(posted, fixture.expected) || 'CC_SUBMISSION_MISMATCH';
  }
  return isDeepStrictEqual(fixture.posted, fixture.expected) || 'CC_SUBMISSION_MISMATCH';
}
