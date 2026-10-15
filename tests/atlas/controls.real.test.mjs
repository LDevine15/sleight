import test from 'node:test';
import { atlas, skip, events, counts, rejected } from './fixture.real.test.mjs';

// Characterization, rather than product-policy tests: changing Chromium's
// sanitization, event dispatch or default action must change a pinned outcome.
const typing = [
  ['IME-free ASCII', '<input id=x>', 'plain text', 'plain text'],
  ['emoji surrogate pair', '<input id=x>', 'A😀B', 'A😀B'],
  ['emoji grapheme sequence', '<textarea id=x></textarea>', '👩🏽‍💻', '👩🏽‍💻'],
  ['input converts LF to space', '<input id=x>', 'a\nb', 'a b'],
  ['input converts CRLF to space', '<input id=x>', 'a\r\nb', 'a b'],
  ['textarea preserves LF', '<textarea id=x></textarea>', 'a\nb', 'a\nb'],
  ['textarea normalizes CRLF', '<textarea id=x></textarea>', 'a\r\nb', 'a\nb'],
  ['fill respects maxlength', '<input id=x maxlength=3>', 'abcdef', 'abc'],
  ['maxlength counts UTF-16', '<input id=x maxlength=3>', 'A😀B', 'A😀'],
  ['fill replaces initial text', '<input id=x value=old>', 'new', 'new'],
  ['empty fill clears text', '<input id=x value=old>', '', ''],
].map(([name, html, text, value]) => ({ name, html: html + events,
  run: async (page, mod) => {
    await page.locator('#x').click({ modifiers: mod }); await page.locator('#x').fill(text);
    return { value: await page.locator('#x').inputValue(), ...await counts(page) };
  }, want: { value, input: name.startsWith('textarea') ? 3 : 1, change: 0 } }));
typing.push({ name: 'pressSequentially emits per-character input', html: '<input id=x maxlength=3>' + events,
  run: async (page, mod) => {
    await page.locator('#x').click({ modifiers: mod }); await page.locator('#x').pressSequentially('abcd');
    return { value: await page.locator('#x').inputValue(), ...await counts(page) };
  }, want: { value: 'abc', input: 3, change: 0 } });
typing.push({ name: 'fill same value still dispatches input', html: '<input id=x value=same>' + events,
  run: async (page, mod) => {
    await page.locator('#x').click({ modifiers: mod }); await page.locator('#x').fill('same');
    return { value: await page.locator('#x').inputValue(), ...await counts(page) };
  }, want: { value: 'same', input: 1, change: 0 } });
for (const [name, attrs] of [['readonly fill refuses', 'readonly'], ['disabled fill refuses', 'disabled']]) typing.push({ name,
  html: `<button id=go>Prepare</button><input id=x ${attrs} value=old>` + events,
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod });
    return { rejected: await rejected(() => page.locator('#x').fill('new')), value: await page.locator('#x').inputValue(), ...await counts(page) };
  }, want: { rejected: true, value: 'old', input: 0, change: 0 } });
typing.push({ name: 'contenteditable fill replaces text', html: '<div id=x contenteditable>old</div>' + events,
  run: async (page, mod) => {
    await page.locator('#x').click({ modifiers: mod }); await page.locator('#x').fill('new 😀');
    return { text: await page.locator('#x').textContent(), ...await counts(page) };
  }, want: { text: 'new 😀', input: 1, change: 0 } });
for (const [name, html, key, value, input] of [
  ['input Enter does not insert newline', '<input id=x value=ab>', 'Enter', 'ab', 0],
  ['textarea Enter inserts newline', '<textarea id=x>ab</textarea>', 'Enter', 'ab\n', 1],
  ['Backspace removes whole emoji', '<input id=x value="A😀">', 'Backspace', 'A', 1],
]) typing.push({ name, html: html + events,
  run: async (page, mod) => {
    await page.locator('#x').click({ modifiers: mod }); await page.locator('#x').press('End'); await page.locator('#x').press(key);
    return { value: await page.locator('#x').inputValue(), ...await counts(page) };
  }, want: { value, input, change: 0 } });

const selectMarkup = `<button id=go>Prepare</button><select id=x SIZE MULTIPLE>
  <option value=a selected>A</option><optgroup label=Group><option value=b>B</option>
  <option value=c disabled>C</option></optgroup><optgroup disabled label=Disabled><option value=d>D</option></optgroup></select>`;
const selected = async page => page.locator('#x').evaluate(el => [...el.selectedOptions].map(o => o.value));
const selects = [
  ['single API', false, ['b'], ['b']], ['multiple API', true, ['a', 'b'], ['a', 'b']],
  ['single API takes first of many', false, ['a', 'b'], ['a']],
  ['multiple API clears selection', true, [], []],
  ['optgroup label selection', false, { label: 'B' }, ['b']],
  ['disabled option API refuses', false, ['c'], ['a']],
  ['disabled optgroup API refuses', false, ['d'], ['a']],
].map(([name, multiple, values, want]) => ({ name,
  html: selectMarkup.replace('SIZE', '').replace('MULTIPLE', multiple ? 'multiple' : '') + events,
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod });
    const refused = await rejected(() => page.locator('#x').selectOption(values));
    return { rejected: refused, selected: await selected(page), ...await counts(page) };
  }, want: { rejected: name.startsWith('disabled'), selected: want,
    input: name.startsWith('disabled') ? 0 : 1, change: name.startsWith('disabled') ? 0 : 1 } }));
for (const multiple of [false, true]) selects.push({ name: multiple ? 'multiple option click default' : 'single option click default',
  html: selectMarkup.replace('SIZE', 'size=4').replace('MULTIPLE', multiple ? 'multiple' : '') + events,
  run: async (page, mod) => {
    await page.locator('option[value=b]').click({ modifiers: mod });
    return { selected: await selected(page), ...await counts(page) };
  }, want: { selected: ['b'], input: 1, change: 1 },
  modified: { selected: multiple ? ['a', 'b'] : ['b'], input: 1, change: 1 } });
selects.push({ name: 'disabled option click refuses', html: selectMarkup.replace('SIZE', 'size=4').replace('MULTIPLE', '') + events,
  run: async (page, mod) => ({ rejected: await rejected(() => page.locator('option[value=c]').click({ modifiers: mod })), selected: await selected(page), ...await counts(page) }),
  want: { rejected: true, selected: ['a'], input: 0, change: 0 } });

const checks = [
  ['check false', '<input id=x type=checkbox>', 'check', true, 1],
  ['check true is idempotent', '<input id=x type=checkbox checked>', 'check', true, 0],
  ['uncheck true', '<input id=x type=checkbox checked>', 'uncheck', false, 1],
  ['uncheck false is idempotent', '<input id=x type=checkbox>', 'uncheck', false, 0],
  ['check indeterminate false', '<input id=x type=checkbox><script>x.indeterminate=true</script>', 'check', true, 1],
  ['uncheck indeterminate false', '<input id=x type=checkbox><script>x.indeterminate=true</script>', 'uncheck', false, 0],
  ['check wrapped label', '<label id=x>Wrapped<input id=control type=checkbox></label>', 'check', true, 1],
  ['check hidden input through label', '<label id=x for=control>Hidden</label><input id=control type=checkbox style="display:none">', 'check', true, 1],
].map(([name, html, op, checked, changes]) => ({ name, html: html + events,
  run: async (page, mod) => {
    await page.locator('#x')[op]({ modifiers: mod });
    return { ...await page.locator('input').evaluate(el => ({ checked: el.checked, indeterminate: el.indeterminate })), ...await counts(page) };
  }, want: { checked, indeterminate: name === 'uncheck indeterminate false', input: changes, change: changes } }));
checks.push({ name: 'hidden input direct check refuses', html: '<input id=x type=checkbox style="display:none">' + events,
  run: async (page, mod) => ({ rejected: await rejected(() => page.locator('#x').check({ modifiers: mod })), checked: await page.locator('#x').isChecked(), ...await counts(page) }),
  want: { rejected: true, checked: false, input: 0, change: 0 } });
checks.push({ name: 'label click clears indeterminate', html: '<label id=x><input id=control type=checkbox>Wrapped</label><script>control.indeterminate=true</script>' + events,
  run: async (page, mod) => {
    await page.locator('#x').click({ modifiers: mod });
    return { ...await page.locator('input').evaluate(el => ({ checked: el.checked, indeterminate: el.indeterminate })), ...await counts(page) };
  }, want: { checked: true, indeterminate: false, input: 1, change: 1 } });
checks.push({ name: 'radio click selects and deselects sibling', html: '<input id=first type=radio name=g checked><input id=x type=radio name=g>' + events,
  run: async (page, mod) => {
    await page.locator('#x').click({ modifiers: mod });
    return page.evaluate(() => ({ first: first.checked, second: x.checked }));
  }, want: { first: false, second: true } });

const drags = [{ name: 'HTML5 dragTo dispatches accepted drop', html: `<button id=go>Prepare</button>
  <div id=from draggable=true style="width:100px;height:60px;background:gray">Source</div>
  <div id=to style="margin-top:50px;width:100px;height:60px;background:lightgray">Target</div>
  <script>window.dragEvents=[];for(const type of ['dragstart','dragenter','dragover','drop','dragend'])
  document.addEventListener(type,e=>{dragEvents.push(type);if(type==='dragstart')e.dataTransfer.setData('text/plain','payload');
    if(type==='dragover')e.preventDefault();if(type==='drop'){e.preventDefault();window.dropped=e.dataTransfer.getData('text/plain')}});</script>`,
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); await page.locator('#from').dragTo(page.locator('#to'));
    return page.evaluate(() => ({ dropped: window.dropped, events: [...new Set(dragEvents)] }));
  }, want: { dropped: 'payload', events: ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'] } }];
drags.push({ ...drags[0], name: 'HTML5 drop requires cancelled dragover',
  html: drags[0].html.replace("if(type==='dragover')e.preventDefault();", ''),
  want: { dropped: undefined, events: ['dragstart', 'dragenter', 'dragover', 'dragend'] } });
drags.push({ name: 'pointer drag dispatches pointer sequence', html: `<button id=go>Prepare</button>
  <div id=x style="width:100px;height:100px;touch-action:none;background:gray"></div>
  <script>window.pointerEvents=[];x.onpointerdown=e=>{x.setPointerCapture(e.pointerId);pointerEvents.push('down')};
  x.onpointermove=e=>{if(e.buttons)pointerEvents.push('move')};x.onpointerup=e=>pointerEvents.push('up');</script>`,
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); const box = await page.locator('#x').boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 80, { steps: 3 }); await page.mouse.up();
    return page.evaluate(() => pointerEvents);
  }, want: ['down', 'move', 'move', 'move', 'up'] });
drags.push({ name: 'range pointer drag reaches maximum', html: '<button id=go>Prepare</button><input id=x type=range min=0 max=100 value=0 style="width:200px">' + events,
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod }); const box = await page.locator('#x').boundingBox();
    await page.mouse.move(box.x + 8, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
    return { value: await page.locator('#x').inputValue(), ...await counts(page) };
  }, want: { value: '100', input: 4, change: 1 } });
drags.push({ name: 'range click midpoint', html: '<input id=x type=range min=0 max=100 value=0 style="width:200px">' + events,
  run: async (page, mod) => {
    await page.locator('#x').click({ modifiers: mod }); return { value: await page.locator('#x').inputValue(), ...await counts(page) };
  }, want: { value: '50', input: 1, change: 1 } });

const payload = name => ({ name, mimeType: name.endsWith('.txt') ? 'text/plain' : 'image/png', buffer: Buffer.from('fixture bytes') });
const uploads = [
  ['visible file', '', ['one.txt'], false], ['hidden file', 'style="display:none"', ['one.txt'], false],
  ['multiple files', 'multiple', ['one.txt', 'two.txt'], false],
  ['single rejects multiple files', '', ['one.txt', 'two.txt'], true],
  ['accept does not filter setInputFiles', 'accept="image/png"', ['one.txt'], false],
  ['clear files', 'multiple', [], false],
].map(([name, attrs, names, rejects]) => ({ name,
  html: `<button id=go>Prepare</button><input id=x type=file ${attrs}>` + events,
  run: async (page, mod) => {
    await page.locator('#go').click({ modifiers: mod });
    const refused = await rejected(() => page.locator('#x').setInputFiles(names.map(payload)));
    return { rejected: refused, files: await page.locator('#x').evaluate(async el => Promise.all([...el.files].map(async f => ({ name: f.name, type: f.type, text: await f.text() })))), ...await counts(page) };
  }, want: { rejected: rejects, files: rejects ? [] : names.map(name => ({ name, type: 'text/plain', text: 'fixture bytes' })), input: rejects ? 0 : 1, change: rejects ? 0 : 1 } }));

test('AT1 control behavior atlas on pinned Chromium 1248', { skip, timeout: 240000 }, t =>
  atlas(t, [['typing', typing], ['select', selects], ['check-uncheck', checks], ['drag', drags], ['upload', uploads]]));
