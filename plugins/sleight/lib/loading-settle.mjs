// Serialized into the engine realm. Only a loading row changed by this action
// starts a wait; an existing spinner elsewhere in the window does not. Digits
// don't count as a change: a ticking "progress indicator 11%" against a baseline
// of 10% cost 1.5 s on every action (review of X5). `limit` is what is left of
// the call's settle budget, in ms.
export async function settleLoading(read, before, text, identity, now = () => performance.now(), limit = 1500) {
  const rows = value => typeof value === 'string' ? value.split('\n').map(line => /^\t*\d+ (.+)$/.exec(line)?.[1]).filter(Boolean) : [];
  const loading = line => /\([^)]*\bdisabled\b[^)]*\).*\bloading\b/i.test(line) || /^(?:busy(?: indicator)?|progress(?: indicator| bar)?)(?: |$)/i.test(line);
  const digitless = line => line.replace(/\d+/g, '0');
  const old = new Set(rows(before).map(digitless)), window = identity(before);
  const sameWindow = value => window && JSON.stringify(identity(value)) === JSON.stringify(window);
  const changed = value => rows(value).filter(line => loading(line) && !old.has(digitless(line)));
  if (limit <= 0 || !sameWindow(text) || !changed(text).length) return text;
  const deadline = now() + Math.min(1500, limit);
  let pending = changed(text);
  while (pending.length && now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(300, deadline - now())));
    // LAWS IN2: finish a read once started. The deadline stops further polls;
    // an engine read already in flight may finish after it. A read that fails
    // ends the wait with the last good tree.
    let next;
    try { next = await read(); } catch { break; }
    if (typeof next !== 'string') break;
    text = next;
    if (!sameWindow(text)) break;
    pending = changed(text);
  }
  return text;
}
