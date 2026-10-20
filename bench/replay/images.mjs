// Read the engine's PNG/JPEG pixel dimensions without decoding or comparing pixels.
export function imageShape(block) {
  const mimeType = block.mimeType ?? block.source?.media_type;
  const data = block.data ?? (block.source?.type === 'base64' ? block.source.data : undefined);
  if (typeof data !== 'string') return null;
  const bytes = Buffer.from(data.slice(0, 200000), 'base64');
  let width, height;
  if (mimeType === 'image/png' && bytes.length >= 24 &&
      bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let i = 2; i + 3 < bytes.length;) {
      if (bytes[i++] !== 0xff) return null;
      while (bytes[i] === 0xff) i++;
      const marker = bytes[i++];
      if (marker === 0xd9 || marker === 0xda || i + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(i);
      if (length < 2 || i + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (length < 8) return null;
        height = bytes.readUInt16BE(i + 3); width = bytes.readUInt16BE(i + 5);
        break;
      }
      i += length;
    }
  }
  return width > 0 && height > 0 ? { type: 'image', mimeType, width, height } : null;
}

export function matchingMedia(expected, actual, expectedText, actualText, mapper) {
  if (expected.length !== actual.length) return false;
  if (expected.some(b => b.type === 'image')) {
    const headers = text => [...text.replace(/\r\n/g, '\n').matchAll(/^Window: "[^\n]+", App: [^\n]+$/gm)].map(m => m[0]);
    const before = headers(expectedText), after = headers(actualText);
    if (before.length !== 1 || after.length !== 1 || mapper.replaceStrings(before[0]) !== after[0]) return false;
  }
  return expected.every((block, i) => {
    if (block.type !== actual[i].type) return false;
    if (block.type !== 'image') return JSON.stringify(block) === JSON.stringify(actual[i]);
    const before = imageShape(block), after = imageShape(actual[i]);
    return before !== null && after !== null && JSON.stringify(before) === JSON.stringify(after);
  });
}
