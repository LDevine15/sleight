import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rootWindowId, popupWindows } from '../plugins/sleight/lib/popup-window.mjs';

// Root lines as the engine printed them in the Safari and Firefox demoid runs (2026-10-19).
const safari = (title, uuid) => `Window: "${title}", App: Safari.\n0 standard window ${title}, ID: SafariWindow?IsSecure=false&UUID=${uuid}, Secondary Actions: Raise\n\t1 split group`;
test('rootWindowId reads the ID on the last tree\'s standard-window root', () => {
  assert.equal(rootWindowId(safari('sleight benchmark — DemoID', 'C607')), 'SafariWindow?IsSecure=false&UUID=C607');
  // A diff result keeps the root line.
  assert.equal(rootWindowId('Window: "a", App: Safari.\n0 standard window a, ID: W1, Secondary Actions: Raise\nsleight: no change since the last full tree you saw for this window.'), 'W1');
  // The last tree wins.
  assert.equal(rootWindowId(safari('a', '1') + '\n' + safari('b', '2')), 'SafariWindow?IsSecure=false&UUID=2');
  // A title that itself holds ", ID: " is skipped before the ID is read.
  assert.equal(rootWindowId('Window: "x, ID: fake", App: Notes.\n0 standard window x, ID: fake, ID: real'), 'real');
  // No ID (Firefox), a sheet root, no root line, or no header.
  assert.equal(rootWindowId('Window: "DemoID", App: Firefox.\n0 standard window DemoID, Secondary Actions: Raise'), undefined);
  assert.equal(rootWindowId('Window: "a", App: TextEdit.\n0 sheet, ID: S1'), undefined);
  assert.equal(rootWindowId('Window: "a", App: TextEdit.'), undefined);
  assert.equal(rootWindowId('done'), undefined);
  assert.equal(rootWindowId(undefined), undefined);
});
test('popupWindows names a new ID as a pop-up after a one-window count, and its opener when the app returns to it', () => {
  const shop = { title: 'Shop', app: 'Safari', url: null, rootId: 'A' }, popup = { title: 'DemoID', app: 'Safari', url: null, rootId: 'B' };
  const one = { status: 'responding', windows: 1, windowTitles: ['Shop'] };
  // No count yet: a new ID claims nothing (it may be a window the owner had open).
  let p = popupWindows();
  p.see('A');
  assert.equal(p.note(shop, popup), undefined);
  // Two windows counted, or the counted window isn't the one the read showed, or no ID, or no titles: still nothing.
  for (const [health, title, id] of [[{ ...one, windows: 2, windowTitles: ['Shop', 'Mail'] }, 'Shop', 'A'], [one, 'Mail', 'A'],
    [one, 'Shop', undefined], [{ status: 'responding', windows: 1 }, 'Shop', 'A'], [{ status: 'denied' }, 'Shop', 'A'], [undefined, 'Shop', 'A']]) {
    p = popupWindows();
    p.count('Safari', health, title, id); p.see('A');
    assert.equal(p.note(shop, popup), undefined, JSON.stringify(health));
  }
  p = popupWindows();
  p.count('Safari', one, 'Shop', 'A'); p.see('A');
  assert.match(p.note(shop, popup), /^Your last read showed the app's only window, so an action since opened this one \(a pop-up, say\), part of the task in "Shop" in Safari\.$/);
  assert.match(p.note(popup, { ...shop, title: 'Account' }), /^It has the window ID of "Shop" in Safari, the pop-up's opener\.$/);
  // Both IDs are known now: going back and forth adds nothing.
  assert.equal(p.note(shop, popup), undefined);
  // Another app, a missing ID or the same ID adds nothing.
  assert.equal(p.note(shop, { ...popup, app: 'Firefox', rootId: 'C' }), undefined);
  assert.equal(p.note(shop, { ...popup, rootId: undefined }), undefined);
  assert.equal(p.note(shop, { ...popup, rootId: 'A' }), undefined);
  assert.equal(p.note(undefined, { ...popup, rootId: 'D' }), undefined);
  // A later count of two windows ends the census for new IDs.
  p.count('Safari', { ...one, windows: 2, windowTitles: ['Shop', 'DemoID'] }, 'Shop', 'A');
  assert.equal(p.note(shop, { ...popup, rootId: 'E' }), undefined);
});
