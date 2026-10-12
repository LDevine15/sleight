export function dropRepeatedText(content) {
  const seen = new Set();
  let dropped = 0;
  const kept = content.filter(item => {
    if (item.type !== 'text' || typeof item.text !== 'string' || item.text.length <= 200) return true;
    if (seen.has(item.text)) { dropped++; return false; }
    seen.add(item.text);
    return true;
  });
  if (!dropped) return content;
  const note = dropped === 1 ? 'sleight: dropped a repeated text block.' : `sleight: dropped ${dropped} repeated text blocks.`;
  return [...kept, { type: 'text', text: note }];
}
