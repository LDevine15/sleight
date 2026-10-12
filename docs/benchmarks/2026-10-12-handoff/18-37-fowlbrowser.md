## r-invoice-preview

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| invoice-preview | fowlbrowser | chrome | ok | FAIL: 1 | 1/1 | ok | ok | ok | ok | 46 s, 46 s net / 180 | 3 calls | in 14, write 37977, read 213335, out 2358, total 253684 | 0.459 |

ROUND NOT CLEAN: 1 problems

- invoice-preview · native · missing /tmp/fb-rounds/handoff-2026-10-12T18-37-05-984Z-fowlbrowser/r-invoice-preview/invoice-preview/invoice.pdf

Answers:
- invoice-preview: RESULT: not read in Preview, because I couldn't open Preview. The web page shows $1,247.50 for INV-4419, but I haven't checked it in Preview.

## r-note-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| note-textedit | fowlbrowser | chrome | ok | ok | 0/0 | ok | ok | ok | ok | 3 s, 3 s net / 180 | 2 calls | in 4, write 855, read 35728, out 99, total 36686 | 0.212 |

ROUND NOT CLEAN: 1 problems

- note-textedit · cursor · no pointer actions recorded

Answers:
- note-textedit: RESULT: Saved note.txt with line 1 "Delivery note" and line 2 "Leave the blue crate at loading bay 4 before 14:30."

## r-table-textedit

| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| table-textedit | fowlbrowser | helium | FAIL: exit none (killed after 20 s); answer does not match /Mira Hale/; answer does not match /Jonah Whitfield/; answer does not match /Aiko Brennan/ | FAIL: 1 | 4/4 | ok | ok | ok | ok | 63 s, 63 s net / 180 | 10 calls | in 24, write 37160, read 476790, out 3180, total 517154 | 0.469 |

ROUND NOT CLEAN: 5 problems

- table-textedit · outcome · exit none (killed after 20 s)
- table-textedit · outcome · answer does not match /Mira Hale/
- table-textedit · outcome · answer does not match /Jonah Whitfield/
- table-textedit · outcome · answer does not match /Aiko Brennan/
- table-textedit · native · missing /tmp/fb-rounds/handoff-2026-10-12T18-37-05-984Z-fowlbrowser/r-table-textedit/table-textedit/roster.txt

Answers:
- table-textedit: (none)

