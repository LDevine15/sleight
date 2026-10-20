import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileProbe, probeHostSource, runProbe, stepVerdict } from '../bench/consent-guard-probe.mjs';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

test('missing delivery is inconclusive and acceptance outweighs a refusal receipt', () => {
  assert.equal(stepVerdict([]), 'no-receipt');
  assert.equal(stepVerdict([{ outcome: 'armed' }]), 'no-receipt');
  assert.equal(stepVerdict([{ outcome: 'refused' }]), 'refused');
  assert.equal(stepVerdict([{ outcome: 'refused' }, { outcome: 'accepted' }]), 'accepted');
  assert.throws(() => probeHostSource('wrong source'), /CONSENT_PROBE_SOURCE_DRIFT/);
});

test('probe and separate poster compile without launching either binary', { skip: macCommandSkip('xcrun') }, t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-consent-probe-build-'))));
  const binaries = compileProbe(directory);
  assert.ok(existsSync(binaries.host));
  assert.ok(existsSync(binaries.poster));
});

test('probe uses card receipts for all five steps and closes its owned host, fake processes only', async t => {
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-consent-probe-fake-'))));
  const host = join(directory, 'host'), poster = join(directory, 'poster'), stopped = join(directory, 'stopped');
  writeFileSync(host, `#!${process.execPath}
const { createInterface } = require('node:readline');
const { writeFileSync } = require('node:fs');
const emit = record => console.log(JSON.stringify(record));
emit({ outcome: 'ready', pid: process.pid, x: 10, y: 20 });
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const command = JSON.parse(line);
  if (command.step) {
    emit({ outcome: 'armed', step: command.step });
    setTimeout(() => {
      const accepted = command.step.startsWith('person-');
      emit({ outcome: accepted ? 'accepted' : 'refused', step: command.step });
      if (accepted) emit({ outcome: 'ready', pid: process.pid, x: 10, y: 20 });
    }, 100);
  }
  if (command.finish) { writeFileSync(${JSON.stringify(stopped)}, 'closed'); lines.close(); process.stdin.destroy(); }
});
`);
  writeFileSync(poster, `#!${process.execPath}\nconsole.log(JSON.stringify({ mode: process.argv[2] }));\n`);
  chmodSync(host, 0o700); chmodSync(poster, 0o700);
  const log = [];
  const result = await runProbe({ directory, binaries: { host, poster }, say: record => log.push(record) });
  assert.equal(result.passed, true);
  assert.deepEqual(result.steps.map(({ step, verdict }) => [step, verdict]), [
    ['ax', 'refused'], ['pid', 'refused'], ['hid', 'refused'], ['person-click', 'accepted'], ['person-return', 'accepted'],
  ]);
  assert.equal(log.filter(record => record.poster).length, 3);
  assert.equal(readFileSync(stopped, 'utf8'), 'closed');
  assert.equal(existsSync(join(directory, 'grants.json')), false);
});
