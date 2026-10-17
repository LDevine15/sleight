# Prompt budget

`SLEIGHT_PROMPT=lean` selects shorter skill text, local tool descriptions, the `js` first-call
rewrite and result notices. Unset or any other value keeps the text from `245a186`.
The original skill is unchanged. The launcher reads `SKILL.lean.md` only for this switch.

## Measurement

Run `node bench/prompt-budget.mjs`. Add `--details` for each tool, schema field and notice source.
`--json` prints the same counts as data. It reads source and exchanges tool-list messages through
in-memory streams. It doesn't start an engine, app, browser or helper.

Measured on 2026-10-11:

| Source | Default characters | Default lines | Lean characters | Lean lines |
|---|---:|---:|---:|---:|
| Skill, including unchanged metadata | 5,936 | 86 | 2,732 | 41 |
| All tool descriptions and schema descriptions | 6,066 | 31 | 4,371 | 31 |
| `js` first-call rewrite | 723 | 1 | 326 | 1 |
| Relay result notices and refusal context | 6,970 | 85 | 5,714 | 85 |
| Shared notice generators | 3,934 | 29 | 3,339 | 29 |
| Total | 23,629 | 232 | 16,482 | 187 |

The reduction is 7,147 characters (30.25%). Characters are Unicode code points. Lines include
blank lines, with one separating newline between entries in a source group; trailing newlines
are excluded. The skill row includes its 398-character metadata block in both arms, since the
host still discovers the original skill. The delivered bodies are 5,538 and 2,334 characters.

The tool inventory includes every local tool, `turn_ended`, document scope, review and flow
exceptions, even when an optional tool is disabled in a session. The rewrite row uses today's
batching mode. Both arms also support the existing `merge` wording experiment. Engine descriptions
outside the replaced sentence pass through unchanged.

Each authored notice template counts once, including inactive refusal paths. Interpolated values
use `<value>`. Shared templates cover read failures, orphan panels, off-Space guidance, screenshot
scale, blocked-target consent warnings, stop reports, clipboard notices and compact-read guidance.
These counts describe the instruction inventory. Actual session input also contains engine docs,
UI state, repeated notices and variable data. `SLEIGHT_PROMPT=lean` has 0 live runs as of
2026-10-11. Task success, turns, model time and actual session context use are unmeasured.

Until 2026-10-17 the count missed the read compactor's notes, the document guard's stops and the
stop notes. A lib module now marks such text: `/* notice */` before an expression, `/* lean notice */`
where sleight passes it through `promptNotice` later, and `/* generated code */` before a template
sleight sends to the engine, whose `Error`, `stop` and `nodeRepl.write` texts count. The guard gets
its lean wording when the relay builds its code. A test fails on any `sleight:` literal in the
relay, compactor, guard or stop notes that no inventory counts. Measured on 2026-10-17, with the
marked notices as a sixth row: 35,164 default characters and 24,915 lean (70.85%, the test's bar
is 71%), up from 27,087 and 19,137 before the marked rows.

## Safety and offline evidence

The variant retains approval, blocked-app, flow, lease and focus rules verbatim. Named examples
become placeholders. Names in the blocked-app safety sentence remain because that sentence must
stay verbatim. There are no new branches on an app or site's identity.

The new tests failed 4/4 on the baseline before the code changed. They check default text hashes,
lean selection, protected safety passages, unchanged tool schemas apart from descriptions,
named examples, engine-text pass-through, refused unawaited actions and the 30% threshold.
The budget command uses synchronous source parsing; the tests dispose their in-memory relays
and collect the one synchronous command they start.

## Live handoff

sleight-arch runs the A/B in the owner-away sitting after the lanes merge. Keep other
settings, model, effort, fixtures and load the same. Change only `SLEIGHT_PROMPT`: unset for
default, `lean` for lean. Confirm the effective arm from delivered skill and tool text.

Run calculator-click, textedit-edit and textedit-save, 6 runs per task per arm (36 runs total).
Publish every run, including failures. Record task success, turns, total time, model time,
model time per turn and actual delivered characters. Check the result and app state through the
trace and transcript. Lean must preserve approval and lease refusals, flow rules, settings
blocks and the rule against asking Claude to bring an app forward. Every owned process and
fixture must have confirmed cleanup. Adoption requires the owner's A/B decision; default stays
unchanged until then.
