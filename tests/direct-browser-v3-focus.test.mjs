import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { focusCheckedNode } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';

// Execute the serialized reader itself, including the document/frame chain.
function focused({ redirect = false, nested = false, shadowFrame = false, host = false, open = false } = {}) {
  const top = { defaultView: { frameElement: null } }, child = { defaultView: {} };
  top.defaultView.top = top.defaultView;
  const frame = { isConnected: true, localName: 'iframe', ownerDocument: top };
  child.defaultView.frameElement = frame;
  const el = { isConnected: true, localName: host ? 'div' : 'input', ownerDocument: child };
  child.activeElement = el;
  top.activeElement = shadowFrame ? { shadowRoot: { activeElement: frame } } : frame;
  if (nested) {
    const middle = { defaultView: { frameElement: frame }, activeElement: null };
    const inner = { isConnected: true, localName: 'iframe', ownerDocument: middle };
    middle.activeElement = inner; child.defaultView.frameElement = inner;
  }
  if (redirect) top.activeElement = { localName: 'button' };
  if (open) el.shadowRoot = { activeElement: { localName: 'input' } };
  return runInNewContext('(' + focusCheckedNode.toString() + ')(el, true)', {
    el, HTMLElement: { prototype: { focus() {} } },
  });
}
for (const nested of [false, true]) test('V10R2A refuses a child document retaining stale focus after parent redirect; nested=' + nested, () => {
  assert.equal(focused({ redirect: true, nested }), false);
});
for (const options of [{}, { nested: true }, { shadowFrame: true }]) test('V10R2A accepts the complete focused frame chain ' + JSON.stringify(options), () => {
  assert.equal(focused(options), true);
});
for (const open of [false, true]) test('V10R2A shadow host is not evidence of the actual key receiver; open=' + open, () => {
  assert.equal(focused({ host: true, open }), false);
});
