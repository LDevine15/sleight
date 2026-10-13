| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| form-travel | sleight | chrome | ok, score 11/11 | ok | n/a | ok | ok | ok | left 3, extra 0, controlled 1 | 227 s, 227 s net / 330 | 44 calls, 36 actions, 13 errors, 2 debugger lost | in 90, write 86158, read 2511110, out 25205, total 2622563 | 0.055 |
| form-settings | sleight | chrome | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 3, extra 0, controlled 2 | 128 s, 128 s net / 180 | 30 calls, 11 actions, 10 errors, 5 debugger lost | in 62, write 72460, read 1513881, out 14350, total 1600753 | 0.037 |
| form-checkout | sleight | helium | ok, score 10/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 1 | 40 s, 40 s net / 240 | 11 calls, 13 actions, 1 errors | in 24, write 45771, read 452076, out 5406, total 503277 | 0.016 |
| form-settings-helium | sleight | helium | ok, score 10/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 1 | 89 s, 89 s net / 180 | 23 calls, 14 actions, 2 errors | in 48, write 68780, read 1187397, out 11733, total 1267958 | 0.032 |

ROUND NOT CLEAN: 18 problems

- form-travel · tabs · left at turn end: chrome:1466195258 http://127.0.0.1:5413/travel
- form-travel · tabs · left at turn end: chrome:1466195545 http://127.0.0.1:5413/travel
- form-travel · tabs · left at turn end: chrome:1466195548 http://127.0.0.1:5413/travel
- form-travel · tabs · still controlled after the session ended: chrome:1466195258 http://127.0.0.1:5413/travel
- form-settings · outcome · nothing submitted
- form-settings · tabs · left at turn end: chrome:1466195261 http://127.0.0.1:5413/settings
- form-settings · tabs · left at turn end: chrome:1466195542 http://127.0.0.1:5413/settings
- form-settings · tabs · left at turn end: chrome:1466195551 http://127.0.0.1:5413/settings
- form-settings · tabs · still controlled after the session ended: chrome:1466195261 http://127.0.0.1:5413/settings
- form-settings · tabs · still controlled after the session ended: chrome:1466195551 http://127.0.0.1:5413/settings
- form-settings · calls · 11:48:12 reached for desktop apps instead of the browser: const chrome = await cua.getApp("Google Chrome");
const ax = await chrome.getAXState({ disableDiffing: true });
const txt = String(ax);
const i = txt.indexOf('T
- form-checkout · tabs · left at turn end: helium:684986436 http://127.0.0.1:5413/checkout
- form-checkout · tabs · left at turn end: helium:684986589 http://127.0.0.1:5413/checkout
- form-checkout · tabs · still controlled after the session ended: helium:684986436 http://127.0.0.1:5413/checkout
- form-settings-helium · tabs · left at turn end: helium:684986465 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · left at turn end: helium:684986590 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · still controlled after the session ended: helium:684986465 http://127.0.0.1:5413/settings
- form-settings-helium · calls · 11:47:26 reached for desktop apps instead of the browser: const hel = await cua.getApp('Helium')
const ax = await hel.getAXState({ disableDiffing: true })
nodeRepl.write(String(ax).split('\n').filter(l => /Two-factor|s

Answers:
- form-travel: RESULT: SUB-0003-ZCJ8
- form-settings: RESULT: not submitted. The two-factor authentication toggle could not be turned on, so no submission id was created.
- form-checkout: RESULT: SUB-0001-DLUM
- form-settings-helium: RESULT: submission id SUB-0002-3MAB
