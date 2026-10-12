import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guard = async (...args) => {
  const { preapprovedWriteDenied } = await import('../plugins/sleight/hooks/preapproved-write-guard.mjs');
  return preapprovedWriteDenied(...args);
};
const policy = '/Users/fixture/Library/Application Support/sleight/preapproved.json';
const stat = async path => ({ realPath: path });

test('each file mutation denies the policy path and case and tilde spellings', async () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    for (const path of [policy, policy.toUpperCase(), '~/Library/Application Support/sleight/preapproved.json']) {
      assert.equal(await guard({ tool, file_path: path, notebook_path: path }, { stat }), true);
    }
    assert.equal(await guard({ tool, file_path: '/project/preapproved.json', notebook_path: '/project/preapproved.json' }, { stat }), false);
  }
  assert.equal(await guard({ tool: 'MultiEdit', edits: [{ file_path: policy }] }, { stat }), true);
});

test('named Bash mutation forms deny while reads and quoted operators pass', async () => {
  const p = JSON.stringify(policy);
  for (const command of [`printf '{}' > ${p}`, `echo '{}' >> ${p}`, `tee ${p}`, `cp source ${p}`,
    `mv ${p} backup`, `rm ${p}`, `sed -i '' 's/a/b/' ${p}`, `python3 -c "open('${policy}', 'w').write('{}')"`,
    `node -e "require('fs').writeFileSync('${policy}', '{}')"`, `defaults write ${p} enabled true`,
    `echo '{}' > ~/Library/Application\\ Support/sleight/preapproved.json`,
    `tee "$HOME/Library/Application Support/sleight/preapproved.json"`,
    `tee "\${HOME}/Library/Application Support/sleight/preapproved.json"`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), true, command);
  }
  for (const command of [`cat ${p}`, `sed -n '1p' ${p}`, `printf '%s' '>' ${p}`, `echo 'cp ${policy}'`, 'cp a /project/preapproved.json']) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), false, command);
  }
  assert.equal(await guard({ tool: 'Read', file_path: policy }, { stat }), false);
});

test('resolved file and parent symlinks protect existing and absent policy files', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sleight-policy-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'Library/Application Support/sleight'); mkdirSync(directory, { recursive: true });
  const target = join(directory, 'preapproved.json'); writeFileSync(target, '{}');
  const alias = join(root, 'alias'); symlinkSync(target, alias);
  const parent = join(root, 'parent'); symlinkSync(directory, parent);
  const resolve = async path => ({ realPath: realpathSync(path) });
  for (const path of [alias, join(parent, 'preapproved.json')]) {
    assert.equal(await guard({ tool: 'Write', file_path: path }, { stat: resolve }), true);
    assert.equal(await guard({ tool: 'Bash', command: `tee '${path}'` }, { stat: resolve }), true);
  }
  rmSync(target);
  assert.equal(await guard({ tool: 'Write', file_path: join(parent, 'preapproved.json') }, { stat: resolve }), true);
});

test('shell continuations and attached eval options cannot hide writes', async () => {
  for (const command of [`tee "${policy.replace('.json', '.\\\njson')}"`,
    `node -e"require('fs').writeFileSync('${policy}', '{}')"`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), true, command);
  }
});

test('copying or redirecting a policy read to another file remains allowed', async () => {
  const p = JSON.stringify(policy);
  for (const command of [`cat ${p} > /tmp/policy-copy.json`, `cp ${p} /tmp/policy-copy.json`,
    `cat ${p}; cp a b`, `cat ${p}\ncp a b`]) {
    assert.equal(await guard({ tool: 'Bash', command }, { stat }), false, command);
  }
});

test('symlink traversal precedes dot-dot normalization and HOME is only an expansion hint', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sleight-policy-traversal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'Library/Application Support/sleight'); mkdirSync(join(directory, 'child'), { recursive: true });
  const alias = join(root, 'alias'); symlinkSync(join(directory, 'child'), alias);
  const resolve = async path => ({ realPath: realpathSync(path) });
  const path = `${alias}/../preapproved.json`;
  assert.equal(await guard({ tool: 'Write', file_path: path }, { stat: resolve }), true);
  assert.equal(await guard({ tool: 'Write', file_path: '~/alias/../preapproved.json' }, { stat: resolve, home: root }), true);
  assert.equal(await guard({ tool: 'Write', file_path: policy }, { stat, home: '/unrelated' }), true);
});
