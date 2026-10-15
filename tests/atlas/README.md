# Browser behavior atlas

AT1 measures local fixture pages with the vendored Playwright 1.64.0 and Chromium headless shell
revision 1248 (156.0.8078.4). Each row gets a fresh context. The suites cover v3 action
primitives and the browser defaults that its background click must preserve.

The method follows the CR4 submit and control probes: compare plain clicks with `ControlOrMeta`.
For operations that are clicks (`check`, option selection, links), the modifier goes on that action.
For `fill`, `selectOption`, uploads, drags, wheel, hover, viewport and navigation APIs, a preceding
fixture click receives the modifier. The API operation itself doesn't receive it. This tests the
state left by the click after modifier release.
These tables measure raw Chromium defaults. They do not install turbo's popup hook.

Run through the sleight-arch host queue, selecting these paths explicitly:

```text
tests/atlas/controls.real.test.mjs
tests/atlas/lifecycle.real.test.mjs
```

`fixture.real.test.mjs` is their shared harness. Without `SLEIGHT_LIVE_DOM_TEST=1`, each suite skips
by name before starting a server or browser. An opted-in run fails if the pinned browser is absent.
The receipts end with the full case rows, runtime versions and cleanup. Inputs and uploads contain
only fixture data. Uploads use memory buffers. Context teardown closes popups and pending dialogs;
the suite closes its own browser, loopback server and sockets.

The repository's current `npm test` glob selects `tests/*.test.mjs`, so it does not discover this
subdirectory. The host request and focused lane command must select both suites. Adding the atlas
to that glob is proposed in AT1's report.

The columns below describe the pinned expectations. "Same" means the modified-click row asserts the
same complete outcome as the plain row. Event counts are `input/change`. Tests also assert the
values, selected options, popup names, opener relationships and document identity shown here.

## Typing

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| IME-free ASCII | `plain text`, 1/0 | Same |
| Emoji surrogate pair | `A😀B`, 1/0 | Same |
| Emoji grapheme sequence | `👩🏽‍💻`, 1/0 | Same |
| Input LF or CRLF | `a b`, 1/0 | Same |
| Textarea LF or CRLF | `a\nb`, 3/0 | Same |
| Maxlength 3 | `abcdef` becomes `abc`, 1/0 | Same |
| Maxlength counts UTF-16 | `A😀B` becomes `A😀`, 1/0 | Same |
| Replace initial text | `old` becomes `new`, 1/0 | Same |
| Empty fill | Clears `old`, 1/0 | Same |
| Sequential typing, maxlength 3 | `abcd` becomes `abc`, 3/0 | Same |
| Fill same value | Dispatches input, 1/0 | Same |
| Readonly or disabled fill | Refuses, old value, 0/0 | Same |
| Contenteditable fill | Replaces text with `new 😀`, 1/0 | Same |
| Enter in input | Value stays `ab`, 0/0 | Same |
| Enter in textarea | Value becomes `ab\n`, 1/0 | Same |
| Backspace after emoji | `A😀` becomes `A`, 1/0 | Same |

## Select

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| Single select API | Selects B, 1/1 | Same |
| Multiple select API | Selects A and B, 1/1 | Same |
| Single select with two values | Selects first matching value A, 1/1 | Same |
| Multiple select with empty array | Clears selection, 1/1 | Same |
| Optgroup label B | Selects B, 1/1 | Same |
| Disabled option or optgroup API | Refuses, retains A, 0/0 | Same |
| Single option B click | Selects B, 1/1 | Same |
| Multiple option B click | Replaces A with B, 1/1 | Adds B to A, 1/1 |
| Disabled option click | Refuses, retains A, 0/0 | Same |

## Check and uncheck

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| Check false | Checked, 1/1 | Same |
| Check true | Checked, 0/0 | Same |
| Uncheck true | Unchecked, 1/1 | Same |
| Uncheck false | Unchecked, 0/0 | Same |
| Check indeterminate false | Checked, clears indeterminate, 1/1 | Same |
| Uncheck indeterminate false | Unchecked, keeps indeterminate, 0/0 | Same |
| Check wrapping label | Checks nested input, 1/1 | Same |
| Check hidden input through label | Checked, 1/1 | Same |
| Check hidden input directly | Refuses, unchecked, 0/0 | Same |
| Click wrapping label | Checked, clears indeterminate, 1/1 | Same |
| Radio click | Selects target, clears sibling | Same |

## Drag

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| HTML5 accepted drop | dragstart, dragenter, dragover, drop, dragend; payload received | Same |
| HTML5 uncancelled dragover | Same sequence without drop; no payload | Same |
| Pointer drag | down, three pressed moves, up | Same |
| Range pointer drag | Value 100, 4/1 | Same |
| Range midpoint click | Value 50, 1/1 | Same |

## Upload

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| Visible input | One text file with exact bytes, 1/1 | Same |
| Hidden input | One text file with exact bytes, 1/1 | Same |
| Multiple input | Both text files with exact bytes, 1/1 | Same |
| Single input with two files | Refuses, empty file list, 0/0 | Same |
| Accept image/png with text file | Accept does not filter API upload, 1/1 | Same |
| Empty payload array | Empty file list, 1/1 | Same |

## Dialogs

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| Alert accept or dismiss | Click waits for answer; script continues | Same |
| Confirm accept | Click waits; returns true | Same |
| Confirm dismiss | Click waits; returns false | Same |
| Prompt accept | Click waits; returns entered text, default retained in dialog | Same |
| Prompt dismiss | Click waits; returns null | Same |
| Alert scheduled after 150 ms | Click can complete before dialog arrives | Same |
| Beforeunload accept | Navigation waits for answer, then leaves | Same |
| Beforeunload dismiss | Navigation waits for answer, then stays | Same |

## Scroll

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| Visible target under fixed header | scrollIntoViewIfNeeded leaves it covered at scroll 0 | Same |
| Offscreen target under fixed header | Centers target in viewport, uncovered | Same |
| Nested ancestors | Window, outer and inner scroll | Same |
| Wheel over inner scroller | Inner scrolls 150 px, window stays at 0 | Same |

## Focus

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| Autofocus | Input at load, button after click | Same |
| Focus trap | Focus returns to inside input | Same |
| Inert descendant pointer click | Refuses; body retains focus | Same |
| Inert descendant programmatic focus | Ignored; button retains focus | Same |
| Hover | mouseenter fires; button retains focus | Same |
| Viewport resize | 390 by 844; max-width 400 query matches | Same |
| Wait for delayed reveal | Resolves when element becomes visible | Same |

## Popups

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| window.open blank | One child, opener present | Same |
| window.open named | One named child, opener present | Same |
| window.open noopener or noreferrer | One unnamed child, no opener | Same |
| window.open blank then location | One child reaches destination, opener present | Same |
| window.open self | Current document navigates; no child | Same |
| window.open same name twice | Reuses one named child | Same |
| Named link clicked twice | Reuses one named child with opener | Creates 2 unnamed children without an opener |
| Link blank, default rel | One unnamed child, no opener | Same |
| Link blank, rel opener | One unnamed child with opener | One unnamed child, no opener |
| Link named | One named child with opener | One unnamed child, no opener |
| Link named, rel noopener | One named child, no opener | One unnamed child, no opener |
| Link blank, rel noreferrer | One unnamed child, no opener | Same |
| GET or POST form, self | Current document navigates | One unnamed child, no opener; current stays |
| GET or POST form, blank | One unnamed child, no opener | Same |
| GET or POST form, named | One named child with opener | One unnamed child, no opener |

## Navigation

| Case | Plain outcome | Modified outcome |
| --- | --- | --- |
| pushState or replaceState | URL changes, document remains | Same |
| Hash | Hash changes, document remains | Same |
| Meta refresh | New document at destination | Same |
| Redirect chain | Requests all 3 redirects and the destination in the current tab | Requests the same chain in a child, current tab unchanged |
| Same-document back and forward | `/one`, then `/two`; page marker survives | Same |
| Reload | Page marker disappears in new document | Same |
