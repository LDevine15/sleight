export function immutableJSON(input, depth = 0) {
  if (depth > 16) throw Error('INVALID_ARGUMENT');
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (!input || typeof input !== 'object') throw Error('INVALID_ARGUMENT');
  if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw Error('INVALID_ARGUMENT');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !('value' in descriptors[key]))) throw Error('INVALID_ARGUMENT');
  if (Array.isArray(input)) {
    if (input.length > 4096 || Object.keys(descriptors).length !== input.length + 1) throw Error('INVALID_ARGUMENT');
    return Object.freeze(Array.from({ length: input.length }, (_, i) => immutableJSON(descriptors[i].value, depth + 1)));
  }
  return Object.freeze(Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, immutableJSON(d.value, depth + 1)])));
}
