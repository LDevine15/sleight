// Wire format shared by the resident Electron host and its worker clients. Used only by
// electron-host.mjs and electron-connection.mjs; nothing else imports it.
//
// A channel is a local stream with NUL-delimited JSON frames. It carries no secret. The host
// speaks first with a fresh nonce, the client answers with a MAC over that nonce and its own,
// and the host proves it knows the same secret in return. After that every frame carries a
// strictly increasing sequence number and a MAC under a key derived from both nonces, one key
// per direction. A captured frame, handshake or whole connection replayed later fails: the nonces,
// keys and sequence numbers are different. Frames are bounded before they are buffered.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const CHANNEL_VERSION = 1;
export const HANDSHAKE_MAX_BYTES = 2048;
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const b64 = /^[A-Za-z0-9_-]{22,128}$/;

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const validToken = value => typeof value === 'string' && b64.test(value);

function digest(key, parts) {
  const hmac = createHmac('sha256', key);
  for (const part of parts) {
    const bytes = Buffer.from(String(part), 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    hmac.update(length); hmac.update(bytes);
  }
  return hmac.digest();
}
export const mac = (key, ...parts) => digest(key, parts).toString('base64url');
export function macEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// secret is the ticket's (or the admin's) shared key. Everything bound into the transcript
// is something an attacker would have to know or guess before the host's fresh nonce.
export function deriveChannel(secret, { host, hostNonce, clientNonce, ticket, role }) {
  const transcript = [CHANNEL_VERSION, host, hostNonce, clientNonce, ticket, role];
  return Object.freeze({
    clientProof: mac(secret, 'client-proof', ...transcript),
    hostProof: mac(secret, 'host-proof', ...transcript),
    clientKey: digest(secret, ['client-key', ...transcript]),
    hostKey: digest(secret, ['host-key', ...transcript]),
  });
}

// Splits a byte stream on NUL. Overflow is detected per chunk before the bytes are retained.
export class FrameReader {
  constructor(maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw Error('invalid frame bound');
    this.max = maxFrameBytes; this.parts = []; this.size = 0;
  }
  /** Returns the completed frames as strings. Throws on an oversized or non-UTF-8 frame. */
  push(chunk) {
    const frames = [];
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      const stop = end < 0 ? chunk.length : end;
      if (this.size + stop - start > this.max) throw Error('CHANNEL_FRAME_TOO_LARGE');
      if (stop > start) { this.parts.push(chunk.subarray(start, stop)); this.size += stop - start; }
      if (end < 0) break;
      const bytes = Buffer.concat(this.parts, this.size);
      this.parts = []; this.size = 0;
      try { frames.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
      catch { throw Error('CHANNEL_FRAME_INVALID'); }
      start = end + 1;
    }
    return frames;
  }
}

export function plainJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw Error('CHANNEL_FRAME_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('CHANNEL_FRAME_INVALID');
  return value;
}

export const bare = value => Buffer.from(JSON.stringify(value) + '\0');

// One direction of an authenticated channel.
export function sealer(key) {
  let sequence = 0;
  return payload => {
    const text = JSON.stringify(payload);
    if (text === undefined) throw Error('CHANNEL_FRAME_INVALID');
    sequence += 1;
    return Buffer.from(JSON.stringify({ s: sequence, p: text, a: mac(key, sequence, text) }) + '\0');
  };
}
export function opener(key) {
  let expected = 0;
  return frame => {
    const envelope = plainJson(frame);
    expected += 1;
    if (Object.keys(envelope).length !== 3 || envelope.s !== expected || typeof envelope.p !== 'string' || !macEqual(envelope.a, mac(key, envelope.s, envelope.p))) {
      throw Error('CHANNEL_AUTH_FAILED');
    }
    return plainJson(envelope.p);
  };
}
