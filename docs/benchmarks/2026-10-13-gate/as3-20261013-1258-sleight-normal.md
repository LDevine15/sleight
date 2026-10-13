| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| form-travel | sleight | chrome | FAIL, score 0/11 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 247 s, 247 s net / 330 | 37 calls, 31 actions, 9 errors | in 76, write 75224, read 1963493, out 22265, total 2061058 | 0.046 |
| form-settings | sleight | chrome | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 155 s, 155 s net / 180 | 29 calls, 13 actions, 6 errors | in 60, write 62614, read 1438364, out 17089, total 1518127 | 0.035 |
| form-checkout | sleight | helium | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 131 s, 131 s net / 240 | 24 calls, 12 actions, 8 errors | in 50, write 53497, read 1109987, out 11256, total 1174790 | 0.027 |
| form-settings-helium | sleight | helium | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 85 s, 85 s net / 180 | 16 calls, 28 actions, 4 errors | in 34, write 72930, read 867529, out 14161, total 954654 | 0.030 |

ROUND NOT CLEAN: 20 problems

- form-travel · outcome · nothing submitted
- form-travel · tabs · left at turn end: chrome:1466195258 http://127.0.0.1:5413/travel
- form-travel · tabs · left at turn end: chrome:1466195700 http://127.0.0.1:5413/travel
- form-travel · tabs · still controlled after the session ended: chrome:1466195258 http://127.0.0.1:5413/travel
- form-travel · tabs · still controlled after the session ended: chrome:1466195700 http://127.0.0.1:5413/travel
- form-settings · outcome · nothing submitted
- form-settings · tabs · left at turn end: chrome:1466195261 http://127.0.0.1:5413/settings
- form-settings · tabs · left at turn end: chrome:1466195697 http://127.0.0.1:5413/settings
- form-settings · tabs · still controlled after the session ended: chrome:1466195261 http://127.0.0.1:5413/settings
- form-settings · tabs · still controlled after the session ended: chrome:1466195697 http://127.0.0.1:5413/settings
- form-checkout · outcome · nothing submitted
- form-checkout · tabs · left at turn end: helium:684986663 http://127.0.0.1:5413/checkout
- form-checkout · tabs · left at turn end: helium:684986665 http://127.0.0.1:5413/checkout
- form-checkout · tabs · still controlled after the session ended: helium:684986663 http://127.0.0.1:5413/checkout
- form-checkout · tabs · still controlled after the session ended: helium:684986665 http://127.0.0.1:5413/checkout
- form-settings-helium · outcome · nothing submitted
- form-settings-helium · tabs · left at turn end: helium:684986465 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · left at turn end: helium:684986664 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · still controlled after the session ended: helium:684986465 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · still controlled after the session ended: helium:684986664 http://127.0.0.1:5413/settings

Answers:
- form-travel: RESULT: not submitted, no submission id (blocked selecting departure airport MAO on the Destination step).
- form-settings: RESULT: not submitted, so no submission id yet.
- form-checkout: RESULT: no submission id; the checkout was not submitted (Pay now confirm dialog dismissed, tab unresponsive).
- form-settings-helium: RESULT: not submitted; two-factor authentication could not be set, so no submission id exists yet.
