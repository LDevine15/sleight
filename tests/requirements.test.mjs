import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandSkip, macCommandSkip, packageSkip } from './requirements.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('command requirements reject absent, nonexecutable and directory entries without launching them', t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-requirement-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(commandSkip('fake', dir), /fake.*PATH/);
  const path = join(dir, 'fake'); writeFileSync(path, '#!/bin/sh\nexit 99\n', { mode: 0o600 });
  assert.match(commandSkip('fake', dir), /fake.*PATH/);
  chmodSync(path, 0o700);
  assert.equal(commandSkip('fake', dir), false);
  mkdirSync(join(dir, 'directory'));
  assert.match(commandSkip('directory', dir), /directory.*PATH/);
  assert.match(macCommandSkip('fake', dir, 'linux'), /macOS/);
  assert.equal(macCommandSkip('fake', dir, 'darwin'), false);
});

test('package requirements name the absent package and accept built-in modules', () => {
  assert.match(packageSkip('sleight-absent-test-dependency'), /sleight-absent-test-dependency/);
  assert.equal(packageSkip('node:fs'), false);
});
