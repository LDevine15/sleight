// Serialized into the engine realm. Only a loading row changed by this action
// starts a wait; an existing spinner elsewhere in the window does not.
export async function settleLoading(read, before, text, identity, now = () => performance.now()) {
  const rows = value => typeof value === 'string' ? value.split('\n').map(line => /^\t*\d+ (.+)$/.exec(line)?.[1]).filter(Boolean) : [];
  const loading = line => /\([^)]*\bdisabled\b[^)]*\).*\bloading\b/i.test(line) || /^(?:busy(?: indicator)?|progress(?: indicator| bar)?)(?: |$)/i.test(line);
  const old = new Set(rows(before)), window = identity(before);
  const sameWindow = value => window && JSON.stringify(identity(value)) === JSON.stringify(window);
  if (!sameWindow(text) || !rows(text).some(line => loading(line) && !old.has(line))) return text;
  const deadline = now() + 1500;
  let pending = rows(text).filter(line => loading(line) && !old.has(line));
  while (pending.length && now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, Math.min(300, deadline - now())));
    // LAWS IN2: finish a read once started. The deadline stops further polls;
    // an engine read already in flight may finish after it.
    const next = await read();
    if (typeof next !== 'string') break;
    text = next;
    if (!sameWindow(text)) break;
    pending = rows(text).filter(line => loading(line) && !old.has(line));
  }
  return text;
}
