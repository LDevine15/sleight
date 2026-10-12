export function dropRepeatedText(content) {
  const seen = new Set();
  return content.filter(item => {
    if (item.type !== 'text' || typeof item.text !== 'string' || item.text.length <= 200) return true;
    if (seen.has(item.text)) return false;
    seen.add(item.text);
    return true;
  });
}
