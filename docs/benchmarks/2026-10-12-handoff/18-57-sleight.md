## r-invoice-preview

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| invoice-preview | sleight | chrome | ok | ok | n/a | ok | ok | ok | left 3, extra 0, controlled 0 | 149 s, 149 s net / 180 | 30 calls, 28 actions, 7 errors, 1 kernel resets, 2 debugger lost | in 62, write 121434, read 2189207, out 6984, total 2317687 | 1.549 |

ROUND NOT CLEAN: 7 problems

- invoice-preview · tabs · left at turn end: chrome:1466193587 http://127.0.0.1:5431/t/invoice-preview/
- invoice-preview · tabs · left at turn end: chrome:1466193588 about:blank
- invoice-preview · tabs · left at turn end: chrome:1466193589 http://127.0.0.1:5431/t/invoice-preview/
- invoice-preview · calls · 14:59:31 reached for desktop apps instead of the browser: let chrome = await cua.getApp("Google Chrome");
- invoice-preview · calls · 14:59:55 reached for desktop apps instead of the browser: let fin = await cua.getApp("Finder");
- invoice-preview · calls · 15:00:15 reached for desktop apps instead of the browser: let pv = await cua.getApp("Preview");
- invoice-preview · calls · 15:00:45 reached for desktop apps instead of the browser: let te = await cua.getApp("TextEdit");

Not counted, no agent caused it (the user using their Mac):
- 15:00:00 Google Chrome came to the front

Answers:
- invoice-preview: RESULT: The invoice total shown in Preview is $1,247.50 (invoice INV-4419).

## r-note-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| note-textedit | sleight | chrome | ok | ok | n/a | ok | ok | ok | left 1, extra 0, controlled 0 | 28 s, 28 s net / 180 | 6 calls, 9 actions | in 14, write 44387, read 234579, out 1112, total 280092 | 0.424 |

ROUND NOT CLEAN: 2 problems

- note-textedit · tabs · left at turn end: chrome:1466193593 http://127.0.0.1:5431/t/note-textedit/
- note-textedit · calls · 15:02:05 reached for desktop apps instead of the browser: let app = await cua.getApp("TextEdit");

Answers:
- note-textedit: RESULT: Saved note.txt with "Delivery note" on line 1 and "Leave the blue crate at loading bay 4 before 14:30." on line 2.

## r-table-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| table-textedit | sleight | helium | ok | ok | n/a | ok | ok | ok | left 1, extra 0, controlled 0 | 26 s, 26 s net / 180 | 5 calls, 9 actions | in 12, write 44399, read 198226, out 1191, total 243828 | 0.419 |

ROUND NOT CLEAN: 2 problems

- table-textedit · tabs · left at turn end: helium:684984923 http://127.0.0.1:5431/t/table-textedit/
- table-textedit · calls · 15:01:33 reached for desktop apps instead of the browser: let app = await cua.getApp("TextEdit");
await app.pressKey("super+n");

Answers:
- table-textedit: RESULT: Mira Hale 12.5, Jonah Whitfield 8.0, Aiko Brennan 20.0

