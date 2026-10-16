import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical } from '../plugins/sleight/lib/direct-browser/authority.mjs';
import { immutableJSON } from '../plugins/sleight/lib/direct-browser/ipc.mjs';

// canonical() is the approval and consent key serializer (v3-context.mjs, files.mjs).
test('canonical rejects hidden array data, holes and accessors without reading getters', () => {
  let reads = 0;
  const getter = Object.defineProperty([], '0', { get: () => { reads++; return 'fixture'; }, enumerable: true });
  for (const value of [Object.assign([], { url: 'https://fixture.test/private-fixture' }), Array(1), getter])
    assert.throws(() => canonical(value), /data/);
  assert.equal(reads, 0);
  assert.equal(canonical(['fixture', false]), '["fixture",false]');
});

test('canonical sorts object keys, so equal data gives one key whatever the property order', () => {
  assert.equal(canonical({ b: 1, a: { d: [true, null], c: 'x' } }), '{"a":{"c":"x","d":[true,null]},"b":1}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
});

test('canonical refuses object getters, odd prototypes, reserved keys, non-finite numbers and deep data', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'key', { get: () => { reads++; return 'x'; }, enumerable: true });
  assert.throws(() => canonical(accessor), /data getter/);
  assert.equal(reads, 0);
  assert.throws(() => canonical(Object.create(null)), /plain data/);
  assert.throws(() => canonical(new Map()), /plain data/);
  assert.throws(() => canonical(Object.defineProperty({}, 'constructor', { value: 1, enumerable: true })), /data key/);
  assert.throws(() => canonical(JSON.parse('{"__proto__":1}')), /data key/);
  for (const value of [NaN, Infinity, undefined, () => {}, Symbol('s'), 1n]) assert.throws(() => canonical(value), /plain data/);
  let deep = 'leaf';
  for (let i = 0; i < 21; i++) deep = [deep];
  assert.throws(() => canonical(deep), /data depth/);
});

// immutableJSON() freezes the arguments the worker receives over IPC.
test('immutableJSON returns frozen copies of plain JSON, so a caller cannot change them later', () => {
  const source = { list: [1, { x: 'y' }], flag: true, none: null };
  const copy = immutableJSON(source);
  assert.deepEqual(copy, source);
  assert.notEqual(copy, source);
  assert.ok(Object.isFrozen(copy) && Object.isFrozen(copy.list) && Object.isFrozen(copy.list[1]));
  source.list.push(2);
  assert.equal(copy.list.length, 2);
  assert.ok(Object.isFrozen(immutableJSON(Object.assign(Object.create(null), { a: 1 }))));
});

test('immutableJSON refuses accessors, symbols, odd prototypes, extra array properties, holes and oversize data', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'key', { get: () => { reads++; return 'x'; }, enumerable: true });
  const symbolKey = { [Symbol('s')]: 1 };
  for (const value of [accessor, symbolKey, new Map(), new Date(), Object.assign([], { extra: 1 }), Array(2),
    Array.from({ length: 4097 }, () => 0), NaN, Infinity, undefined, () => {}, 1n, Symbol('s')])
    assert.throws(() => immutableJSON(value), /INVALID_ARGUMENT/);
  assert.equal(reads, 0);
  assert.equal(immutableJSON(Array.from({ length: 4096 }, () => 0)).length, 4096);
  let deep = 'leaf';
  for (let i = 0; i < 17; i++) deep = [deep];
  assert.throws(() => immutableJSON(deep), /INVALID_ARGUMENT/);
  let ok = 'leaf';
  for (let i = 0; i < 16; i++) ok = [ok];
  assert.ok(immutableJSON(ok));
});
