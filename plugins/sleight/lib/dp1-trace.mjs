// Diagnostics are cooperative observations, never proof that a close succeeded.
export function withoutTitles(value) {
  if (Array.isArray(value)) return value.map(withoutTitles);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/title/i.test(key))
    .map(([key, field]) => [key, withoutTitles(field)]));
}

export function stripDP1Trace(content, record) {
  return content.flatMap(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') return [block];
    const text = block.text.replace(/\[sleight:dp1\]([^\r\n]*)(?:\r?\n|$)/g, (_, json) => {
      try {
        const event = JSON.parse(json);
        if (['skipped-read', 'kept-read'].includes(event?.decision) && typeof event.reason === 'string') record(withoutTitles(event));
      } catch { /* A malformed diagnostic must not affect the result. */ }
      return '';
    });
    return text ? [{ ...block, text }] : [];
  });
}
