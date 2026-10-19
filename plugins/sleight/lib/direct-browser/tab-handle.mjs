import { randomBytes, randomUUID } from 'node:crypto';

// A lookup key for an owned record, never an authority token. Allocation and insertion must not await between them.
export function tabHandle(records) {
  if (process.env.SLEIGHT_MT === '0') return 't' + randomUUID().replaceAll('-', '');
  let handle;
  // Nine independent base32 digits carry 45 random bits. Retained records prevent stale handle reuse too.
  do { handle = 't' + Array.from(randomBytes(9), byte => 'abcdefghijklmnopqrstuvwxyz234567'[byte & 31]).join(''); }
  while (records.has(handle));
  return handle;
}
