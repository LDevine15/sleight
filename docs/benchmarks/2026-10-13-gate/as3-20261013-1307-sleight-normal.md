| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| form-travel | sleight | chrome | FAIL: stopped after 4 times its budget without a result; exit none; no result event, score 0/11 | ok | n/a | ok | ok | ok | left 1, extra 0, controlled 1 | 0 s, 0 s net / 330 | 14 calls, 21 actions, 4 errors | in 0, write 0, read 0, out 0, total 0 | not available |
| form-settings | sleight | chrome | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 141 s, 141 s net / 180 | 30 calls, 11 actions, 5 errors | in 62, write 66416, read 1574963, out 19554, total 1660995 | 0.039 |
| form-checkout | sleight | helium | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 150 s, 150 s net / 240 | 20 calls, 11 actions, 6 errors | in 42, write 62856, read 895114, out 9752, total 967764 | 0.026 |
| form-settings-helium | sleight | helium | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 1 | 93 s, 93 s net / 180 | 18 calls, 13 actions, 3 errors | in 38, write 75202, read 1039193, out 15380, total 1129813 | 0.033 |

ROUND NOT CLEAN: 22 problems

- form-travel · outcome · stopped after 4 times its budget without a result
- form-travel · outcome · exit none
- form-travel · outcome · no result event
- form-travel · outcome · nothing submitted
- form-travel · tabs · left at turn end: chrome:1466195258 http://127.0.0.1:5413/travel
- form-travel · tabs · still controlled after the session ended: chrome:1466195258 http://127.0.0.1:5413/travel
- form-settings · outcome · nothing submitted
- form-settings · tabs · left at turn end: chrome:1466195261 http://127.0.0.1:5413/settings
- form-settings · tabs · left at turn end: chrome:1466195713 http://127.0.0.1:5413/settings
- form-settings · tabs · still controlled after the session ended: chrome:1466195261 http://127.0.0.1:5413/settings
- form-settings · tabs · still controlled after the session ended: chrome:1466195713 http://127.0.0.1:5413/settings
- form-checkout · outcome · nothing submitted
- form-checkout · tabs · left at turn end: helium:684986663 http://127.0.0.1:5413/checkout
- form-checkout · tabs · left at turn end: helium:684986673 http://127.0.0.1:5413/checkout
- form-checkout · tabs · still controlled after the session ended: helium:684986663 http://127.0.0.1:5413/checkout
- form-checkout · tabs · still controlled after the session ended: helium:684986673 http://127.0.0.1:5413/checkout
- form-checkout · calls · 13:09:22 reached for desktop apps instead of the browser: const app = await cua.getApp("Helium");
nodeRepl.write(String(app.getAXState ? 'has getAXState' : 'no'));
const st = await app.getAXState({ disableDiffing: true
- form-settings-helium · outcome · nothing submitted
- form-settings-helium · tabs · left at turn end: helium:684986465 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · left at turn end: helium:684986672 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · still controlled after the session ended: helium:684986465 http://127.0.0.1:5413/settings
- form-settings-helium · calls · 13:07:42 reached for desktop apps instead of the browser: let app2 = await cua.getApp("Helium");
const t = await app2.getAXState({ disableDiffing: true });
nodeRepl.write(String(t).slice(0, 4000));

Answers:
- form-travel: (none)
- form-settings: RESULT: not submitted (two-factor setting could not be set or verified)
- form-checkout: RESULT: not submitted; payment confirmation pending on checkout tab, no submission id yet.
- form-settings-helium: RESULT: not submitted; no submission id yet (blocked on the two-factor switch)
