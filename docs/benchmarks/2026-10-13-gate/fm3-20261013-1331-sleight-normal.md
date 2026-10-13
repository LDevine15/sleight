| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| form-travel | sleight | chrome | ok, score 11/11 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 1 | 165 s, 165 s net / 330 | 35 calls, 31 actions, 11 errors | in 72, write 92522, read 1886948, out 17426, total 1996968 | 0.046 |
| form-settings | sleight | chrome | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 83 s, 83 s net / 180 | 17 calls, 10 actions, 2 errors | in 36, write 61357, read 802928, out 12046, total 876367 | 0.026 |
| form-checkout | sleight | helium | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 150 s, 150 s net / 240 | 30 calls, 12 actions, 7 errors | in 62, write 55863, read 1394524, out 13719, total 1464168 | 0.032 |
| form-settings-helium | sleight | helium | FAIL, score 0/10 | ok | n/a | ok | ok | ok | left 2, extra 0, controlled 2 | 93 s, 93 s net / 180 | 22 calls, 11 actions, 2 errors | in 46, write 63454, read 1064735, out 15982, total 1144217 | 0.031 |

ROUND NOT CLEAN: 18 problems

- form-travel · tabs · left at turn end: chrome:1466195258 http://127.0.0.1:5413/travel
- form-travel · tabs · left at turn end: chrome:1466195721 http://127.0.0.1:5413/travel
- form-travel · tabs · still controlled after the session ended: chrome:1466195258 http://127.0.0.1:5413/travel
- form-settings · outcome · nothing submitted
- form-settings · tabs · left at turn end: chrome:1466195261 http://127.0.0.1:5413/settings
- form-settings · tabs · left at turn end: chrome:1466195724 http://127.0.0.1:5413/settings
- form-settings · tabs · still controlled after the session ended: chrome:1466195261 http://127.0.0.1:5413/settings
- form-settings · tabs · still controlled after the session ended: chrome:1466195724 http://127.0.0.1:5413/settings
- form-checkout · outcome · nothing submitted
- form-checkout · tabs · left at turn end: helium:684986663 http://127.0.0.1:5413/checkout
- form-checkout · tabs · left at turn end: helium:684986676 http://127.0.0.1:5413/checkout
- form-checkout · tabs · still controlled after the session ended: helium:684986663 http://127.0.0.1:5413/checkout
- form-checkout · tabs · still controlled after the session ended: helium:684986676 http://127.0.0.1:5413/checkout
- form-settings-helium · outcome · nothing submitted
- form-settings-helium · tabs · left at turn end: helium:684986465 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · left at turn end: helium:684986677 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · still controlled after the session ended: helium:684986465 http://127.0.0.1:5413/settings
- form-settings-helium · tabs · still controlled after the session ended: helium:684986677 http://127.0.0.1:5413/settings

Answers:
- form-travel: RESULT: SUB-0001-O7GO
- form-settings: RESULT: not submitted yet, so no submission id exists.
- form-checkout: RESULT: no submission id; submission not confirmed (checkout page stuck behind a confirm dialog)
- form-settings-helium: RESULT: not submitted, so there is no submission id; two-factor authentication is still off.
