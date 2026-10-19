import { moneyFigures, moneyConflicts } from './payment-figures.mjs';
import { paymentWords, refundableName } from './direct-browser/rules.mjs';

// The engine-path payment gate. LAWS: the payment rule holds on the engine path and on turbo alike, and the engine path had
// only policy text until gpt-6.1-sol paid an unpriced $268.00 test checkout in Firefox (race-1017, 2026-10-19).
//
// enginePayment decides with turbo's signals and turbo's figure rule (payment-figures.mjs) on the accessibility tree the guard
// already read for this action. It reads page content only: rows inside a web area ("HTML content") and the window's sheets,
// dialogs and alerts. Closure-free: document-scope.mjs runs it in the engine's REPL beside paymentAction, moneyFigures,
// moneyConflicts, paymentWords and refundableName, which this module imports or defines for Node callers.
//
// payment is { setting, message, spent, allow }: setting is SLEIGHT_CONFIRM_PAYMENTS ('requested', 'always' or 'never'); message
// is null when sleight holds no copy of the user's own message, else namedAmount's reading of it plus afterAsk (it came after a
// stop); spent is the payment already made for this message, as turbo allows one; allow is what the user allowed once in
// sleight's own card (payment-card.mjs). With probe, it answers only whether the action is submit-shaped on a page that shows a
// payment, for the guard's choice to read. Returns undefined for an action that isn't a payment, { allowed, site, shown,
// control, modal } for a payment that goes through, and { why, shown, named, site, control, modal } for one that stops.
export function enginePayment(name, args, text, payment, probe = false) {
  if (!payment || typeof text !== 'string' || !paymentAction(name, args)) return;
  // Only a web page or a sheet, dialog or alert can show a payment: any other tree goes ahead unparsed.
  if (!/^\t*\d+ (?:HTML content|sheet|dialog|alert)\b/im.test(text)) return;
  const rows = new Map(), stack = [];
  let focus;
  for (const raw of text.split('\n')) {
    const focused = /^The focused UI element is (\d+) /.exec(raw);
    if (focused) { focus = Number(focused[1]); continue; }
    const m = /^(\t*)(\d+) (.*)$/.exec(raw);
    if (!m) continue;
    while (stack.length && stack[stack.length - 1].depth >= m[1].length) stack.pop();
    const parent = stack[stack.length - 1], body = m[3];
    // A row's words: its label, Description and Value. Help, ID, URL, placeholder and actions are not page text.
    const parts = body.split(/, (?=(?:Description|Value|Help|ID|URL|Placeholder|Secondary Actions): )/);
    const shown = parts.filter(part => !/^(?:Help|ID|URL|Placeholder|Secondary Actions): /.test(part));
    const description = /^Description: (.*)$/.exec(shown.find(part => part.startsWith('Description: ')) ?? '')?.[1];
    const row = { depth: m[1].length, body, words: shown.join(' '), ancestors: parent ? [parent, ...parent.ancestors] : [],
      // The control's own name: its Description, else its label after the role and flags.
      name: description ?? parts[0].replace(/^[a-z][a-z ]*?(?: \([^)]*\))*(?: |$)/, ''),
      // Names that say what a field is for, without what was typed in it.
      field: parts.filter(part => !part.startsWith('Value: ')).join(' '),
      web: !!parent?.web || /^HTML content\b/i.test(body),
      // A sheet, dialog or alert, and Firefox's page dialog (a confirm() drawn as its own web area).
      modal: !!parent?.modal || /^(?:sheet|dialog|alert)\b/.test(body) || /^HTML content\b.*, URL: chrome:\/\/global\/content\/commonDialog\b/i.test(body) };
    rows.set(Number(m[2]), row); stack.push(row);
  }
  const role = (row, pattern) => !!row && new RegExp('^(?:' + pattern + ')(?: \\([^)]*\\))*(?: |,|$)').test(row.body);
  const page = [...rows.values()].filter(row => row.web || row.modal);
  // Turbo's payment-form signals: a card field (name, ID or label with cc-, card, cvv or cvc) or a pay-worded control.
  const cards = page.filter(row => row.web && role(row, 'text field|secure text field|text area|text entry area|search (?:text )?field|combo box') && /\bcc-|card|cvv|cvc/i.test(row.field));
  const payControl = row => row.web && role(row, 'button|link') && paymentWords(row.words);
  const paymentPage = cards.length > 0 || page.some(payControl);
  // The tree has no forms. The card fields' form is taken as their nearest common ancestor that holds a button, so a cookie
  // banner or the site's header beside the checkout stays outside it.
  let form = cards.length ? cards[0].ancestors.find(at => cards.every(row => row.ancestors.includes(at))) : undefined;
  while (form && !page.some(row => row.ancestors.includes(form) && role(row, 'button'))) form = form.ancestors[0];
  const inForm = row => !!form && row.ancestors.includes(form);
  const modalWords = page.filter(row => row.modal).map(row => row.words).join(' ');
  // A control that can pay: a pay-worded button or link, any other button in the card fields' form (a script can charge
  // from it, as turbo counts it) unless its name is on turbo's closed list of non-payment verbs (Apply, Remove, a stepper),
  // and a button in a sheet or dialog whose words name a payment.
  const pays = row => !!row && (row.web || row.modal) && (payControl(row) ||
    role(row, 'button') && (inForm(row) && !refundableName(row.name) || row.modal && paymentWords(modalWords)));
  const key = name === 'pressKey' && typeof args[0] === 'string' ? args[0].toLowerCase().split('+').pop() : undefined;
  const typed = ['typeText', 'paste'].includes(name) ? args.find(arg => typeof arg === 'string') : undefined;
  const enter = ['return', 'enter', 'kp_enter', 'keypadenter'].includes(key) || /[\r\n]/.test(typed ?? ''), space = key === 'space' || key === ' ';
  let shaped = false;
  if (name === 'click' || name === 'performSecondaryAction') shaped = Array.isArray(args[0]) ? paymentPage : pays(rows.get(args[0]));
  else if (enter || space) {
    const row = rows.get(focus);
    // Enter in a field submits its form. Focus outside the page (the address bar) submits nothing on it.
    shaped = !row ? paymentPage : !(row.web || row.modal) ? false : role(row, 'button|link') ? pays(row) : enter && inForm(row);
  }
  if (!shaped || probe) return shaped || undefined;
  // What the card names and an allowance binds to: the page's site, the largest figure, and the control or key.
  const target = name === 'click' || name === 'performSecondaryAction' ? rows.get(args[0]) : rows.get(focus);
  const control = Array.isArray(args[0]) ? 'point ' + JSON.stringify(args[0]) : name === 'click' || name === 'performSecondaryAction' ? target.body
    : (enter ? 'Enter' : 'Space') + ' in ' + (target?.body ?? 'the page');
  const address = page.find(row => row.web && !row.modal && /^HTML content\b.*, URL: /i.test(row.body))?.body.match(/, URL: ([^,]*)/)?.[1] ?? '';
  const site = address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];
  const lines = page.map(row => /^(?:radio button|check ?box|switch|toggle button)\b/.test(row.body) && /(?:^|, )Value: (?:1|on)(?:,|$)/.test(row.body)
    ? '\uE000' + row.words + '\uE001' : row.words);
  const { figures, parse } = moneyFigures(lines);
  const largest = list => list.filter(f => f.cur || f.value === Infinity).sort((a, b) => b.value - a.value)[0]?.text;
  const shown = largest(figures), modal = !!target?.modal, details = { site, shown, control, modal };
  const stop = (why, extra = {}) => ({ why, shown, ...extra, site, control, modal });
  const allow = payment.allow;
  if (allow && allow.site === site && allow.shown === shown && allow.control === control) return { allowed: 'card', ...details };
  // One payment per request, as on turbo. The dialog right after it (a confirm() showing the same figure) is that payment.
  const spent = payment.spent;
  if (spent) {
    const dialog = largest(moneyFigures(page.filter(row => row.modal).map(row => row.words)).figures);
    if (modal && !spent.modal && !spent.dialog && (dialog === undefined || dialog === spent.shown)) return { allowed: 'dialog', ...details };
    return stop('second');
  }
  const message = payment.message;
  if (!message) return stop('nocopy');
  if (message.several) return stop('several');
  if (message.amount === undefined) return stop('none');
  if (payment.setting === 'always' && !message.afterAsk) return stop('always');
  const amount = parse(String(message.amount));
  if (payment.setting !== 'never' && moneyConflicts(lines, message.amount, message.currency))
    return stop('over', { shown: largest(figures.filter(f => !(f.value <= amount + 0.005))) ?? shown, named: message.display });
  // The page has to show the amount the message named, as turbo requires of its terms.
  if (!figures.some(f => f.cur && Math.abs(f.value - amount) < 0.005)) return stop('mismatch', { named: message.display });
  return { allowed: payment.setting === 'never' ? 'never' : 'message', ...details };
}

// What Claude reads after the user chose Allow once in sleight's card: the stopped action wasn't sent, and one retry of it may go.
export const PAYMENT_ALLOWED = /* lean notice */ "sleight: the user allowed this payment once in sleight's card. Nothing was sent: send the same action again.";

// Whether an action can submit: a click or secondary action, Enter or Space, or text with a line break. Closure-free, like enginePayment.
export function paymentAction(name, args) {
  return ['click', 'performSecondaryAction'].includes(name) ||
    name === 'pressKey' && typeof args[0] === 'string' && /(?:^|\+)(?:return|enter|kp_enter|keypadenter|space| )$/i.test(args[0]) ||
    ['typeText', 'paste'].includes(name) && args.some(arg => typeof arg === 'string' && /[\r\n]/.test(arg));
}

// The amount the user's own message names: one money figure with its currency. Several different figures, or none, name no
// amount the gate can hold a page to.
export function namedAmount(text) {
  const { figures } = moneyFigures(String(text ?? '').split('\n'));
  const distinct = new Map(figures.filter(f => f.cur && Number.isFinite(f.value)).map(f => [f.value + ' ' + f.cur, f]));
  if (distinct.size > 1) return { several: true };
  const [one] = distinct.values();
  return one ? { amount: String(one.value), currency: one.cur, display: one.text } : {};
}

// The relay's payment state for the guard. The user's own message, which only the host-authenticated turn begin sets
// (relay.mjs), lasts until the user's turn ends; a message that follows a payment stop is marked afterAsk, which
// SLEIGHT_CONFIRM_PAYMENTS=always requires. spent is the payment the guard reported for that message (one per request), and
// allow is an Allow once from sleight's card, which goes to the next guarded call only and lasts two minutes.
export function createPaymentMessages({ now = Date.now } = {}) {
  let message, spent, allow, asked = false;
  return {
    begin() { message = undefined; spent = undefined; },
    set(text) { message = { ...namedAmount(text), afterAsk: asked }; asked = false; spent = undefined; },
    end() { message = undefined; spent = undefined; },
    asked() { asked = true; },
    paid(record) {
      const { site, shown, control, modal } = record ?? {};
      if (typeof control !== 'string') return;
      spent = spent && modal && !spent.modal ? { ...spent, dialog: true } : { site, shown, control, modal: !!modal };
    },
    allowed({ site, shown, control }) { allow = { site, shown, control, at: now() }; },
    guard(setting) {
      const { at, ...granted } = allow ?? {};
      const fresh = allow && now() - at <= 120000 ? granted : null;
      allow = undefined;
      return { setting, message: message ?? null, spent: spent ?? null, allow: fresh };
    },
  };
}
