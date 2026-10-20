# Second GIF preparation

Use `calculator-click`, sleight against Claude computer use, pending the owner's approval of that pair.
The task asks each arm to click Calculator's buttons for 17 × 23 and report 391. Its small window leaves room for
two readable captures. The [published native results](results/native-claim.md) include both arms, and
[the task definition](../bench/tasks.mjs) gives the exact prompt and check. The next run's times remain unmeasured,
and a GIF of one pair cannot establish the suite's performance claim.

## Storyboard

1. Show two single-window Calculator recordings, sleight on the left and Claude computer use on the right.
   Both start from the same fixture state. Use the same task, model and effort specified by the benchmark owner.
   Record the actual model, engine version, build and run references with the timing evidence.
2. Align each recording's measured task start to zero. Keep each entire attempt, including waits and retries.
   Both clocks advance in seconds at the original speed. Do not use published aggregate times as clip timings.
3. Freeze each arm at its measured completion, with `DONE n.n S - HELD` above it. Its clock stops while the other
   arm continues. End after the slower arm finishes and the plan's final hold elapses. The caption must explain
   that completed windows are held. Check that 391 is visible in both final frames.
4. Caption it as one recorded demonstration, with the task and run references and a link to the full results.
   Choose the first eligible pair under a rule agreed before capture. Keep failed or stopped attempts in the
   benchmark record. A retry or replacement needs a disclosed reason. Never select each arm's fastest take.

Capturing waits for the owner's OK and the Haiku quota reset, scheduled for 2026-10-21 at 15:00 UTC in the night
handoff. sleight-arch runs the benchmarks. loc arch directs the launch film and controls use of its takes. Ask loc arch
through the owner before reusing any film take. Preparation is limited to the offline tool and storyboard, with
capture and publication awaiting approval.

## Offline command

With ffmpeg and ffprobe already installed:

```sh
node scripts/build-comparison-gif.mjs /path/to/comparison-plan.json /path/to/new-comparison.gif
```

The script reads two explicit local video files, probes their metadata and writes one new GIF. It never records,
opens an app, installs a dependency or downloads media. Input paths resolve relative to the plan file. Spaces and
shell punctuation pass unchanged because subprocesses receive argument arrays. The output parent directory must
exist. Existing outputs, input symlinks and two references to the same file are refused.

The existing `bench/capture/demo-gif.mjs` handles synchronized film takes and can install the README demo.
This separate command accepts only the approved comparison pair and has no install mode.

## Plan

This example describes synthetic clips only. Replace every receipt and timing with evidence from the approved
recordings before using real media. `approval.reference` points to the owner's pair decision; it is an attestation
the operator must verify. The script checks structure and matching identities, not the authenticity of receipts.

```json
{
  "version": 1,
  "task": "calculator-click",
  "taskSource": "docs/results/native-claim.md",
  "approval": {
    "reference": "synthetic-test-only",
    "arms": ["sleight", "claude-cu"]
  },
  "endHoldSeconds": 1,
  "recordings": [
    {
      "arm": "sleight",
      "label": "sleight",
      "file": "synthetic left.mkv",
      "task": "calculator-click",
      "singleWindow": true,
      "recordingReference": "synthetic-left",
      "model": "synthetic",
      "timing": {
        "startSeconds": 0.2,
        "finishSeconds": 1.4,
        "evidence": "synthetic-timing-left"
      },
      "redaction": {
        "verified": true,
        "reviewReference": "synthetic-review-left",
        "crop": { "x": 0, "y": 10, "width": 160, "height": 110 },
        "masks": [{ "x": 0, "y": 0, "width": 8, "height": 8 }]
      }
    },
    {
      "arm": "claude-cu",
      "label": "Claude computer use",
      "file": "synthetic right.mkv",
      "task": "calculator-click",
      "singleWindow": true,
      "recordingReference": "synthetic-right",
      "model": "synthetic",
      "timing": {
        "startSeconds": 0.2,
        "finishSeconds": 2.2,
        "evidence": "synthetic-timing-right"
      },
      "redaction": {
        "verified": true,
        "reviewReference": "synthetic-review-right",
        "crop": { "x": 0, "y": 10, "width": 160, "height": 110 },
        "masks": [{ "x": 0, "y": 0, "width": 8, "height": 8 }]
      }
    }
  ]
}
```

`startSeconds` and `finishSeconds` are recording-relative timestamps from zero. Each recording must have one
video stream and a zero start timestamp, with no rotation metadata. An attempt must last 0.1 to 180 seconds and
fit inside its recording. Each arm must match the task and the approved pair's order. `endHoldSeconds` is 1 to 5.
Both input files must be distinct regular local MOV, MP4, M4V, MKV, WebM or AVI files.

## Redaction and preview

Review the entire source interval before marking its redaction plan verified. Remove window titles, account
names, paths, notifications and any names inside the content. Crop coordinates use source pixels. Opaque black
masks use coordinates within the cropped image and apply to every frame. An empty masks array means the reviewer
verified that cropping alone removes sensitive pixels. A fixed rectangle cannot follow moving text; reject a take
whose names cannot stay inside the approved crop or masks.

The script applies cropping and masks before resizing. It strips source metadata, chapters and audio, and puts
only the plan's public labels and clocks into the GIF. Keep labels free of names. Receipt text, input filenames
and the plan itself stay out of the GIF. Header text uses a built-in bitmap font, so a font library is unnecessary.

Watch the entire output before public use, including its loop boundary and every held frame. Check names and
other private pixels, both labels, timing receipts, readable clocks and completion states. Without OCR, the tool
cannot certify that arbitrary text has been scrubbed. Human preview and the owner's publication decision
remain required.

## Timing and size

Both clocks use `min(output elapsed, recorded finish minus recorded start)`, rounded to tenths of a second.
Frames are sampled at 10 fps, so alignment has up to one frame of precision. The frame at a sampled completion
timestamp is included in the hold. Preview must confirm completion is visible in the frozen frame. The
output lasts through the slower completion plus the final hold, rounded up to a tenth of a second. There are
no speed changes or cuts inside an attempt.

Encoding tries each profile once, in this order:

| Pixels per panel | Colors |
| --- | --- |
| 640 | 128 |
| 480 | 96 |
| 320 | 64 |

All profiles keep both clocks and the complete duration. The output must be strictly below 5,000,000 bytes.
If all three attempts are too large, the command fails without writing the output. It never shortens an attempt to
fit. Private staging is removed after success or failure, and atomic publication refuses an output created by
another process during encoding. The JSON result reports bytes, duration and the selected profile, with
`requiresHumanPreview: true`.

## Focused verification

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) node --test tests/comparison-gif.test.mjs
npm run lint:prose -- docs/comparison-gif.md
```

The tests use synthetic colors only. With ffmpeg and ffprobe installed they check a real GIF's duration,
metadata removal and masked pixels, including the held completion frame. Other cases cover invalid timing and
redaction, literal paths with spaces and shell punctuation, duplicate inputs, output conflicts and the strict
size limit. The rendering test skips when either binary is unavailable. It doesn't install dependencies.
