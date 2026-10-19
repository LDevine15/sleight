# Held-out fixtures for CC1 to CC7

The 15 task names are in [cc-held-out-tasks.txt](../cc-held-out-tasks.txt).
Each browser fixture has Firefox and Safari variants. The native list uses Finder.
These tasks require explicit selection and are excluded from race, claim and unnamed world passes.

| Task stem | Fixture | Items |
| --- | --- | --- |
| cc-list | 640 sorted, two-line collection rows; nine rendered at once | CC1, CC2, CC3, CC6 |
| cc-list-pop-up | Display mode popup focused, collection unavailable in that control | CC2 refusal |
| cc-calendar | Two-month access range; both date labels visible before a selection rebuilds the panels | CC5, CC6 |
| cc-calendar-ambiguous | Both panels have a day labeled 12; correct result is refusal without saving | CC5 refusal |
| cc-dropdown | Region loads its workshop choices after 700 ms | CC4, CC6 |
| cc-dropdown-slow | Same dependency with a 2,100 ms response | CC4 timeout |
| cc-new-tab | Departure address, arrival receipt and distinct tab storage markers | CC7 |
| cc-list-native | Finder list with 640 generated files, target rename and full contents check | CC1, CC2, CC3, CC6 |

The browser task suffix is `-firefox` or `-safari`. The native name is `cc-list-native`.
Task metadata and prompts are in [cc-held-out.json](tasks/cc-held-out.json), also registered under `heldOut` in `suite.json`.

The existing benchmark site serves default fixtures at
`http://127.0.0.1:5431/held-out/<kind>/held-out/`.
World task setup creates a fresh fixture on an ephemeral loopback port and retains its server for grading.
The runner closes the server through its existing fixture lifecycle. Browser setup requires `--real-profile fresh` and `--owner-away`.
It uses the race launcher. Firefox gets a fresh private profile, and Safari gets its verified `sleight benchmark` profile window.
The race launcher owns the browser process and its cleanup. A missing profile selection stops setup before the server starts.
The native task uses the existing retained-window helper.

Offline checks run with:

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/cc-held-out.test.mjs
```

The page tests execute the page scripts against an in-memory DOM stub. They cover list selection, calendar rebuilds,
dependent responses, stale-response rejection and tab markers. They do not launch a browser or qualify native accessibility.
The native grader checks the renamed target and every other file's name and contents.

Fixture grades cover the task outcome. Review transcripts for the first list action and any focus or no-frame error.
Check read counts and call boundaries against the CC criteria. CC6 also needs engine read timings and tree comparisons.
CC7 needs evidence that the new-tab batch kept its lease. The arrival grade rejects same-tab navigation; it cannot establish which keys
opened the new tab. The duplicate-label and popup grades require a refusal and no saved submission; a transcript must
establish the plugin's guard stopped the action. The 1,000-target offline search model and user-caused title-change
adversary remain separate checks owned by their CC lanes.
