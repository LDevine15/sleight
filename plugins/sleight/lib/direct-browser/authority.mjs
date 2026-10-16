// Sorted serialization compares trusted data without invoking getters.
export function canonical(value, depth = 0) {
  if (depth > 20) throw new Error('data depth');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (Object.getOwnPropertyNames(value).length !== value.length + 1) throw new Error('data array');
    const entries = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !('value' in descriptor)) throw new Error('data array');
      entries.push(canonical(descriptor.value, depth + 1));
    }
    return `[${entries.join(',')}]`;
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('plain data required');
  return `{${Object.keys(value).sort().map(key => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('data key');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('data getter');
    return `${JSON.stringify(key)}:${canonical(descriptor.value, depth + 1)}`;
  }).join(',')}}`;
}
