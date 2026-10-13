| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| shipping-link | sleight | chrome | ok | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 0 | 11 s, 11 s net / 120 | 3 calls, 1 actions | in 8, write 41796, read 105628, out 1384, total 148816 | 0.010 |
| size-guide | sleight | helium | ok | ok | n/a | ok | FAIL: 2 | ok | left 1, extra 0, controlled 0 | 106 s, 106 s net / 120 | 15 calls, 4 actions, 2 errors | in 36, write 47953, read 676421, out 4032, total 728442 | 0.018 |
| demoid | sleight | chrome | ok | ok | n/a | ok | FAIL: 3 | ok | left 1, extra 0, controlled 0 | 20 s, 20 s net / 120 | 6 calls, 2 actions | in 14, write 41473, read 224851, out 2336, total 268674 | 0.012 |

ROUND NOT CLEAN: 9 problems

- shipping-link · tabs · left at turn end: chrome:1466195289 http://127.0.0.1:5420/t/shipping-link/shop/
- shipping-link · tabs · left at turn end: chrome:1466195300 http://127.0.0.1:5420/t/shipping-link/shop/shipping
- size-guide · flash · 08:06:33 a popup window 684986471 opened in helium with helium:684986470, last tool js
- size-guide · flash · 08:06:33 helium window 684986471 took focus after size-guide's flash, last tool js
- size-guide · tabs · left at turn end: helium:684986474 http://127.0.0.1:5420/t/size-guide/shop/size-guide
- demoid · flash · 08:06:25 a popup window 1466195296 opened in chrome with chrome:1466195295, last tool js
- demoid · flash · 08:06:25 chrome:1466195295 became the active tab of chrome window 1466195296 and stayed, last tool js
- demoid · flash · 08:06:25 chrome window 1466195296 took focus after demoid's flash, last tool js
- demoid · tabs · left at turn end: chrome:1466195292 http://127.0.0.1:5420/t/demoid/shop/account

Not counted, no agent caused it (the user using their Mac):
- 08:06:25 Google Chrome came to the front
- 08:06:33 helium:684986470 became the active tab of helium window 684986471 and stayed (the user browsing that window)
- 08:06:33 Helium came to the front

Answers:
- shipping-link: RESULT: Express shipping costs $12.40
- size-guide: RESULT: The large mug is 11 cm tall.
- demoid: RESULT: Robin Vale
