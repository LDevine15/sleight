// Closure-free utility-world readers. Native prototype accessors, rather than page properties, establish the capability.
// EditContext.text can be a partial editor buffer: neither acquisition nor input treats it as the document.
function nativeEditContextEvidence(el) {
  try {
    if (typeof HTMLElement === 'undefined' || typeof EditContext === 'undefined') return null;
    const getter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'editContext')?.get;
    const attached = Object.getOwnPropertyDescriptor(EditContext.prototype, 'attachedElements')?.value;
    if (typeof getter !== 'function' || typeof attached !== 'function') return null;
    const context = getter.call(el);
    if (!context) return null;
    const elements = attached.call(context); // Native receiver brand check rejects page-supplied lookalikes.
    return { context, attached: Array.isArray(elements) && elements.length === 1 && elements[0] === el };
  } catch { return null; }
}

export function retainNativeEditContext(el) {
  const evidence = nativeEditContextEvidence(el);
  return evidence?.attached ? evidence.context : null;
}
retainNativeEditContext.helpers = [nativeEditContextEvidence];

export function readNativeEditContext(el, unused, read) {
  const evidence = nativeEditContextEvidence(el);
  if (!evidence) return { native: false, eligible: false };
  let role = '', zeroArea = false;
  try {
    const attr = (node, key) => read(node, 'getAttribute')(key);
    role = String(attr(el, 'role') ?? '').trim().toLowerCase().split(/\s+/)[0];
    const rect = read(el, 'getBoundingClientRect')();
    zeroArea = !(rect.width > 0 && rect.height > 0);
    let eligible = evidence.attached && read(el, 'isConnected') === true && ['textbox', 'searchbox'].includes(role)
      && Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width >= 0 && rect.height >= 0 && rect.width + rect.height > 0;
    const seen = new Set();
    for (let node = el; node;) {
      if (seen.has(node) || seen.size >= 128) { eligible = false; break; }
      seen.add(node);
      if (read(node, 'isConnected') !== true) eligible = false;
      for (const key of ['readonly', 'disabled', 'hidden', 'inert']) if (attr(node, key) !== null) eligible = false;
      for (const key of ['aria-readonly', 'aria-disabled', 'aria-hidden']) if (String(attr(node, key)).trim().toLowerCase() === 'true') eligible = false;
      if (read(node, 'readOnly') === true || read(node, 'disabled') === true || read(node, 'inert') === true || read(node, 'hidden') === true || read(node, 'matches')(':disabled')) eligible = false;
      const style = getComputedStyle(node);
      if (!style || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) eligible = false;
      const parent = read(node, 'parentElement');
      if (parent) { node = parent; continue; }
      const root = read(node, 'getRootNode')();
      if (read(root, 'nodeType') === 11) node = read(root, 'host');
      else {
        const view = read(read(node, 'ownerDocument'), 'defaultView'), frame = read(view, 'frameElement');
        if (!view || !frame && read(view, 'top') !== view) eligible = false;
        node = frame ?? null;
      }
    }
    return { native: true, eligible, role, zeroArea };
  } catch { return { native: true, eligible: false, role, zeroArea }; }
}
readNativeEditContext.helpers = [nativeEditContextEvidence];

export function sameNativeEditContext(el, context, read) {
  return retainNativeEditContext(el) === context && readNativeEditContext(el, undefined, read).eligible === true;
}
sameNativeEditContext.helpers = [nativeEditContextEvidence, retainNativeEditContext, readNativeEditContext];

export function nativeEditContextSelection(el, context, read) {
  try {
    if (!sameNativeEditContext(el, context, read)) return null;
    const start = Object.getOwnPropertyDescriptor(EditContext.prototype, 'selectionStart')?.get?.call(context);
    const end = Object.getOwnPropertyDescriptor(EditContext.prototype, 'selectionEnd')?.get?.call(context);
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start ? { start, end } : null;
  } catch { return null; }
}
nativeEditContextSelection.helpers = [nativeEditContextEvidence, retainNativeEditContext, readNativeEditContext, sameNativeEditContext];
