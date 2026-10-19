import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootWindowId, popupWindows } from '../plugins/sleight/lib/popup-window.mjs';

// Root lines as the engine printed them in the Safari and Firefox demoid runs (2026-10-19).
const U1 = '21DC5D95-E1C6-4AD6-8D51-F8B091FD8556', U2 = '77813D3A-B855-42CE-9CCD-5AFDCD80E5A4';
const safari = (title, uuid, secure = false) => `Window: "${title}", App: Safari.\n0 standard window ${title}, ID: SafariWindow?IsSecure=${secure}&UUID=${uuid}, Secondary Actions: Raise\n\t1 split group`;
test('rootWindowId reads the ID on the last tree\'s standard-window root, by its UUID when it has one', () => {
  assert.equal(rootWindowId(safari('sleight benchmark — DemoID', U1)), U1);
  assert.equal(rootWindowId(safari('a', U1.toLowerCase(), true)), U1);
  // A diff result keeps the root line.
  assert.equal(rootWindowId('Window: "a", App: Safari.\n0 standard window a, ID: W1, Secondary Actions: Raise\nsleight: no change since the last full tree you saw for this window.'), 'W1');
  // The last tree wins.
  assert.equal(rootWindowId(safari('a', U1) + '\n' + safari('b', U2)), U2);
  // A title that itself holds ", ID: " is skipped before the ID is read, and an empty title has none to skip.
  assert.equal(rootWindowId('Window: "x, ID: fake", App: Notes.\n0 standard window x, ID: fake, ID: real'), 'real');
  assert.equal(rootWindowId('Window: "", App: Notes.\n0 standard window, ID: w7, Secondary Actions: Raise'), 'w7');
  // No ID (Firefox), a sheet root, no root line, or no header.
  assert.equal(rootWindowId('Window: "DemoID", App: Firefox.\n0 standard window DemoID, Secondary Actions: Raise'), undefined);
  assert.equal(rootWindowId('Window: "a", App: TextEdit.\n0 sheet, ID: S1'), undefined);
  assert.equal(rootWindowId('Window: "a", App: TextEdit.'), undefined);
  assert.equal(rootWindowId('done'), undefined);
  assert.equal(rootWindowId(undefined), undefined);
});
test('popupWindows names a new ID as a pop-up after a one-window count of the window acted on, once', () => {
  const shop = { title: 'Shop', app: 'Safari', url: null, rootId: 'A' }, popup = { title: 'DemoID', app: 'Safari', url: null, rootId: 'B' };
  // The probe's answer for one window, as app-health.js gives it (no titles).
  const one = { status: 'responding', windows: 1, allWindows: 1 };
  // No count, two windows, another Space's window, no answer, a failed probe, or no ID: nothing.
  for (const health of [null, { ...one, windows: 2, windowTitles: ['Shop', 'Mail'], allWindows: 2 }, { ...one, allWindows: 2 },
    { status: 'timeout' }, { status: 'denied' }]) {
    const p = popupWindows();
    p.count('Safari', health, 'A');
    assert.equal(p.note(shop, popup), undefined, JSON.stringify(health));
  }
  let p = popupWindows();
  p.count('Safari', one, undefined);
  assert.equal(p.note(shop, popup), undefined);
  // A read with no probe keeps the count; a stopped call drops it.
  p = popupWindows();
  p.count('Safari', one, 'A'); p.count('Safari', undefined, 'A');
  p.drop('Safari');
  assert.equal(p.note(shop, popup), undefined);
  // Counted, but the action ran in another window.
  p = popupWindows();
  p.count('Safari', one, 'A');
  assert.equal(p.note({ ...shop, rootId: 'M' }, popup), undefined);
  p = popupWindows();
  p.count('Safari', one, 'A'); p.count('Safari', undefined, 'A');
  assert.match(p.note(shop, popup), /^An earlier read counted "Shop" in Safari as the app's only window, so this newer one belongs to its task \(a pop-up, say\)\.$/);
  assert.match(p.note(popup, { ...shop, title: 'Account' }), /^It has the ID of "Shop" in Safari, the pop-up's opener\.$/);
  // Both IDs are known now, and the count is used: nothing more.
  assert.equal(p.note(shop, popup), undefined);
  assert.equal(p.note(shop, { ...popup, rootId: 'E' }), undefined);
  // Another app, a missing ID or the same ID adds nothing.
  p.count('Safari', one, 'A');
  assert.equal(p.note(shop, { ...popup, app: 'Firefox', rootId: 'C' }), undefined);
  assert.equal(p.note(shop, { ...popup, rootId: undefined }), undefined);
  assert.equal(p.note(shop, { ...popup, rootId: 'A' }), undefined);
  assert.equal(p.note(undefined, { ...popup, rootId: 'D' }), undefined);
  // `see` stays usable on its own.
  const { see } = p; see('Z');
});
