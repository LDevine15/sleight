#!/usr/bin/env node
// sleight-arch only, after engine approval of the exact fixture windows. Sends no input.
// node bench/ck3-certificate-probe.mjs --targets /private/tmp/ck3-targets.json
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { verifyWindowIdentity } from '../plugins/sleight/lib/window-identity.mjs';
import { tabProbeRefusal } from '../plugins/sleight/lib/tab-probe.mjs';

function approvedTargets(targets) {
  const apps = ['com.apple.Safari', 'org.mozilla.firefox'];
  assert.ok(Array.isArray(targets) && targets.length === 2, 'Supply both approved browser fixture windows');
  assert.deepEqual(targets.map(t => t.appId).sort(), [...apps].sort(), 'Supply Safari and Firefox once each');
  for (const target of targets) {
    assert.equal(target.ownerApproved, true, 'Engine app approval is required before native metadata reads');
    assert.ok(typeof target.title === 'string' && (target.url === null || typeof target.url === 'string'));
    assert.ok(Number.isSafeInteger(target.windowNumber) && target.windowNumber > 0);
  }
  return targets.map(({ appId, title, url, windowNumber }) => ({ appId, title, url, windowNumber }));
}

export async function probeCertificates(targets, { observe, now = Date.now, sleep: wait = sleep } = {}) {
  const windows = approvedTargets(targets), results = [];
  for (const target of windows) {
    const samples = [], since = now();
    let baseline, previous, reason;
    for (let i = 0; i < 2; i++) {
      if (i) await wait(50);
      const start = now();
      let observed;
      try { observed = await observe({ ...target, focus: true, tabCertificate: true }); } catch { reason = 'helper-error'; }
      const end = now();
      samples.push({ totalMs: end - start, walkMs: observed?.chrome?.walkMs ?? null,
        chrome: { complete: observed?.chrome?.complete === true, reason: observed?.chrome?.reason ?? null } });
      if (!observed?.chrome?.complete) { reason ??= observed?.chrome?.reason ?? 'incomplete-chrome'; break; }
      try { verifyWindowIdentity({ ...target, ...(baseline ? { nativeIdentity: baseline } : {}) }, observed); }
      catch { reason = 'identity-mismatch'; break; }
      baseline ??= observed;
      reason = tabProbeRefusal({ ...target, nativeIdentity: baseline }, observed, since, end);
      if (reason) break;
      const { walkMs, ...chrome } = observed.chrome;
      const signature = JSON.stringify([observed.title, observed.url, chrome]);
      if (previous && previous !== signature) { reason = 'unstable-chrome'; break; }
      previous = signature;
    }
    results.push({ appId: target.appId, certificate: !reason && samples.length === 2, reason: reason ?? null, samples });
  }
  return results;
}

async function main(argv) {
  assert.ok(argv.length === 2 && argv[0] === '--targets', 'Use --targets PATH to an approved fixture window JSON array');
  const targets = JSON.parse(await readFile(argv[1], 'utf8'));
  approvedTargets(targets);
  const { createAppHealthHelper } = await import('../plugins/sleight/lib/read-failure.mjs');
  const helper = createAppHealthHelper({ operationTimeoutMs: 1000 });
  const cancel = () => { process.exitCode = 130; void helper.close(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const report = await probeCertificates(targets, { observe: target => helper.windowIdentity(target) });
    console.log(JSON.stringify(report, null, 2));
    if (report.some(row => !row.certificate)) process.exitCode = 1;
  } finally {
    await helper.close();
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('CK3 probe failed. Check the approved fixture target file.'); process.exitCode = 1; });
}
