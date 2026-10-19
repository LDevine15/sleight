import { createHash } from 'node:crypto';

// The engine's "## Workflow" asks for a getAXState() after actions three times: its opening line, the batching bullet and the
// example that ends on a read. Under sleight's guard a native call that ends on an action already returns the window header
// and changed lines from the guard's own read after the call, and a trailing getAXState() takes that read's place, so it is
// the same one engine read either way (race-1017 traces: 3 engine operations for a one-action call both ways). Haiku
// followed the engine's line and ended 14 to 29 calls per form task on a read (codex-vs-cc-1019, CC6), against sleight's
// own "End on the action". The replacements say what sleight's section says. Only the computer surface gets them: an
// engine-path browser tab isn't read after the call.
// Engine lines are matched by the SHA-256 of the whole line (engine 26.1013.40934), so OpenAI's text stays out of the repo.
// A replacement of null removes the line.
export const WORKFLOW_PINS = Object.freeze({
  // The opening line: call getAXState() after actions, for fresh element indices.
  '2b162a8d5f14b2b4515bbf10e9adcff12d0048e0d8c289082dd4f25564ff11f5':
    "After UI actions, sleight's result shows the window header and the lines that changed, with current element indices; take indices from it, not from an older tree. After an error, read again.",
  // The batching bullet: batch actions and the resulting getAXState() into one call.
  '8373015e65783172f1a556e3a196cd3524a76e1b7720586eaf020249f45c3bff':
    '- Batch deterministic actions into one call and end it on the last action: its result already shows the updated state, so a trailing `getAXState()` only repeats it.',
  // The example's lead-in, which says to fetch the latest state after the actions.
  'bdcc0d727c6d16f313cabf232b28da34a1f99bcd42dc9caa83717f114b04c3f8': '  Perform one or more actions; the result shows the latest state:',
  // The example's last line, the read itself.
  '5b72e0e8e8b7f3dcf9b411e993dcce6ab5e8f8b6007bb24c2b1d3285e0f139b6': null,
});

const sha = text => createHash('sha256').update(text).digest('hex');

// Rewrites the "## Workflow" section of a "## Computer Use" document only when every pinned line is in it exactly once;
// otherwise the text is returned whole, so a changed engine keeps its own wording rather than half of sleight's.
export function rewriteWorkflow(text, pins = WORKFLOW_PINS) {
  if (typeof text !== 'string') return { text, status: 'unmatched' };
  const start = text.search(/^## Workflow\r?$/m);
  if (start < 0) return { text, status: 'unmatched' };
  // The section runs to the next heading of level 1 or 2 after its own heading line.
  const body = text.indexOf('\n', start) + 1;
  const next = body > 0 ? text.slice(body).search(/^#{1,2} /m) : -1;
  const end = body === 0 ? text.length : next < 0 ? text.length : body + next;
  const seen = new Map();
  const lines = text.slice(start, end).split('\n').flatMap(line => {
    const hash = sha(line);
    if (!Object.hasOwn(pins, hash)) return [line];
    seen.set(hash, (seen.get(hash) ?? 0) + 1);
    return pins[hash] === null ? [] : [pins[hash]];
  });
  if (Object.keys(pins).some(hash => seen.get(hash) !== 1)) return { text, status: 'unmatched' };
  return { text: text.slice(0, start) + lines.join('\n') + text.slice(end), status: 'rewritten' };
}
