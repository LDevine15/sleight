import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { ciTestFiles } from './fixtures/ci-suite.mjs';

test('the stripped CI audit includes every suite selected by npm test', () => {
  const files = ciTestFiles();
  for (const file of ['tests/requirements.test.mjs', 'bench/direct-browser2/test/input.test.mjs',
    'bench/native-path/test/contract.test.mjs', 'bench/direct-browser/test/tools.test.mjs',
    'bench/direct-native/test/compiler.test.mjs']) assert.ok(files.includes(file), file);
  assert.equal(new Set(files).size, files.length);
});

test('CI audit discovers added test directories and refuses unsupported selectors', t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ci-selection-')));
  mkdirSync(join(root, 'extra'));
  writeFileSync(join(root, 'extra/new.test.mjs'), '');
  writeFileSync(join(root, 'extra/helper.mjs'), '');
  const script = value => writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: value } }));
  script('node --test --test-concurrency=4 extra/*.test.mjs');
  assert.deepEqual(ciTestFiles(root), ['extra/new.test.mjs']);
  script('node --test extra/**/*.test.mjs');
  assert.throws(() => ciTestFiles(root), /unsupported.*selector/i);
});
