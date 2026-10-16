// Searchable comboboxes written for sleight's own tests: an input with a popup listbox that filters by the typed text a
// moment after typing, a virtual list of 400 airports that renders only the rows in view, aria-activedescendant moved by
// ArrowUp and ArrowDown, and an option chosen by Enter or by a click. Every choice is POSTed to /log.
const STEMS = ['Ash', 'Bel', 'Cal', 'Dun', 'Elm', 'Fen', 'Glen', 'Har', 'Iron', 'Jade', 'Kent', 'Lark', 'Mill', 'Nor', 'Oak', 'Pine', 'Quill', 'Rock', 'Sand', 'Thorn'];
const TAILS = ['bridge', 'cliff', 'crest', 'dale', 'field', 'gate', 'haven', 'island', 'junction', 'keep', 'lake', 'moor', 'park', 'port', 'ridge', 'shore', 'springs', 'vale', 'wick', 'wood'];
export const AIRPORTS = STEMS.flatMap((stem, s) => TAILS.map((tail, t) => ({
  name: stem + tail + (t % 3 === 0 ? ' International' : t % 3 === 1 ? ' Municipal' : ' Field'),
  code: String.fromCharCode(65 + s) + String.fromCharCode(65 + t) + String.fromCharCode(65 + (s * 7 + t * 3) % 26) })))
  .sort((a, b) => a.name.localeCompare(b.name));

const style = `<style>body{font:16px sans-serif;margin:24px}label{display:block;margin:12px 0 4px}
.box{position:relative;width:360px}input{width:100%;box-sizing:border-box;font:inherit;padding:6px}
.pop{position:absolute;left:0;right:0;height:224px;overflow-y:auto;border:1px solid #888;background:#fff;margin:0;padding:0;list-style:none}
.pop[hidden]{display:none}.pop li,.plain li{position:absolute;left:0;right:0;height:32px;line-height:32px;padding:0 8px;box-sizing:border-box}
.pop li[aria-selected=true],.plain li[aria-selected=true]{background:#0a66ff;color:#fff}.pop li.active{outline:2px solid #fa0}
.plain{position:relative;width:360px;height:224px;overflow-y:auto;border:1px solid #888;margin:0;padding:0;list-style:none}
#kb{width:160px;padding:6px;border:1px solid #888}</style>`;

export const COMBOBOX_HTML = `<!doctype html><title>Airport combobox</title>${style}
<main>
<form id="trip" onsubmit="event.preventDefault()">
<label for="from">Airport</label>
<div class="box"><input id="from" role="combobox" aria-expanded="false" aria-controls="from-list" aria-autocomplete="list" aria-haspopup="listbox" autocomplete="off">
<ul id="from-list" class="pop" role="listbox" aria-label="Airports" hidden></ul></div>
<p>Chosen: <output id="chosen">nothing</output></p>
<p>Keys: <output id="keys"></output></p>
<label>Meal<select id="meal"><option>None</option><option>Vegetarian</option></select></label>
</form>
<div id="kb" role="combobox" tabindex="0" aria-label="Sort order" aria-expanded="false">Fare</div>
<p>Sort: <output id="sort">Fare</output></p>
<label id="plain-label">Departing from</label>
<ul id="plain" class="plain" role="listbox" aria-labelledby="plain-label" tabindex="0"></ul>
<p>Departing: <output id="plain-chosen">nothing</output></p>
</main>
<script>
const AIRPORTS = ${JSON.stringify(AIRPORTS)}, ROW = 32, log = text => fetch('/log', { method: 'POST', body: text, keepalive: true });
const input = document.getElementById('from'), pop = document.getElementById('from-list'), chosen = document.getElementById('chosen');
let shown = AIRPORTS, active = -1, picked = '';
function rows(list, items, selectedCode, activeIndex) {
  const first = Math.max(0, Math.floor(list.scrollTop / ROW) - 2), last = Math.min(items.length, first + Math.ceil(list.clientHeight / ROW) + 5);
  list.querySelectorAll('li').forEach(li => li.remove());
  let spacer = list.querySelector('.spacer');
  if (!spacer) { spacer = document.createElement('div'); spacer.className = 'spacer'; list.append(spacer); }
  spacer.style.height = items.length * ROW + 'px';
  for (let i = first; i < last; i++) {
    const li = document.createElement('li');
    li.role = 'option'; li.id = list.id + '-' + items[i].code; li.style.top = i * ROW + 'px';
    li.setAttribute('aria-selected', String(items[i].code === selectedCode));
    if (i === activeIndex) li.className = 'active';
    li.textContent = items[i].name + ' (' + items[i].code + ')';
    li.onmousedown = event => event.preventDefault();
    li.onclick = () => choose(items[i]);
    list.append(li);
  }
}
function paint() {
  rows(pop, shown, picked, active);
  const at = pop.querySelector('li.active');
  if (at) input.setAttribute('aria-activedescendant', at.id); else input.removeAttribute('aria-activedescendant');
}
function open(on) { pop.hidden = !on; input.setAttribute('aria-expanded', String(on)); if (on) paint(); }
function choose(airport) {
  picked = airport.code; input.value = airport.name + ' (' + airport.code + ')';
  chosen.textContent = airport.code; log('chose ' + airport.code); open(false);
}
let timer;
input.addEventListener('input', () => {
  // The list filters a moment after typing, like a page that asks a server.
  clearTimeout(timer);
  timer = setTimeout(() => {
    const text = input.value.trim().toLowerCase();
    shown = AIRPORTS.filter(a => (a.name + ' (' + a.code + ')').toLowerCase().includes(text));
    active = shown.length ? 0 : -1; pop.scrollTop = 0; open(true);
  }, 150);
});
input.addEventListener('focus', () => { if (!pop.hidden) return; });
input.addEventListener('keydown', event => {
  document.getElementById('keys').textContent += event.key + ' ';
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault(); if (pop.hidden) { open(true); return; }
    active = Math.max(0, Math.min(shown.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)));
    if (active * ROW < pop.scrollTop) pop.scrollTop = active * ROW; else if ((active + 1) * ROW > pop.scrollTop + pop.clientHeight) pop.scrollTop = (active + 1) * ROW - pop.clientHeight;
    paint();
  } else if (event.key === 'Enter' && !pop.hidden && active >= 0) { event.preventDefault(); choose(shown[active]); }
  else if (event.key === 'Escape') open(false);
});
pop.addEventListener('scroll', paint);
input.addEventListener('click', () => { if (pop.hidden) open(true); });

const kb = document.getElementById('kb'), modes = ['Fare', 'Duration', 'Departure'];
kb.addEventListener('keydown', event => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault(); const next = modes[(modes.indexOf(kb.textContent) + (event.key === 'ArrowDown' ? 1 : modes.length - 1)) % modes.length];
  kb.textContent = next; document.getElementById('sort').textContent = next; log('sort ' + next);
});

const plain = document.getElementById('plain'), plainChosen = document.getElementById('plain-chosen');
let plainPicked = '';
function paintPlain() {
  rows(plain, AIRPORTS, plainPicked, -1);
  plain.querySelectorAll('li').forEach(li => { const code = li.id.slice(6); li.onclick = () => { plainPicked = code; plainChosen.textContent = code; log('plain ' + code); paintPlain(); }; });
}
plain.addEventListener('scroll', paintPlain); paintPlain();
</script>`;
