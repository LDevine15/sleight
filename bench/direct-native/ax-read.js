// Original offline read algorithm. The trusted adapter maps these closed operations to public
// multi-attribute and indexed-array AX reads. No native adapter is installed by this prototype.
export async function readAX({ call, check, classify, ax, root, request }) {
  const attributes = async (node, names, fields = names) => {
    await check();
    if (await classify(node, fields) !== 'metadata') return null;
    return call(() => ax.copyMultipleAttributeValues(node, names), node, fields);
  };
  if (request.operation === 'metadata') {
    const attrs = await attributes(root, ['title', 'minimized']);
    if (!attrs) return { status: 'denied', code: 'PROTECTED' };
    const value = {};
    for (const name of ['title', 'minimized']) {
      if (attrs[name]?.status !== 'ok') return { status: attrs[name]?.status === 'unsupported' ? 'unsupported' : 'unknown', code: 'AX_UNSUPPORTED' };
      if (name === 'title' && (typeof attrs[name].value !== 'string' || Buffer.byteLength(attrs[name].value) > 1024)) return { status: 'incomplete', code: 'OUTPUT_LIMIT' };
      if (name === 'minimized' && typeof attrs[name].value !== 'boolean') return { status: 'unknown', code: 'AX_VALUE_UNKNOWN' };
      value[name] = attrs[name].value;
    }
    return { status: 'ok', value, complete: true };
  }
  const stack = [{ node: root, depth: 0 }], seen = new Set(), matches = [];
  let incomplete = false;
  while (stack.length) {
    if (seen.size >= 128) { incomplete = true; break; }
    const { node, depth } = stack.pop();
    // The adapter must canonicalize equal native references for cycle detection.
    if (seen.has(node) || depth > 8) { incomplete = true; continue; }
    seen.add(node);
    const attrs = await attributes(node, ['role', 'name']);
    if (!attrs) { incomplete = true; continue; }
    if (attrs.role?.status !== 'ok' || attrs.name?.status !== 'ok' ||
        typeof attrs.role.value !== 'string' || typeof attrs.name.value !== 'string' ||
        Buffer.byteLength(attrs.role.value) > 64 || Buffer.byteLength(attrs.name.value) > 512) incomplete = true;
    else if (attrs.role.value === request.role && attrs.name.value === request.name) {
      if (request.operation === 'exists') return { status: 'ok', value: true, complete: false };
      matches.push(node);
      if (matches.length > 1) return { status: 'unknown', code: 'TARGET_AMBIGUOUS' };
    }
    const count = await call(() => ax.getAttributeValueCount(node, 'children'), node, ['role', 'name']);
    if (count?.status !== 'ok' || !Number.isSafeInteger(count.count) || count.count < 0) { incomplete = true; continue; }
    if (count.count > 128 || (depth === 8 && count.count)) { incomplete = true; continue; }
    for (let start = 0; start < count.count; start += 32) {
      const size = Math.min(32, count.count - start);
      const slice = await call(() => ax.copyAttributeValues(node, start, size, 'children'), node, ['role', 'name']);
      if (slice?.status !== 'ok' || !Array.isArray(slice.values) || slice.values.length !== size || slice.values.some(x => !x || typeof x !== 'object')) {
        incomplete = true; break;
      }
      for (const child of slice.values) stack.push({ node: child, depth: depth + 1 });
      if (stack.length + seen.size > 128) { incomplete = true; break; }
    }
  }
  if (incomplete) return { status: 'incomplete', code: 'SEARCH_INCOMPLETE' };
  if (request.operation === 'exists') return { status: 'ok', value: false, complete: true };
  if (matches.length !== 1) return { status: 'unknown', code: 'TARGET_MISSING' };
  // Only a boolean checkbox state is allowed; text/document values never cross this boundary.
  const attrs = await attributes(matches[0], ['value'], ['checked']);
  if (!attrs) return { status: 'denied', code: 'PROTECTED' };
  if (attrs.value?.status === 'unsupported') return { status: 'unsupported', code: 'AX_UNSUPPORTED' };
  if (attrs.value?.status !== 'ok' || typeof attrs.value.value !== 'boolean') return { status: 'unknown', code: 'AX_VALUE_UNKNOWN' };
  return { status: 'ok', value: attrs.value.value, complete: true };
}
