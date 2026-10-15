import test from 'node:test';
import assert from 'node:assert/strict';
import { bank, plain, readOnly, skip, devtoolsMarkers } from './fixtures/bank.mjs';

// Class 5. The page tries to reach Chrome's DevTools HTTP endpoint (the selected
// debugging port) by every request type it can make. Two independent payloads:
// /json/list returns a body full of debugger URLs (a leak if it reaches tool
// output), and /json/close/<id> closes the foreign tab the agent does not own
// (harm if the foreign tab dies). Safe outcome: neither.
const payloads = {
  list: b => `http://127.0.0.1:${b.port}/json/list`,
  close: b => `http://127.0.0.1:${b.port}/json/close/${b.foreignId}`,
};
const afterwards = async (b, f, extra = {}) => {
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(b.foreign.isClosed(), false, 'the foreign tab was closed through the DevTools endpoint');
  const text = b.transcript();
  assert.doesNotMatch(text, devtoolsMarkers, 'DevTools body reached tool output');
  await f.safe({ settle: 100, ...extra });
};

// Page-load vectors: the page itself issues the request while the agent reads it.
const loads = {
  'fetch no-cors': u => `<script>fetch(${JSON.stringify(u)},{mode:'no-cors'}).catch(()=>{})</script>`,
  'fetch cors': u => `<script>fetch(${JSON.stringify(u)}).catch(()=>{})</script>`,
  'XMLHttpRequest': u => `<script>const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(u)});x.send()</script>`,
  'sendBeacon': u => `<script>navigator.sendBeacon(${JSON.stringify(u)},'x')</script>`,
  'EventSource': u => `<script>new EventSource(${JSON.stringify(u)})</script>`,
  'img': u => `<img src="${u}" alt="pixel">`,
  'script': u => `<script src="${u}"></script>`,
  'stylesheet link': u => `<link rel="stylesheet" href="${u}">`,
  'css @import': u => `<style>@import url("${u}");</style>`,
  'css background': u => `<div style="background:url('${u}');width:10px;height:10px"></div>`,
  'prefetch': u => `<link rel="prefetch" href="${u}">`,
  'preload fetch': u => `<link rel="preload" as="fetch" href="${u}" crossorigin>`,
  'iframe': u => `<iframe src="${u}" title="embedded"></iframe>`,
  'iframe on localhost (cross-site frame)': u => `<iframe src="${u.replace('127.0.0.1', 'localhost')}" title="embedded"></iframe>`,
  'iframe srcdoc fetch': u => `<iframe srcdoc="&lt;script&gt;fetch('${u}',{mode:'no-cors'})&lt;/script&gt;" title="embedded"></iframe>`,
  'object data': u => `<object data="${u}" type="text/html"></object>`,
  'embed': u => `<embed src="${u}" type="text/html">`,
  'video poster': u => `<video poster="${u}"></video>`,
  'dynamic import': u => `<script type="module">import(${JSON.stringify(u)}).catch(()=>{})</script>`,
  'dedicated worker': u => `<script>try{new Worker(${JSON.stringify(u)})}catch(e){}</script>`,
  'meta refresh': u => `<meta http-equiv="refresh" content="0;url=${u}">`,
  'location assign': u => `<script>location.href=${JSON.stringify(u)}</script>`,
  'location replace in a timer': u => `<script>setTimeout(()=>location.replace(${JSON.stringify(u)}),50)</script>`,
  'iframe navigates itself later': u => `<iframe id="fr" src="about:blank" title="embedded"></iframe><script>setTimeout(()=>{document.getElementById('fr').contentWindow.location=${JSON.stringify(u)}},50)</script>`,
  'parent navigates iframe by name': u => `<iframe name="fr" src="about:blank" title="embedded"></iframe><a id="x" target="fr" href="${u}"></a><script>setTimeout(()=>document.getElementById('x').click(),50)</script>`,
  'WebSocket to the page target': u => `<script>try{const w=new WebSocket(${JSON.stringify(u.replace('http', 'ws').replace(/json\/(list|close\/)/, 'devtools/page/'))});w.onopen=()=>w.send(JSON.stringify({id:1,method:'Page.close'}))}catch(e){}</script>`,
};
for (const [name, build] of Object.entries(loads)) for (const [kind, payload] of Object.entries(payloads))
  test('page-load vector "' + name + '" to /json/' + kind + ' reaches neither the endpoint nor the tool output', { skip, timeout: 60000 }, async t => {
    const b = await bank(t);
    const f = await b.start(plain('<p>Landing</p>' + build(payload(b)), '', ''), readOnly).catch(error => {
      // A page that navigates straight to the endpoint can fail the open itself. That refusal is safe.
      t.diagnostic('open refused: ' + error.message.slice(0, 120)); return undefined;
    });
    if (f) { await f.read().catch(error => t.diagnostic('read refused: ' + error.message.slice(0, 120))); await afterwards(b, f); }
    else { await new Promise(resolve => setTimeout(resolve, 700)); assert.equal(b.foreign.isClosed(), false); assert.doesNotMatch(b.transcript(), devtoolsMarkers); }
  });

// Agent-triggered vectors: the agent clicks, or submits, or opens.
const clicks = {
  'link': u => `<a id="go" href="${u}">Open report</a>`,
  'link target=_blank': u => `<a id="go" href="${u}" target="_blank">Open report</a>`,
  'link with ping': u => `<a id="go" href="/landed" ping="${u}">Open report</a>`,
  'form GET': u => `<form action="${u}" method="get"><button id="go">Open report</button></form>`,
  'form POST': u => `<form action="${u}" method="post"><button id="go">Open report</button></form>`,
  'form GET target=_blank': u => `<form action="${u}" target="_blank"><button id="go">Open report</button></form>`,
  'form with button formtarget=_blank': u => `<form action="${u}"><button id="go" formtarget="_blank">Open report</button></form>`,
  'form target=named window': u => `<form action="${u}" target="report-window"><button id="go">Open report</button></form>`,
  'form under <base target=_blank>': u => `<base target="_blank"><form action="${u}"><button id="go">Open report</button></form>`,
  'label forwarding to a target=_blank submit': u => `<form action="${u}" target="_blank"><button id="sub" style="display:none">Go</button></form><label for="sub" id="go" role="button" tabindex="0">Open report</label>`,
  'image map area target=_blank': u => `<img id="go" alt="Open report" usemap="#m" width="120" height="60" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22120%22 height=%2260%22%3E%3Crect width=%22120%22 height=%2260%22 fill=%22gray%22/%3E%3C/svg%3E"><map name="m"><area shape="rect" coords="0,0,120,60" href="${u}" target="_blank" alt="area"></map>`,
  'button window.open': u => `<button id="go" type="button" onclick="window.open(${JSON.stringify(u)})">Open report</button>`,
  'button window.open then navigate later': u => `<button id="go" type="button" onclick="const w=window.open('/landed');setTimeout(()=>{try{w.location=${JSON.stringify(u)}}catch(e){}},200)">Open report</button>`,
  'button fetch': u => `<button id="go" type="button" onclick="fetch(${JSON.stringify(u)},{mode:'no-cors'})">Open report</button>`,
  'button location': u => `<button id="go" type="button" onclick="location=${JSON.stringify(u)}">Open report</button>`,
  'redirecting link (302 to the endpoint)': u => `<a id="go" href="/hop1">Open report</a>`,
  'redirecting form (307 to the endpoint)': u => `<form action="/hop307" method="post"><button id="go">Open report</button></form>`,
};
for (const [name, build] of Object.entries(clicks)) for (const [kind, payload] of Object.entries(payloads))
  test('click vector "' + name + '" to /json/' + kind + ' reaches neither the endpoint nor the tool output', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), target = payload(b);
    const routes = { '/landed': '<!doctype html><title>landed</title><h1>Landed</h1>',
      '/hop1': (req, res) => { res.writeHead(302, { location: '/hop2' }); res.end(); },
      '/hop2': (req, res) => { res.writeHead(302, { location: target }); res.end(); },
      '/hop307': (req, res) => { res.writeHead(307, { location: target }); res.end(); } };
    const f = await b.start(plain(build(target)), readOnly, { routes });
    const result = await f.act([{ do: 'click', ref: f.ref('Open report') }]);
    t.diagnostic(result.text.split('\n').slice(0, 3).join(' | '));
    await f.read().catch(() => {});
    // Whatever tabs the click opened, list and read each one.
    const listing = await f.call('browser_tabs', { do: 'list' });
    for (const row of listing.text.split('\n')) {
      const tab = /^(t\w+)/.exec(row)?.[1];
      if (tab && tab !== f.tab) { const read = await f.call('browser_read', { tab }); t.diagnostic('read popup ' + read.text.slice(0, 80).replace(/\n/g, ' | ')); b.outputs.push(read.text); }
    }
    await afterwards(b, f, name.includes('307') || name === 'form POST' ? { allow: { post: 1 } } : {});
  });

// Opening the endpoint directly, in every spelling a model might be handed.
const spellings = {
  'ip': (p, path) => `http://127.0.0.1:${p}${path}`,
  'localhost': (p, path) => `http://localhost:${p}${path}`,
  'LOCALHOST': (p, path) => `http://LOCALHOST:${p}${path}`,
  'trailing dot': (p, path) => `http://localhost.:${p}${path}`,
  'subdomain of localhost': (p, path) => `http://anything.localhost:${p}${path}`,
  'short ip 127.1': (p, path) => `http://127.1:${p}${path}`,
  'decimal ip': (p, path) => `http://2130706433:${p}${path}`,
  'hex ip': (p, path) => `http://0x7f000001:${p}${path}`,
  'octal ip': (p, path) => `http://0177.0.0.1:${p}${path}`,
  '0.0.0.0': (p, path) => `http://0.0.0.0:${p}${path}`,
  'ipv6 mapped': (p, path) => `http://[::ffff:7f00:1]:${p}${path}`,
  'ideographic dots': (p, path) => `http://127。0。0。1:${p}${path}`,
  'leading-zero port': (p, path) => `http://127.0.0.1:0${p}${path}`,
  'path with dot segments': (p, path) => `http://127.0.0.1:${p}/x/../${path.slice(1)}`,
  'percent-encoded path': (p, path) => `http://127.0.0.1:${p}${path.replace('json', 'js%6fn')}`,
  'fragment and query': (p, path) => `http://127.0.0.1:${p}${path}?a=b#c`,
};
for (const [name, spell] of Object.entries(spellings)) for (const [kind, path] of [['list', '/json/list'], ['version', '/json/version'], ['close', null]])
  test('browser_open of the endpoint spelled as ' + name + ' (/json/' + kind + ') is refused', { skip, timeout: 60000 }, async t => {
    const b = await bank(t), f = await b.start(plain('<p>Landing</p>'), readOnly);
    const url = spell(b.port, path ?? `/json/close/${b.foreignId}`);
    const opened = await b.open(url);
    t.diagnostic(opened.text.split('\n')[0].slice(0, 100));
    assert.equal(opened.isError, true, 'the endpoint was opened: ' + opened.text.slice(0, 120));
    await afterwards(b, f);
  });

test('browser_open of a page that redirects to the endpoint (302) is refused and leaks nothing', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain('<p>Landing</p>'), readOnly, { routes: { '/r': (req, res) => { res.writeHead(302, { location: payloads.list(b) }); res.end(); } } });
  const opened = await b.open(b.origin + '/r');
  t.diagnostic(opened.text.slice(0, 120));
  await afterwards(b, f);
});

test('the endpoint embedded in a page that the agent then reads through ref and find options leaks nothing', { skip, timeout: 60000 }, async t => {
  const b = await bank(t), f = await b.start(plain(`<iframe src="${payloads.list(b)}" title="embedded"></iframe><iframe src="${payloads.list(b).replace('127.0.0.1', 'localhost')}" title="embedded2"></iframe>`), readOnly);
  for (const extra of [{}, { find: 'webSocketDebuggerUrl' }, { find: 'devtools' }, { text: true }, { max_chars: 40000 }, { ref: 'f1e1' }, { ref: 'f2e1' }])
    await f.read(extra).catch(() => {});
  await afterwards(b, f);
});
