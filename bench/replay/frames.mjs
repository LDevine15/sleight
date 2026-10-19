// Only explicit native window-selection receipts can establish a coordinate frame.
// Screenshots describe pixels, not a window's origin and dimensions in points.
export function windowReceipts(text) {
  return text.split('\n').flatMap(line => {
    try {
      const value = JSON.parse(line);
      return typeof value.target?.appId === 'string' && typeof value.target.title === 'string' && value.identity ? [value] : [];
    } catch { return []; }
  });
}

const validFrame = frame => frame && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(frame[key])) && frame.width > 0 && frame.height > 0;
const sameFrame = (before, after) => ['x', 'y', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) <= 2);

export class FrameMapper {
  constructor() { this.pairs = new Map(); }
  observe(pairs) {
    // Proof is valid only immediately after this observation, never across other calls.
    this.pairs.clear();
    for (const [before, after] of pairs) if (validFrame(before.frame) && validFrame(after.frame) &&
        pairs.filter(([row]) => row.identity.windowNumber === before.identity.windowNumber).length === 1 &&
        pairs.filter(([, row]) => row.identity.windowNumber === after.identity.windowNumber).length === 1)
      this.pairs.set(before.identity.windowNumber, { before, after });
  }
  assert(id, app) {
    const pair = this.pairs.get(id);
    if (!Number.isSafeInteger(id) || !pair || app !== pair.before.target.appId)
      throw Error('Coordinate frame evidence missing for the identified app window');
    if (!sameFrame(pair.before.frame, pair.after.frame))
      throw Error('Coordinate window frame changed by more than 2 pt');
  }
  normalized(text, recorded) {
    return text.split('\n').map(line => {
      const row = windowReceipts(line)[0];
      if (!row) return line;
      const pair = this.pairs.get(row.identity.windowNumber);
      if (recorded && pair && sameFrame(pair.before.frame, pair.after.frame)) row.frame = pair.after.frame;
      return JSON.stringify(row);
    }).join('\n');
  }
}
