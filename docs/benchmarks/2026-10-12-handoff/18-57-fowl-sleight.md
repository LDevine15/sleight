## r-invoice-preview

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| invoice-preview | fowl+sleight | chrome | ok | ok | n/a | ok | ok | ok | ok | 85 s, 85 s net / 180 | 16 calls, 25 actions, 2 errors | in 36, write 72553, read 673872, out 3129, total 749590 | 0.778 |

ROUND NOT CLEAN: 2 problems

- invoice-preview · calls · 15:02:52 reached for desktop apps instead of the browser: let app = await cua.getApp("Preview");
- invoice-preview · calls · 15:03:26 reached for desktop apps instead of the browser: let te = await cua.getApp("TextEdit");

Answers:
- invoice-preview: RESULT: The invoice total shown in Preview is $1,247.50 (invoice INV-4419).

## r-note-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| note-textedit | fowl+sleight | chrome | ok | ok | n/a | ok | ok | ok | ok | 29 s, 29 s net / 180 | 6 calls, 10 actions | in 16, write 40354, read 227031, out 1369, total 268770 | 0.396 |

ROUND NOT CLEAN: 2 problems

- note-textedit · calls · 15:04:43 reached for desktop apps instead of the browser: let app = await cua.getApp("TextEdit")
- note-textedit · calls · 15:04:50 reached for desktop apps instead of the browser: app = await cua.getApp("TextEdit");
await app.pressKey("super+shift+t");
await app.getAXState()

Answers:
- note-textedit: RESULT: Saved note.txt with "Delivery note" on line 1 and "Leave the blue crate at loading bay 4 before 14:30." on line 2.

## r-table-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| table-textedit | fowl+sleight | helium | ok | ok | n/a | ok | ok | ok | ok | 29 s, 29 s net / 180 | 6 calls, 10 actions | in 16, write 39946, read 228225, out 1528, total 269715 | 0.396 |

ROUND NOT CLEAN: 1 problems

- table-textedit · calls · 15:04:08 reached for desktop apps instead of the browser: let app = await cua.getApp("TextEdit")

Answers:
- table-textedit: RESULT: Mira Hale 12.5, Jonah Whitfield 8.0, Aiko Brennan 20.0

