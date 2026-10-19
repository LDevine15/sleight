import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeCertificates } from '../bench/ck3-certificate-probe.mjs';

const targets = ['com.apple.Safari', 'org.mozilla.firefox'].map(appId => ({ appId, title: 'Fixture', url: null,
  windowNumber: 22, ownerApproved: true }));
const chrome = { complete: true, group: 1, childCount: 1, children: [2], tabCount: 1,
  tabs: [{ ref: 2, selected: true }], addressField: 3, focused: 3 };
const identity = target => ({ ...target, status: 'ok', epoch: 'helper', window: 1, pid: 123, processStart: 1,
  matches: 1, headerMatches: 1, windowSubrole: 'AXStandardWindow', hidIdleSeconds: 1000,
  chrome, focus: { sheets: 0, role: 'AXComboBox', inWindow: true, inPage: false } });

test('CK3 live probe requires a stable certificate in each approved browser and reports walk timings', async () => {
  let time = 1000, count = 0;
  const report = await probeCertificates(targets, { now: () => time, sleep: async ms => { time += ms; },
    observe: async target => { count++; assert.equal(target.tabCertificate, true); assert.equal(target.focus, true);
      time += 10; return { ...identity(target), chrome: { ...chrome, walkMs: count } }; } });
  assert.equal(count, 4);
  assert.deepEqual(report.map(row => [row.appId, row.certificate, row.samples.map(s => s.walkMs)]),
    [['com.apple.Safari', true, [1, 2]], ['org.mozilla.firefox', true, [3, 4]]]);
  assert.equal(JSON.stringify(report).includes('Fixture'), false);
});
test('CK3 live probe exposes the native refusal and never claims certificate success', async () => {
  const report = await probeCertificates(targets, { sleep: async () => {}, observe: async target => ({ ...identity(target),
    chrome: { complete: false, reason: 'chrome-transient', walkMs: 12 } }) });
  assert.equal(report.every(row => row.certificate === false), true);
  assert.equal(report[0].samples[0].chrome.reason, 'chrome-transient');
});
test('CK3 live probe refuses identity replacement and changing chrome', async () => {
  let count = 0, time = 1000;
  const report = await probeCertificates(targets, { now: () => time, sleep: async ms => { time += ms; }, observe: async target => {
    count++; time += 10;
    return { ...identity(target), ...(count === 2 ? { pid: 456 } : {}),
      chrome: { ...chrome, ...(count === 4 ? { group: 10 } : {}) } };
  } });
  assert.equal(report.every(row => row.certificate === false), true);
});
test('CK3 live probe validates all approvals and window identities before any AX request', async () => {
  for (const bad of [[targets[0]], [targets[0], { ...targets[1], ownerApproved: false }],
    [targets[0], { ...targets[1], windowNumber: undefined }], [targets[0], { ...targets[1], appId: 'other' }]]) {
    let count = 0;
    await assert.rejects(probeCertificates(bad, { observe: async () => { count++; } }));
    assert.equal(count, 0);
  }
});
