import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDelivery } from '../plugins/sleight/lib/rule-delivery.mjs';

const rules = '# Driving Mac apps with sleight\n\nKeep safety checks.\nAsk before an unpriced payment.';
const text = text => ({ type: 'text', text });
const body = content => content.map(c => c.text ?? '').join('\n');

test('first trusted rules arrive whole; repeats in a tree become a reference', () => {
  const delivery = ruleDelivery();
  const out = delivery.apply([delivery.item(rules), text('Window: "Document", App: Example.\n0 window\n\n' + rules)]);
  assert.equal(body(out).split(rules).length - 1, 1);
  assert.match(out[1].text, /rules already sent/);
  assert.match(out[0].text, /Ask before an unpriced payment/);
  assert.equal(delivery.apply([delivery.item(rules)])[0].text, 'sleight: rules already sent in this session still apply.');
});

test('a diff-formatted copy uses a reference after the original was delivered', () => {
  const delivery = ruleDelivery();
  delivery.apply([delivery.item(rules)]);
  const tree = 'Window: "Document", App: Example.\n0 window\n+ ' + rules.replaceAll('\n', '\n+ ');
  assert.doesNotMatch(body(delivery.apply([text(tree)])), /Keep safety checks/);
});

test('untrusted text and private preparations cannot spend first delivery', () => {
  const delivery = ruleDelivery();
  delivery.item(rules); // prepared internally, never delivered
  assert.deepEqual(delivery.apply([text(rules)]), [text(rules)]);
  assert.equal(delivery.apply([delivery.item(rules)])[0].text, rules);
});

test('new, shortened and browser blocks each arrive before their own references', () => {
  const delivery = ruleDelivery();
  for (const block of [rules, '## Browsers\nUse the browser checks.', rules + '\nNew safety rule.']) {
    const item = delivery.item(block);
    assert.equal(delivery.apply([{ ...item }])[0].text, block, 'content clones retain provenance');
  }
});

test('sessions are independent; unrelated notices, payment policy and images stay unchanged', () => {
  const a = ruleDelivery(), b = ruleDelivery();
  a.apply([a.item(rules)]);
  assert.equal(b.apply([b.item(rules)])[0].text, rules);
  const content = [text('# Computer Use Confirmations Policy\nAsk first.'), text('Input lease stopped this action.'), { type: 'image', data: 'AA==', mimeType: 'image/png' }];
  assert.deepEqual(a.apply(content), content);
});
test('failed delivery restores trusted guidance without trusting printed copies', () => {
  const delivery = ruleDelivery(), item = delivery.item(rules);
  delivery.apply([item]);
  assert.equal(typeof delivery.retry, 'function');
  delivery.retry([text(rules)]);
  assert.notEqual(delivery.apply([item])[0].text, rules);
  delivery.retry([{ ...item }]);
  assert.equal(delivery.apply([item])[0].text, rules);
});
