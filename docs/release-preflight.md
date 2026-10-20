# Release preflight

Run from the release worktree on Linux after installing its dependencies. The command exits 1 on any failure and
prints one JSON result. Keep the private terms file outside the repository. Use a nonempty JSON array of strings.
Include the owner's username and home path. Add their full name, email addresses and other private terms in notes.
Neither the strings nor matching lines appear in the result.

```sh
node scripts/release-preflight.mjs --tag v1.4.1 --private-terms /run/private/release-terms.json
```

Release mode requires an existing local tag at `HEAD`. A missing tag fails. The script never creates, moves, fetches
or pushes a tag. It requires a clean tree, including untracked files, before and after the checks. It checks `HEAD`
and the tag again after the Linux test. A nonzero command stops further execution.

Before creating a tag, use candidate mode:

```sh
node scripts/release-preflight.mjs --candidate 1.4.1 --private-terms /run/private/release-terms.json
```

A passing candidate result has `mode: "candidate"` and `releaseReady: false`. It skips tag lookup and still runs
the history scan and Linux test. Run release mode again after tagging. `releaseReady: true` means these preflight
checks passed; the architect's full check, release pass, A/B, public CI and owner publication decision still apply.

## Checks

- Plugin manifests must each name sleight and declare the requested version. Marketplaces must
  each list sleight once. Any version fields on a marketplace, its metadata or its sleight entry must agree too.
  Marketplaces without version fields are valid. The newest CHANGELOG heading must use
  `## VERSION (YYYY-MM-DD)`, with a real date and no duplicate heading for that version.
- README and CHANGELOG must contain no TODO, TBD, FIXME, XXX, CHANGEME, template version or insertion markers.
  Pending GB12, GB14 and Cursor row comments also fail. This check covers both files in full and has no development
  override.
- The newest CHANGELOG section is the release notes. Private identity matches, home paths, email addresses,
  common phone formats and the supplied private terms fail with only `CHANGELOG.md` and a line number.
  These patterns cannot detect every name, address or phone format. Review the notes and supply those private terms.
- The history base defaults to the local `origin/main`. Use `--history-base REF` to select another local base.
  A missing base or one outside HEAD's ancestry fails. The script invokes the existing history scanner over the
  resolved base-to-HEAD range and requires its zero-findings summary and exit 0. Scanner output and error text stay
  private. That scanner checks its runtime home and username. It does not consume the notes' private terms file.
- The Linux helper must be tracked. It must execute `npm test` on Linux and return the receipt below with exit 0.
  A missing helper, unsupported interface, local Mac result, dry plan, malformed receipt or failed test fails.

Local document failures appear together. Subprocess failures include their numeric exit code, or `null` when no
normal exit code was returned. Subprocess stdout, stderr and exception messages never appear in the JSON result.
Use the result's `check` field and the helper's own private evidence to investigate failures.

## A1 and A5 integration

A6 does not import A1's API. This script reads the six existing manifest paths itself and accepts added marketplace
version fields. A1's doctor-version check remains separate.

A5 must provide this interface, or the architect must adapt the one `linux` runner case before qualification:

```sh
node scripts/linux-preflight.mjs --run --json
```

Run in the caller's worktree. Put logs on stderr and exactly one JSON object on stdout, after the test exits:

```json
{"platform":"linux","command":["npm","test"],"exitCode":0,"executed":true}
```

Return nonzero on test failure and never mark a plan as executed. The helper owns test-child cancellation and cleanup.
This branch does not contain A5's helper. Its flags and receipt must be reconciled at integration; an offline fake
receipt proves the orchestration contract, not Linux test success. This runner refuses the Linux step on macOS and
does not launch Docker or remote commands. Use A5's reviewed Linux environment to run the whole preflight.

The reviewed runner allows only fixed Git reads, the history scanner and the Linux helper. Commands use argument
arrays with no shell. Each invocation gets a fresh disposable Claude config, offline npm configuration and bounded
output and time. The runner removes its own config afterward. It cannot install, push or publish a release.

For offline tests, inject `runner(request)` and `readFile(path)` into `preflight(options)`. The runner returns
`{status, stdout}`. A nonzero or null status fails. Its operations are `status`, `head`, `tag`, `base`, `ancestor`,
`sources`, `history` and `linux`. Tests inject the subprocess executor into `createReviewedRunner` as well, so they
exercise command selection without executing Git, npm, Docker, Claude or an app.
