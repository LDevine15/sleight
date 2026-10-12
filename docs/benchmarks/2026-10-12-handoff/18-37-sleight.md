## r-invoice-preview

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| invoice-preview | sleight | chrome | ok | FAIL: 1 | n/a | ok | ok | ok | left 1, extra 0, controlled 0 | 14 s, 14 s net / 180 | 2 calls, 0 actions, 1 errors | in 6, write 34767, read 90716, out 857, total 126346 | 0.209 |

ROUND NOT CLEAN: 2 problems

- invoice-preview · native · missing /tmp/fb-rounds/handoff-2026-10-12T18-37-05-984Z-sleight/r-invoice-preview/invoice-preview/invoice.pdf
- invoice-preview · tabs · left at turn end: chrome:1466193558 http://127.0.0.1:5431/t/invoice-preview/

Answers:
- invoice-preview: RESULT: Not available — the download was blocked, so the invoice was never opened in Preview (the web page shows $1,247.50, not checked against the PDF).

## r-note-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| note-textedit | sleight | chrome | ok | ok | n/a | ok | ok | ok | left 1, extra 0, controlled 0 | 43 s, 43 s net / 180 | 8 calls, 14 actions, 1 errors | in 18, write 62905, read 460619, out 1746, total 525288 | 0.442 |

ROUND NOT CLEAN: 3 problems

- note-textedit · tabs · left at turn end: chrome:1466193560 http://127.0.0.1:5431/t/note-textedit/
- note-textedit · calls · 14:41:24 reached for desktop apps instead of the browser: let app = await cua.getApp("TextEdit");
- note-textedit · calls · 14:41:30 reached for desktop apps instead of the browser: app = await cua.getApp("TextEdit");

Answers:
- note-textedit: RESULT: note.txt saved with "Delivery note" on line 1 and "Leave the blue crate at loading bay 4 before 14:30." on line 2.

## r-table-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| table-textedit | sleight | helium | ok | ok | n/a | ok | ok | ok | left 1, extra 0, controlled 0 | 50 s, 50 s net / 180 | 13 calls, 11 actions, 2 errors | in 24, write 99883, read 730936, out 2682, total 833525 | 0.699 |

ROUND NOT CLEAN: 5 problems

- table-textedit · tabs · left at turn end: helium:684984898 http://127.0.0.1:5431/t/table-textedit/
- table-textedit · calls · 14:40:28 reached for desktop apps instead of the browser: const rows = await tab.playwright.locator('table tr').evaluateAll(trs => trs.map(tr => [...tr.cells].map(c => c.innerText.trim()).join('\t')));
nodeRepl.write(J
- table-textedit · calls · 14:40:30 reached for desktop apps instead of the browser: let app = await cua.getApp("TextEdit")
- table-textedit · calls · 14:40:35 reached for desktop apps instead of the browser: app = await cua.getApp("TextEdit")
- table-textedit · calls · 14:40:43 reached for desktop apps instead of the browser: app = await cua.getApp("TextEdit")

Answers:
- table-textedit: RESULT: Mira Hale 12.5, Jonah Whitfield 8.0, Aiko Brennan 20.0

