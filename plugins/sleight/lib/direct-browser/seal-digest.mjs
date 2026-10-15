// The digest of everything the click shield seals about one node, computed in the same synchronous step as
// the rules' read of that node. The page hook computes the same string for the node it sealed (popupHook in
// page.mjs: content and digest); when the two are equal, the words the rules classified are the words that
// were sealed, so a label that flickers between a safe and a payment word cannot show the rules one and the
// shield the other. Closure-free: trusted-dom.mjs passes this function to the readers as their fourth argument.
// Keep the field lists, order and separators identical to the hook's.
export function sealDigest(node, read) {
  const sep = '\u0001';
  const attributes = ['role', 'aria-label', 'aria-disabled', 'disabled', 'value', 'alt', 'title', 'href', 'target', 'type', 'name', 'form', 'formaction', 'formtarget', 'formmethod', 'formenctype', 'formnovalidate', 'for', 'usemap'];
  const formAttributes = ['action', 'method', 'target', 'enctype', 'novalidate'];
  const rowAttributes = ['type', 'autocomplete', 'name', 'id', 'aria-label', 'value', 'form', 'title', 'alt', 'src'];
  const isBoolean = name => name === 'disabled' || name === 'formnovalidate' || name === 'novalidate';
  const attr = (target, name) => isBoolean(name) ? (Element.prototype.hasAttribute.call(target, name) ? '+' : '-') : Element.prototype.getAttribute.call(target, name) ?? '';
  const raw = (target, name) => Element.prototype.getAttribute.call(target, name);
  const getter = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name).get;
  const hash = value => { let h = 2166136261; for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619); return h + ':' + value.length; };
  const controls = [HTMLButtonElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement].map(type => [getter(type, 'form'), getter(type, 'type')]);
  const controlOf = target => {
    for (const [form, type] of controls) { try { return { form: form.call(target), type: type.call(target) }; } catch { /* Not this class. */ } }
    return null;
  };
  const formContent = form => {
    let parts = '';
    for (const name of formAttributes) parts += attr(form, name) + sep;
    for (const target of Element.prototype.querySelectorAll.call(form, 'input,button,iframe,select,textarea')) {
      parts += '\u0002' + read(target, 'localName') + sep + read(target, 'textContent');
      for (const name of rowAttributes) parts += sep + attr(target, name);
    }
    return parts;
  };
  const content = target => {
    const control = controlOf(target), form = control ? control.form : Element.prototype.closest.call(target, 'form');
    let row = read(target, 'localName') + sep + read(target, 'isConnected') + sep + hash(read(target, 'textContent')) + sep + (control ? control.type : '') + sep + (form ? hash(formContent(form)) : '');
    for (const name of attributes) row += sep + attr(target, name);
    const doc = read(target, 'ownerDocument'), bases = Document.prototype.querySelectorAll.call(doc, 'base[target]');
    return row + sep + read(doc, 'baseURI') + sep + read(doc, 'URL') + sep + (bases.length > 0 ? raw(bases[0], 'target') ?? '' : '');
  };
  return hash(content(node));
}
