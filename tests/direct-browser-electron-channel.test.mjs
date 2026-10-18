import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, bare, deriveChannel, mac, macEqual, opener, plainJson, randomToken, sealer, validToken } from '../plugins/sleight/lib/direct-browser/electron-channel.mjs';

const secret = Buffer.alloc(32, 7);
const transcript = { host: 'h'.repeat(22), hostNonce: 'n'.repeat(32), clientNonce: 'c'.repeat(32), ticket: 't'.repeat(32), role: 'worker' };

test('frames split at any byte and coalesced frames both decode, including split UTF-8', () => {
  const reader = new FrameReader(100);
  const bytes = Buffer.from('{"a":"é"}\0{"b":2}\0');
  const cut = bytes.indexOf(0xc3) + 1;
  assert.deepEqual(reader.push(bytes.subarray(0, cut)), []);
  assert.deepEqual(reader.push(bytes.subarray(cut)), ['{"a":"é"}', '{"b":2}']);
  for (let split = 1; split < bytes.length; split++) {
    const piecewise = new FrameReader(100);
    assert.deepEqual([...piecewise.push(bytes.subarray(0, split)), ...piecewise.push(bytes.subarray(split))], ['{"a":"é"}', '{"b":2}']);
  }
});

test('an oversized frame is refused before it is buffered, and a lone NUL or invalid UTF-8 never becomes a frame', () => {
  const reader = new FrameReader(16);
  assert.throws(() => reader.push(Buffer.alloc(17, 0x61)), /FRAME_TOO_LARGE/);
  const second = new FrameReader(16);
  second.push(Buffer.alloc(10, 0x61));
  assert.throws(() => second.push(Buffer.alloc(7, 0x61)), /FRAME_TOO_LARGE/, 'the bound counts bytes across chunks');
  assert.throws(() => new FrameReader(16).push(Buffer.from([0xff, 0xfe, 0]))), /FRAME_INVALID/;
  assert.deepEqual(new FrameReader(16).push(Buffer.from('\0\0')), ['', '']);
  assert.throws(() => plainJson(''), /FRAME_INVALID/);
  for (const bad of ['[]', '1', 'null', '"x"']) assert.throws(() => plainJson(bad), /FRAME_INVALID/);
  assert.throws(() => new FrameReader(0), /bound/);
});

test('both directions authenticate, count frames and reject tampering, replay and reordering', () => {
  const channel = deriveChannel(secret, transcript);
  const seal = sealer(channel.clientKey), open = opener(channel.clientKey);
  const first = seal({ op: 'send', id: 1 }), second = seal({ op: 'send', id: 2 });
  assert.deepEqual(open(first.toString().slice(0, -1)), { op: 'send', id: 1 });
  assert.throws(() => open(first.toString().slice(0, -1)), /AUTH/, 'a captured frame cannot be replayed');
  const reordered = opener(channel.clientKey);
  assert.throws(() => reordered(second.toString().slice(0, -1)), /AUTH/, 'a frame out of order is refused');
  const tampered = JSON.parse(seal({ op: 'send', id: 3 }).toString().slice(0, -1));
  const edited = opener(channel.clientKey); edited(first.toString().slice(0, -1)); edited(second.toString().slice(0, -1));
  tampered.p = tampered.p.replace('3', '9');
  assert.throws(() => edited(JSON.stringify(tampered)), /AUTH/);
  const wrongDirection = opener(channel.hostKey);
  assert.throws(() => wrongDirection(first.toString().slice(0, -1)), /AUTH/, 'a frame cannot be reflected back in the other direction');
  assert.throws(() => opener(channel.clientKey)('{"s":1,"p":"{}","a":"x","extra":1}'), /AUTH/);
});

test('the handshake transcript binds host, both nonces, ticket and role', () => {
  const base = deriveChannel(secret, transcript);
  for (const [field, value] of [['host', 'x'.repeat(22)], ['hostNonce', 'x'.repeat(32)], ['clientNonce', 'x'.repeat(32)], ['ticket', 'x'.repeat(32)], ['role', 'admin']]) {
    const other = deriveChannel(secret, { ...transcript, [field]: value });
    assert.notEqual(other.clientProof, base.clientProof, field);
    assert.notEqual(other.hostProof, base.hostProof, field);
    assert.ok(!Buffer.from(other.clientKey).equals(base.clientKey), field);
  }
  assert.notEqual(base.clientProof, base.hostProof, 'a client proof is not a host proof');
  assert.notEqual(deriveChannel(Buffer.alloc(32, 8), transcript).clientProof, base.clientProof);
});

test('MAC comparison is exact and never throws on odd input; tokens are fresh and well-formed', () => {
  const value = mac(secret, 'a', 'b');
  assert.equal(macEqual(value, value), true);
  assert.equal(macEqual(value, value.slice(1)), false);
  assert.equal(macEqual(value, undefined), false);
  assert.equal(mac(secret, 'ab', ''), mac(secret, 'ab', ''), 'deterministic');
  assert.notEqual(mac(secret, 'ab', 'c'), mac(secret, 'a', 'bc'), 'parts are length-prefixed, not concatenated');
  const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
  assert.equal(tokens.size, 200);
  assert.ok([...tokens].every(validToken));
  for (const bad of [undefined, '', 'short', 'a'.repeat(129), 'a'.repeat(30) + '=', 'a'.repeat(30) + ' ']) assert.equal(validToken(bad), false);
  assert.equal(bare({ a: 1 }).at(-1), 0);
});
