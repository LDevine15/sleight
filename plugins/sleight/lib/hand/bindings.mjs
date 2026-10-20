// Cooperative guard telemetry, never action authority. Only this call's unpredictable mark is parsed.
export function stripHandBindings(content, mark, record) {
  if (!mark) return content;
  const bindings = [];
  const out = content.flatMap(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') return [block];
    const pieces = block.text.split(mark);
    let text = pieces.shift();
    for (const piece of pieces) {
      const end = piece.indexOf('\n'), json = end < 0 ? piece : piece.slice(0, end);
      try {
        const value = JSON.parse(json);
        if (Object.keys(value).sort().join() === 'bound,index' && Number.isSafeInteger(value.index) &&
            value.index >= 0 && value.index < 1000 && typeof value.bound === 'boolean') bindings.push(value);
      } catch {}
      text += end < 0 ? '' : piece.slice(end + 1);
    }
    return text ? [{ ...block, text }] : [];
  });
  if (bindings.length) record(bindings);
  return out;
}
