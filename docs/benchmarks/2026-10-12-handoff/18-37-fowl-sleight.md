## r-invoice-preview

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| invoice-preview | fowl+sleight | chrome | ok | FAIL: 1 | n/a | ok | ok | ok | ok | 153 s, 153 s net / 180 | 23 calls, 21 actions, 6 errors | in 52, write 66659, read 1369002, out 3883, total 1439596 | 0.685 |

ROUND NOT CLEAN: 5 problems

- invoice-preview · native · /tmp/fb-rounds/handoff-2026-10-12T18-37-05-984Z-fowl+sleight/r-invoice-preview/invoice-preview/invoice-total.txt is missing the Preview read-back total 1,247.50
- invoice-preview · calls · 14:42:20 reached for desktop apps instead of the browser: let app = await cua.getApp("Preview"); await app.getAXState({ disableDiffing: true });
- invoice-preview · calls · 14:43:12 reached for desktop apps instead of the browser: let te = await cua.getApp("TextEdit");
- invoice-preview · calls · 14:44:01 reached for desktop apps instead of the browser: te = await cua.getApp("TextEdit");
- invoice-preview · calls · 14:44:25 reached for desktop apps instead of the browser: await new Promise(r=>setTimeout(r,25000)); te = await cua.getApp("TextEdit");

Answers:
- invoice-preview: RESULT: The invoice total shown in Preview is $1,247.50 (invoice INV-4419).

## r-note-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| note-textedit | fowl+sleight | chrome | ok | ok | n/a | ok | ok | ok | ok | 43 s, 43 s net / 180 | 7 calls, 11 actions | in 20, write 52433, read 403046, out 1679, total 457178 | 0.376 |

ROUND NOT CLEAN: 2 problems

- note-textedit · calls · 14:46:08 reached for desktop apps instead of the browser: let app = await cua.getApp("TextEdit");
- note-textedit · calls · 14:46:18 reached for desktop apps instead of the browser: app = await cua.getApp("TextEdit");
await app.pressKey("super+shift+t");
await app.getAXState();

Answers:
- note-textedit: RESULT: Saved note.txt with "Delivery note" on line 1 and "Leave the blue crate at loading bay 4 before 14:30." on line 2.

## r-table-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| table-textedit | fowl+sleight | helium | ok | ok | n/a | ok | ok | ok | ok | 54 s, 54 s net / 180 | 8 calls, 16 actions, 1 errors | in 20, write 60142, read 425198, out 2080, total 487440 | 0.427 |

ROUND NOT CLEAN: 3 problems

- table-textedit · calls · 14:45:14 reached for desktop apps instead of the browser: let app = await cua.getApp("TextEdit");
- table-textedit · calls · 14:45:24 reached for desktop apps instead of the browser: app = await cua.getApp("TextEdit");
await app.pressKey("cmd+shift+t");
nodeRepl.write(await app.getAXState());
- table-textedit · calls · 14:45:36 reached for desktop apps instead of the browser: app = await cua.getApp("TextEdit");
await app.pressKey("super+shift+g");
await app.typeText("/tmp/fb-rounds/handoff-2026-10-12T18-37-05-984Z-fowl+sleight/r-tabl

Answers:
- table-textedit: RESULT: Mira Hale 12.5 hours, Jonah Whitfield 8.0 hours, Aiko Brennan 20.0 hours.

