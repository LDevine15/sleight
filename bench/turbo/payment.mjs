// Bench-only natural-language binding. Exact page terms are independent evidence;
// the authenticated runner task must name each term. Missing terms refuse rather
// than echoing the user's request into page evidence or granting from page text.
export function taskPayment(message, page) {
  if (typeof message !== 'string' || !page || !['item', 'payee', 'amount'].every(key =>
    typeof page[key] === 'string' && page[key]) || !/^\d+\.\d{2}$/.test(page.amount)) return null;
  if (!/^\s*(?:buy|purchase|pay\s+for)\b/i.test(message) || /\b(?:don't|do not|never|before|stop)\b/i.test(message)) return null;
  const card = message.match(/\bcard\s+(\d[\d -]{2,}\d)\b/i);
  const amounts = [...message.matchAll(/\$([\d,]+\.\d{2})/g)].map(match => match[1].replaceAll(',', ''));
  if (!card || amounts.length !== 1 || amounts[0] !== page.amount ||
      ![page.item, page.payee].every(term => message.toLowerCase().includes(term.toLowerCase()))) return null;
  return { ...page, method: 'card ' + card[1] };
}

// Fixed read-only fixture evidence, never a model callback. Arbitrary runner
// pages need not supply it; their payments then stop at the production gate.
export function paymentEvidence() {
  const read = name => document.querySelector('meta[name="sleight-bench-' + name + '"]')?.content;
  return { item: read('item'), payee: read('payee'), amount: read('amount') };
}
