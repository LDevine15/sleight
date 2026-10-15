// CR5 extends sleight-arch's submit-probe.cjs and defaults-probe.cjs.
// Native defaults are measured without an arm, then the production route is
// checked against the plain result. No page script chooses the native outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { fixture, controls, skip } from './fixtures/cr4-real.mjs';

// HTML activation: input.html, form-elements.html, interactive-elements.html,
// interaction.html#activation-behavior; text selection: w3c.github.io/uievents/.
const cases = [];
const add = (name, html, options = {}) => cases.push({ name, html, selector: '#go', differs: false, plain: false, ...options });
for (const method of ['GET', 'POST']) for (const [kind, control] of Object.entries(controls))
  for (const target of ['_self', '_blank']) add(`${method} ${kind} ${target}`,
    `<form method="${method}" action="/landed" target="${target}"><input name="q" value="x">${control.replace(/<(button|input)/, '<$1 id="go"')}</form>`,
    { differs: target === '_self', plain: true, navigates: true });
for (const type of ['text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time',
  'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'button', 'reset'])
  add('input ' + type, `<input id="go" type="${type}" value="${type === 'color' ? '#123456' : type === 'range' ? '0' : ''}">`);
add('button onclick', '<button id="go" type="button" onclick="this.textContent=\'clicked\'">Click</button>');
add('reset form', '<form><input id="field" value="initial"><input id="go" type="reset"></form><script>field.value="changed"</script>');
add('button formtarget', '<form action="/landed" target="_blank"><button id="go" formtarget="_self">Send</button></form>',
  { differs: true, plain: true, navigates: true });
add('external form owner', '<form id="owner" action="/landed"></form><button id="go" form="owner">Send</button>',
  { differs: true, plain: true, navigates: true });
add('label checkbox', '<label id="go" for="field">Toggle</label><input id="field" type="checkbox">');
add('label submit', '<label id="go" for="field">Send</label><form action="/landed"><input id="field" type="submit"></form>',
  { differs: true, plain: true, navigates: true });
for (const multiple of [false, true]) {
  const html = `<select id="list" ${multiple ? 'multiple' : ''} size="4"><option selected>First</option><option id="go">Second</option><option>Third</option></select>`;
  add((multiple ? 'multiple' : 'single') + ' option', html, { differs: multiple, plain: multiple });
  add((multiple ? 'multiple' : 'single') + ' select', html, { selector: '#list', differs: multiple, plain: multiple });
}
add('summary', '<details id="field"><summary id="go">Summary</summary>Details</details>');
add('textarea', '<textarea id="go">hello world</textarea>');
add('contenteditable', '<div id="go" contenteditable>hello world here</div>');
add('plain text', '<p id="go">hello world here</p>');
add('double click text', '<p id="go">hello world here</p>', { double: true });
add('double click input', '<input id="go" value="hello world here">', { double: true });
add('double click editable', '<div id="go" contenteditable>hello world here</div>', { double: true });
add('draggable', '<div id="go" draggable="true">Drag source</div>');
add('draggable image', '<img id="go" draggable="true" width="60" height="40" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E">');
add('anchor without href', '<a id="go">No href</a>');
add('anchor', '<a id="go" href="/landed">Navigate</a>', { differs: true, plain: true, navigates: true });
add('draggable anchor', '<a id="go" draggable="true" href="/landed">Navigate</a>', { differs: true, plain: true, navigates: true });
add('area', '<img usemap="#map" width="80" height="40" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E"><map name="map"><area id="go" shape="rect" coords="0,0,80,40" href="/landed"></map>',
  { differs: true, plain: true, navigates: true });
add('iframe link', '<iframe src="/frame"></iframe>', { frame: true, differs: true, plain: true, navigates: true });
add('popover button', '<button id="go" popovertarget="field">Toggle</button><div id="field" popover>Popup</div>');
add('dialog command', '<button id="go" commandfor="field" command="show-modal">Show</button><dialog id="field">Dialog</dialog>');
add('audio controls', '<audio id="go" controls></audio>');
add('video controls', '<video id="go" controls width="240" height="120"></video>');
add('custom ARIA listbox', `<div role="listbox"><div id="go" role="option" tabindex="0" aria-selected="false">Second</div></div>
  <script>go.onclick=event=>go.setAttribute('aria-selected', String(!(event.ctrlKey || event.metaKey || event.getModifierState('Control') || event.getModifierState('Meta'))))</script>`,
  { scriptDiffers: true });

async function state(page, context, chooser, start) {
  return {
    pages: context.pages().filter(p => p.url() !== 'about:blank').map(p => new URL(p.url()).pathname).sort(),
    chooser,
    dom: await page.evaluate(() => ({
      path: location.pathname, frames: [...document.querySelectorAll('iframe')].map(f => new URL(f.contentWindow.location.href).pathname),
      focus: document.activeElement?.id || document.activeElement?.localName,
      selection: String(getSelection()),
      fields: [...document.querySelectorAll('input,textarea,select,details,dialog,[popover],[aria-selected],button')].map(el => ({
        id: el.id, value: el.value, checked: el.checked, open: el.open,
        selected: el.selectedOptions ? [...el.selectedOptions].map(o => o.textContent) : undefined,
        selection: typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : undefined,
        popover: el.hasAttribute('popover') ? el.matches(':popover-open') : undefined,
        aria: el.getAttribute('aria-selected'), text: el.localName === 'button' ? el.textContent : undefined,
      })),
    })),
    requests: start.filter(r => r.url.startsWith('/landed')).map(r => ({ method: r.method, path: r.url, body: r.body })),
  };
}

for (const row of cases) test('CR5 modifier defaults: ' + row.name, { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, row.html, { '/frame': '<a id="go" href="/landed">Frame link</a>' });
  const page = f.entry.page, startURL = page.url(), outcomes = {}, choices = [];
  let chooser = 0;
  page.on('filechooser', () => { chooser++; }); // Intercept, never open the host file dialog.
  for (const mode of ['plain', 'modified', 'background']) {
    if (mode !== 'plain') await page.goto(startURL);
    chooser = 0;
    const requestStart = f.requests.length;
    const locator = (row.frame ? page.frameLocator('iframe') : page).locator(row.selector);
    const click = options => row.double ? locator.dblclick({ ...options, timeout: 5000 }) : locator.click({ ...options, timeout: 5000 });
    if (mode === 'background') await backgroundClick(f.entry, locator, options => { choices.push(options); return click(options); }, { timeoutMs: 5000 });
    else await click({ modifiers: mode === 'modified' ? ['ControlOrMeta'] : [] });
    if (row.navigates) await assert.doesNotReject(async () => {
      await page.waitForFunction(() => location.pathname === '/landed' || [...document.querySelectorAll('iframe')].some(f => f.contentWindow.location.pathname === '/landed'),
        undefined, { timeout: 300 }).catch(() => {});
    });
    // Include native navigation/new target commit, not just the synchronous handler.
    await new Promise(resolve => setTimeout(resolve, 150));
    outcomes[mode] = await state(page, f.context, chooser, f.requests.slice(requestStart));
    for (const child of f.context.pages()) if (child !== page && child !== f.sentinel) {
      await child.waitForLoadState('domcontentloaded'); await child.close();
    }
  }
  t.diagnostic(JSON.stringify({ name: row.name, nativeDiffers: row.differs, outcomes, choices }));
  assert.equal(JSON.stringify(outcomes.plain) !== JSON.stringify(outcomes.modified), row.differs || !!row.scriptDiffers,
    'pin the measured native default table (script modifier handling is identified separately)');
  assert.deepEqual(choices, [row.plain ? {} : { modifiers: ['ControlOrMeta'] }], 'only measured native defaults take plain input');
  assert.deepEqual(outcomes.background, outcomes.plain, 'masked background input preserves the plain result');
});
