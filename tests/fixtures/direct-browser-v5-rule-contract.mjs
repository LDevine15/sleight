// Pinned V6 contract fixture: 6b953169681de7b9499a76afa41754576b4c18ac.
// Test-only copy supplied by V-V5. Production loads the real sibling rules.mjs.
// v3's four rules. ctx is private worker state, never tool arguments: userMessage
// is the relay's current {source:'user',session,turn,id,text,payment?,upload?};
// consent.consume(terms,target) and files.check(paths,target,message) are trusted,
// synchronous providers. An allow consumes payment authority immediately before
// dispatch. target carries final element metadata, prior metadata, page-observed
// {terms:{page:{item,amount,payee,currency?},method}}, and the owning tab state.
const allow = Object.freeze({ verdict: 'allow' });
const refuse = message => ({ verdict: 'refuse', message: message + ' Use the engine browser path if needed.' });
const payments = new WeakMap();
const captures = new WeakMap();
const paymentWords = text => /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i.test(text ?? '');
const ordinary = new Set(['read', 'open', 'click', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll', 'drag', 'upload',
  'dialog', 'wait', 'back', 'forward', 'reload', 'viewport', 'close', 'keep', 'handoff', 'Target.createTarget']);
const text = value => typeof value === 'string' && value.trim().length > 0;
const sameTerms = (a, b) => ['item', 'method', 'amount', 'payee', 'currency'].every(key => a?.[key] === b?.[key]);
const sameDocument = (a, b) => ['session', 'turn', 'document', 'origin'].every(key => text(a?.[key]) && a[key] === b?.[key]);

// Closure-free: pass to locator.evaluate in the target's own frame. Page words
// can only increase risk. Read visible text, aria-label and input value together.
export function inspectElement(el) {
  const get = (node, key) => Element.prototype.getAttribute.call(node, key) ?? '';
  const words = node => [get(node, 'aria-label'), node.textContent, get(node, 'value')].join(' ');
  const payment = value => /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i.test(value);
  const type = el instanceof HTMLInputElement ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'type').get.call(el) : '';
  const tag = el.localName, role = get(el, 'role'), form = el.closest('form'), rect = el.getBoundingClientRect(), style = getComputedStyle(el);
  const button = tag === 'button' || role === 'button' || ['submit', 'button', 'reset'].includes(type);
  const state = { tag, role, kind: button ? 'button' : ['file', 'color'].includes(type) ? type : tag === 'select' ? 'select' : 'text',
    form: !!form, connected: el.isConnected, visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
    enabled: !el.matches(':disabled') && get(el, 'aria-disabled') !== 'true', payment: payment(words(el)),
    submit: type === 'submit' || tag === 'button' && !!form && get(el, 'type') !== 'button' && get(el, 'type') !== 'reset' ||
      button && /\b(?:save|submit|send|confirm|book|pay|place order|finish|complete)\b/i.test(words(el)) };
  state.formPayment = !!form && Array.from(form.querySelectorAll('input,button,iframe')).some(node => {
    const attrs = ['name', 'id', 'autocomplete', 'title', 'aria-label'].map(key => get(node, key)).join(' ');
    if (/\bcc-|card|cvv|cvc/i.test(attrs)) return true;
    if (node.localName === 'iframe') { try { return new URL(get(node, 'src'), location.href).origin !== location.origin; } catch { return true; } }
    return (node.localName === 'button' || get(node, 'type') === 'submit') && payment(words(node));
  });
  if (button && state.payment) state.submit = true;
  if (state.submit && state.formPayment) state.payment = true;
  return state;
}

export function intent(kind, target = {}) {
  const key = target.key?.split('+').at(-1), activation = kind === 'press' && ['Enter', 'Return', 'Space', ' '].includes(key);
  let submit = kind === 'submit', payment = false;
  for (const el of [target.prior, target.element].filter(Boolean)) {
    const sends = kind === 'click' || activation && (['Enter', 'Return'].includes(key) ? el.submit || el.form && el.tag !== 'textarea' : el.kind === 'button' || el.role === 'button');
    const submits = kind === 'submit' || sends && (el.submit || el.payment && (el.kind === 'button' || el.role === 'button') || el.form && activation);
    submit ||= !!submits;
    payment ||= !!submits && (el.payment === true || el.formPayment === true);
  }
  if (kind === 'dialog' && target.accept === true) { payment ||= target.element?.payment === true || paymentWords(target.message); submit = payment; }
  return { submit, payment };
}

export function check(ctx, kind, target = {}) {
  try {
    if (!ordinary.has(kind) && kind !== 'submit') return refuse('Background-only operation required.');
    if (kind === 'Target.createTarget') return target.background === true ? allow : refuse('New tabs must use background:true.');
    if (kind === 'press' && target.key?.includes('+') && /(?:Enter|Return|Space| )$/.test(target.key)) return refuse('This activation chord may open a foreground window.');
    const el = target.element;
    if (!['read', 'dialog', 'open', 'wait', 'back', 'forward', 'reload', 'viewport', 'close', 'keep', 'handoff'].includes(kind)) {
      if (!el || !text(el.tag)) return refuse('Read the target before input.');
      if (['iframe', 'frame', 'object', 'embed'].includes(el.tag)) return refuse('Use a ref for the child-frame control.');
      if (['connected', 'visible', 'enabled', 'hit'].some(key => el[key] === false)) return refuse('The checked target changed; read it again.');
    }
    if (['click', 'press', 'submit'].includes(kind) && ['payment', 'submit', 'form', 'formPayment'].some(key => typeof el?.[key] !== 'boolean'))
      return refuse('Read final submit and payment classification before activation.');
    if (kind === 'click' && ['file', 'color', 'select'].includes(el?.kind)) return refuse('Use browser_fill or upload instead of opening a native picker.');
    const risk = intent(kind, target);
    if (risk.submit && (!target.state || !Number.isSafeInteger(target.state.snapshotNo))) return refuse('Submit needs its document state.');
    const retry = () => refuse('Submit unconfirmed. Deliver a fresh browser_read before retrying.');
    if (risk.submit && kind !== 'dialog' && target.state.submitUnconfirmed) return retry();
    const message = typeof ctx?.userMessage === 'function' ? ctx.userMessage() : ctx?.userMessage;
    const user = message?.source === 'user' && text(message.id) && text(message.text) && message.session === target.session && message.turn === target.turn ? message : undefined;
    if (kind === 'upload') return user && Array.isArray(target.paths) && target.paths.length && target.paths.length <= 16 &&
      target.paths.every(text) && new Set(target.paths).size === target.paths.length &&
      ctx.files?.check(target.paths, target, user) === true ? allow : refuse('Upload requires exact user-named files and the private files provider.');
    if (!risk.payment) return allow;
    const page = target.terms?.page, terms = { item: page?.item, amount: page?.amount, payee: page?.payee, method: target.terms?.method,
      ...(page?.currency !== undefined ? { currency: page.currency } : {}) };
    const ask = () => ({ verdict: 'confirm', terms });
    if (!['item', 'amount', 'payee', 'method'].every(key => text(terms[key])) || !sameDocument(target, target)) return ask();
    let bank = payments.get(ctx); if (!bank) { bank = { used: new Set() }; payments.set(ctx, bank); }
    if (kind === 'dialog' && bank.dialog && sameDocument(bank.dialog, target) && sameTerms(bank.dialog.terms, terms)) {
      bank.dialog = undefined; return allow;
    }
    if (kind === 'dialog' && target.state.submitUnconfirmed && !sameDocument(bank.dialog, target)) return retry();
    const requestKey = user && JSON.stringify([user.session, user.turn, user.id]);
    const requested = user?.payment && ['item', 'method'].every(key => text(user.payment[key])) &&
      ['item', 'method', 'amount', 'payee', 'currency'].every(key => user.payment[key] === undefined || user.payment[key] === terms[key]);
    const strict = (ctx.confirmPayments ?? process.env.SLEIGHT_CONFIRM_PAYMENTS) === 'always';
    if (!(requested && !strict && !bank.used.has(requestKey)) && ctx.consent?.consume(terms, target) !== true) return ask();
    if (requestKey) bank.used.add(requestKey);
    bank.dialog = kind === 'dialog' ? undefined : { session: target.session, turn: target.turn, document: target.document, origin: target.origin, terms: { ...terms } };
    return allow;
  } catch { return refuse('Trusted rule evidence is unavailable.'); }
}

// One state per document, retained across turns. Capture when the snapshot read
// starts; deliver only after its text reaches the client. A private/failed read
// never calls deliverSnapshot. Do not reuse this state for another document.
export function beginSubmit(state, at = Date.now()) {
  const submit = { startedAt: at, snapshotNo: state.snapshotNo ?? 0 };
  state.submitUnconfirmed = submit; return submit;
}
export function finishSubmit(state, submit, effect = {}, at = Date.now()) {
  if (state.submitUnconfirmed !== submit) return;
  if (['navigated', 'formChanged', 'requestFinished'].some(key => effect[key] === true)) state.submitUnconfirmed = false;
  else submit.settledAt = at;
}
export function captureSnapshot(state, at = Date.now()) {
  const number = Math.max(state.snapshotNo ?? 0, captures.get(state) ?? 0) + 1;
  captures.set(state, number); return { state, number, capturedAt: at };
}
export function deliverSnapshot(state, snapshot) {
  if (snapshot.state !== state || !Number.isSafeInteger(snapshot.number) || snapshot.number < 1 ||
      !Number.isFinite(snapshot.capturedAt) || snapshot.capturedAt < 0) return false;
  state.snapshotNo = Math.max(state.snapshotNo ?? 0, snapshot.number);
  const submit = state.submitUnconfirmed;
  if (!submit || !Number.isFinite(submit.settledAt) || snapshot.number <= submit.snapshotNo ||
      snapshot.capturedAt < submit.settledAt || snapshot.capturedAt < submit.startedAt + 1000) return false;
  state.submitUnconfirmed = false; return true;
}

