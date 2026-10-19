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
// payment is { setting, message }: setting is SLEIGHT_CONFIRM_PAYMENTS ('requested', 'always' or 'never'), and message is null
// when sleight holds no copy of the user's own message, else namedAmount's reading of it plus afterAsk (it came after a stop).
// With probe, it answers only whether the action is submit-shaped on a page that shows a payment, for the guard's choice to read.
// Returns undefined when the action goes ahead, else { why, shown, named } for the stop.
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
  const lines = page.map(row => /^(?:radio button|check ?box|switch|toggle button)\b/.test(row.body) && /(?:^|, )Value: (?:1|on)(?:,|$)/.test(row.body)
    ? '\uE000' + row.words + '\uE001' : row.words);
  const { figures, parse } = moneyFigures(lines);
  const largest = list => list.filter(f => f.cur || f.value === Infinity).sort((a, b) => b.value - a.value)[0]?.text;
  const shown = largest(figures);
  const message = payment.message;
  if (!message) return { why: 'nocopy', shown };
  if (message.several) return { why: 'several', shown };
  if (message.amount === undefined) return { why: 'none', shown };
  if (payment.setting === 'always' && !message.afterAsk) return { why: 'always', shown };
  if (payment.setting === 'never' || !moneyConflicts(lines, message.amount, message.currency)) return;
  const amount = parse(String(message.amount));
  return { why: 'over', shown: largest(figures.filter(f => !(f.value <= amount + 0.005))) ?? shown, named: message.display };
}

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

// The relay's copy of the user's own message, which only the host-authenticated turn begin sets (relay.mjs). It lasts until the
// user's turn ends. A message that follows a payment stop is marked afterAsk, which SLEIGHT_CONFIRM_PAYMENTS=always requires.
export function createPaymentMessages() {
  let message, asked = false;
  return {
    begin() { message = undefined; },
    set(text) { message = { ...namedAmount(text), afterAsk: asked }; asked = false; },
    end() { message = undefined; },
    asked() { asked = true; },
    guard(setting) { return { setting, message: message ?? null }; },
  };
}
