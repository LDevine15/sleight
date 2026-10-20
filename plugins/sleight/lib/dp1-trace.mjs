import { CLOSE_COUNT_REASONS } from './close-count-reasons.mjs';
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
        if (json.length > 2048) return '';
        const event = JSON.parse(json);
        if (!['skipped-read', 'kept-read', 'blocked-read'].includes(event?.decision) || typeof event.reason !== 'string' || event.reason.length > 256) return '';
        const safe = { decision: event.decision, reason: event.reason };
        if (event.status === 'unknown' && CLOSE_COUNT_REASONS.includes(event.unknownReason)) safe.unknownReason = event.unknownReason;
        for (const key of ['source', 'status', 'match']) {
          if (typeof event[key] === 'string' && event[key].length <= 256) safe[key] = event[key];
        }
        for (const key of ['pid', 'windowCount', 'modalCount']) {
          if (Number.isSafeInteger(event[key]) && event[key] >= 0) safe[key] = event[key];
        }
        if (Number.isFinite(event.processStart)) safe.processStart = event.processStart;
        for (const key of ['keyDone', 'sampleStart', 'sampleEnd']) {
          if (Number.isFinite(event[key]) && event[key] >= 0) safe[key] = event[key];
        }
        if (typeof event.running === 'boolean') safe.running = event.running;
        if (typeof event.closedWindowPresent === 'boolean') safe.closedWindowPresent = event.closedWindowPresent;
        record(safe);
      } catch { /* A malformed diagnostic must not affect the result. */ }
      return '';
    });
    return text ? [{ ...block, text }] : [];
  });
}
