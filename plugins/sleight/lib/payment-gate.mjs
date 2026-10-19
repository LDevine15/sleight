import { moneyFigures, moneyConflicts } from './payment-figures.mjs';
import { paymentWords, refundableName } from './direct-browser/rules.mjs';

// The engine-path payment gate. LAWS: the payment rule holds on the engine path and on turbo alike, and the engine path had
// only policy text until gpt-6.1-sol paid an unpriced $268.00 test checkout in Firefox (race-1017, 2026-10-19).
//
// enginePayment decides with turbo's figure rule (payment-figures.mjs) on the accessibility tree the guard already read for
// this action. It reads page content only: rows inside a web area ("HTML content") and the window's sheets, dialogs and
// alerts. Closure-free: document-scope.mjs runs it in the engine's REPL beside paymentAction, moneyFigures, moneyConflicts,
// paymentWords and refundableName, which this module imports or defines for Node callers.
//
// The decision is the page's, not a form's (the tree has no forms; review F1, 2026-10-19). A page shows a payment when it has a
// card field or a frame named for card payment, or a money figure above zero beside a control that reads as a submit. There,
// every submit-shaped action is gated: a click on a button or link, or on any other row whose own words (or a container's one
// or two levels up) read as a submit, any other button in the card fields' block unless its name is on turbo's closed list
// (Apply, Remove, a stepper), Enter, Return or a typed line break in any field, Enter or Space on the confirm dialog, and a
// click at a point. A page with no money figure above zero and no card field (a free booking) isn't a payment page.
//
// payment is { setting, message, spent, allow, now? }: setting is SLEIGHT_CONFIRM_PAYMENTS ('requested', 'always' or 'never');
// message is null when sleight holds no copy of the user's own message, else namedAmount's reading of it plus afterAsk (it came
// after a stop); spent is the payment already made for this message ({ site, shown, control, modal, at, dialog }), as turbo
// allows one; allow is what the user allowed once in sleight's own card (payment-card.mjs). With probe, it answers only whether
// the action is gated, for the guard's choice to read. Returns undefined for an action that isn't gated, { allowed, site, shown,
// control, modal, payment } for one that goes through and { why, shown, named, site, control, modal, payment } for one that
// stops. payment says whether the action is a payment, which spends the request's one: a pay-worded control, the confirm
// dialog, or Enter in a field beside card fields. A link never is.
export function enginePayment(name, args, text, payment, probe = false) {
  if (!payment || typeof text !== 'string' || !paymentAction(name, args)) return;
  // Only a web page or a sheet, dialog or alert can show a payment: any other tree goes ahead unparsed.
  if (!/^\t*\d+ (?:HTML content|sheet|dialog|alert)\b/im.test(text)) return;
  const FIELD = /^(?:text field|secure text field|text area|text entry area|search (?:text )?field|combo box)(?: \([^)]*\))*(?: |,|$)/;
  // Rows a click chooses or opens rather than submits.
  const CHOICE = /^(?:radio button|check ?box|switch|toggle button|slider|pop up button|menu button|disclosure triangle|tab|heading|HTML content|scroll area|standard window)\b/i;
  const BUTTON = /^button(?: \([^)]*\))*(?: |,|$)/, LINK = /^link(?: \([^)]*\))*(?: |,|$)/, HOLDER = /^(?:button|link|container|group)\b/;
  // The engine path's extra words (turbo's list stays as it is): submits, and the narrower ones that name a payment.
  const SUBMIT = /\b(?:place (?:your )?order|confirm|submit|complete|reserve|book|buy)\b/i;
  const PAYS = /\b(?:place (?:your )?order|confirm (?:order|purchase|payment|and pay)|submit (?:order|payment)|reserve)\b/i;
  const LEAVE = /^(?:cancel|close|dismiss|no|no thanks|not now|back)$/i;
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
    const field = FIELD.test(body), link = LINK.test(body);
    const row = { depth: m[1].length, body, field, link, words: shown.join(' '), ancestors: parent ? [parent, ...parent.ancestors] : [],
      // What the row says without what was typed into a field or a link's address.
      label: shown.filter(part => !(field || link) || !part.startsWith('Value: ')).join(' '),
      // The control's own name: its Description, else its label after the role and flags.
      name: description ?? parts[0].replace(/^[a-z][a-z ]*?(?: \([^)]*\))*(?: |$)/, ''),
      names: parts.filter(part => !part.startsWith('Value: ')).join(' '),
      web: !!parent?.web || /^HTML content\b/i.test(body),
      // The browser's own confirm(): Firefox draws it as its own web area; Safari as a sheet or alert outside the page.
      native: !!parent?.native || /^HTML content\b.*, URL: chrome:\/\/global\/content\/commonDialog\b/i.test(body) || !parent?.web && /^(?:sheet|alert)\b/.test(body),
      modal: !!parent?.modal || /^(?:sheet|dialog|alert)\b/.test(body) || /^HTML content\b.*, URL: chrome:\/\/global\/content\/commonDialog\b/i.test(body) };
    rows.set(Number(m[2]), row); stack.push(row);
  }
  const page = [...rows.values()].filter(row => row.web || row.modal);
  const KEYED = ['pressKey', 'press', 'typeText', 'paste'], keyed = KEYED.includes(name);
  const target = keyed ? rows.get(focus) : Array.isArray(args[0]) ? undefined : rows.get(args[0]);
  const point = (name === 'click' || name === 'doubleClick' || name === 'performSecondaryAction' || name === 'performAction') && Array.isArray(args[0]);
  if (target && !(target.web || target.modal)) return;
  if (target && !point && !keyed && (target.field || CHOICE.test(target.body))) return;
  const lines = page.map(row => /^(?:radio button|check ?box|switch|toggle button)\b/.test(row.body) && /(?:^|, )Value: (?:1|on)(?:,|$)/.test(row.body)
    ? '' + row.words + '' : row.words);
  const { figures, parse } = moneyFigures(lines);
  const money = list => list.filter(f => f.cur || f.value === Infinity);
  const priced = money(figures).some(f => f.value > 0.005);
  const submits = row => paymentWords(row.label) || SUBMIT.test(row.label);
  const reads = (row, test) => test(row) || row.ancestors.slice(0, 2).some(at => HOLDER.test(at.body) && at.label && test(at));
  const cards = page.filter(row => row.web && row.field && /\bcc-|card|cvv|cvc/i.test(row.names));
  const cardFrame = page.some(row => row.web && /\b(?:card payment|payment card)\b/i.test(row.label));
  const paymentPage = cards.length > 0 || cardFrame || priced && page.some(row => row.web && !row.field && !CHOICE.test(row.body) && submits(row));
  const modalRows = page.filter(row => row.modal), modalWords = modalRows.map(row => row.label).join(' ');
  const modalShown = money(moneyFigures(modalRows.map(row => row.words)).figures).sort((a, b) => b.value - a.value)[0]?.text;
  // A dialog shows a payment when its words name one and it, or the page under it, shows a figure or card words.
  const modalPayment = modalRows.length > 0 && (paymentWords(modalWords) || PAYS.test(modalWords)) &&
    (modalShown !== undefined || priced || cards.length > 0 || /\bcard\b/i.test(modalWords));
  // The card fields' block: their nearest common ancestor that holds a button not on the closed list.
  let block = cards.length ? cards[0].ancestors.find(at => cards.every(row => row.ancestors.includes(at))) : undefined;
  while (block && !page.some(row => row.ancestors.includes(block) && BUTTON.test(row.body) && !refundableName(row.name) && !LEAVE.test(row.name))) block = block.ancestors[0];
  const inBlock = row => !!block && row.ancestors.includes(block);
  const leaves = row => LEAVE.test(row.name.trim());
  const gatedClick = row => !!row && !leaves(row) && (row.modal ? modalPayment && BUTTON.test(row.body) :
    paymentPage && (reads(row, submits) || BUTTON.test(row.body) && inBlock(row) && !refundableName(row.name) || LINK.test(row.body) && reads(row, r => paymentWords(r.label))));
  const key = (name === 'pressKey' || name === 'press') && typeof args[0] === 'string' ? args[0].toLowerCase().split('+').pop() : undefined;
  const typed = ['typeText', 'paste'].includes(name) ? args.find(arg => typeof arg === 'string') : undefined;
  const enter = ['return', 'enter', 'kp_enter', 'keypadenter'].includes(key) || /[\r\n]/.test(typed ?? ''), space = key === 'space' || key === ' ';
  let gated = false, pays = false;
  if (point) gated = paymentPage || modalPayment;
  else if (enter || space) {
    // Enter in any field submits its form. Enter or Space on the confirm dialog answers it. Focus outside the page submits nothing on it.
    gated = !target ? enter && (paymentPage || modalPayment) : target.modal ? modalPayment && !leaves(target)
      : target.field ? enter && paymentPage : (enter || BUTTON.test(target.body)) && gatedClick(target);
    pays = gated && (!target || target.modal || target.field && cards.length > 0 || !target.link && reads(target, row => paymentWords(row.label) || PAYS.test(row.label)));
  } else if (!keyed) {
    gated = gatedClick(target);
    pays = gated && !target.link && (target.modal || reads(target, row => paymentWords(row.label) || PAYS.test(row.label)));
  }
  if (!gated || probe) return gated || undefined;
  // What the card names and an allowance binds to: the page's host, the largest figure, and the control or key.
  const address = page.find(row => row.web && !row.modal && /^HTML content\b.*, URL: /i.test(row.body))?.body.match(/, URL: ([^,]*)/)?.[1] ?? '';
  // The host alone: no scheme, path or user info (paypal.com@evil.test is evil.test). Parsed by hand, as the REPL may lack URL.
  const site = address.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0].split('@').pop().toLowerCase();
  const control = point ? 'point ' + JSON.stringify(args[0]) : keyed ? (enter ? 'Enter' : 'Space') + ' in ' + (target?.body ?? 'the page') : target.body;
  const largest = list => { const top = money(list).sort((a, b) => b.value - a.value)[0]?.text; return top === '￼' ? 'an unreadable figure' : top; };
  const shown = largest(figures), modal = !!target?.modal, now = payment.now ?? Date.now();
  const details = { site, shown, control, modal, payment: pays };
  const stop = (why, extra = {}) => ({ why, shown, ...extra, site, control, modal, payment: pays });
  if (point) return stop('point');
  const allow = payment.allow;
  if (allow && site && allow.site === site && allow.shown === shown && allow.control === control) return { allowed: 'card', ...details };
  // One payment per request, as on turbo. The browser's own confirm right after it, showing the same figure, within 60 s, once, is that payment.
  const spent = payment.spent;
  if (spent && pays) {
    if (target?.native && !spent.modal && !spent.dialog && now - spent.at <= 60000 && spent.site === site && modalShown === spent.shown)
      return { allowed: 'dialog', ...details };
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
  // The page has to show the amount the message named, as turbo requires of its terms. A value typed into a field doesn't count.
  const showsAmount = moneyFigures(page.map(row => row.label)).figures.some(f => f.cur && Math.abs(f.value - amount) < 0.005);
  if (!showsAmount) return stop('mismatch', { named: message.display });
  return { allowed: payment.setting === 'never' ? 'never' : 'message', ...details };
}

// What Claude reads when the card is still open after the hold (relay.mjs keeps it under the client's tool timeout).
export const PAYMENT_WAITING = /* lean notice */ "sleight: waiting for the user's answer on sleight's card. Send the same action again after they answer.";

// What Claude reads after the user chose Allow once in sleight's card: the stopped action wasn't sent, and one retry of it may go.
export const PAYMENT_ALLOWED = /* lean notice */ "sleight: the user allowed this payment once in sleight's card. Nothing was sent: send the same action again.";

// Whether an action can submit: a click, double click or press action, Enter or Space, or text with a line break. Closure-free, like enginePayment.
export function paymentAction(name, args) {
  return ['click', 'doubleClick', 'performSecondaryAction', 'performAction'].includes(name) ||
    (name === 'pressKey' || name === 'press') && typeof args[0] === 'string' && /(?:^|\+)(?:return|enter|kp_enter|keypadenter|space| )$/i.test(args[0]) ||
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
// SLEIGHT_CONFIRM_PAYMENTS=always requires. spent is the payment the guard reported for that message (one per request, a link
// never counts), and allow is an Allow once from sleight's card. It lasts until the action it matches spends it, the next user
// message, the turn's end or two minutes.
export function createPaymentMessages({ now = Date.now } = {}) {
  let message, spent, allow, asked = false;
  return {
    set(text) { message = { ...namedAmount(text), afterAsk: asked }; asked = false; spent = undefined; allow = undefined; },
    end() { message = undefined; spent = undefined; allow = undefined; },
    asked() { asked = true; },
    paid(record) {
      const { site, shown, control, modal, payment, allowed } = record ?? {};
      if (typeof control !== 'string') return;
      if (allowed === 'card') allow = undefined;
      if (payment !== true) return;
      spent = allowed === 'dialog' && spent ? { ...spent, dialog: true } : { site, shown, control, modal: !!modal, at: now() };
    },
    allowed({ site, shown, control }) { allow = { site, shown, control, at: now() }; },
    guard(setting) {
      if (allow && now() - allow.at > 120000) allow = undefined;
      const { at, ...granted } = allow ?? {};
      return { setting, message: message ?? null, spent: spent ?? null, allow: allow ? granted : null };
    },
  };
}
