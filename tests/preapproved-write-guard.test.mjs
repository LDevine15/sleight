import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

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
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-policy-guard-')));
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
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-policy-traversal-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'Library/Application Support/sleight'); mkdirSync(join(directory, 'child'), { recursive: true });
  const alias = join(root, 'alias'); symlinkSync(join(directory, 'child'), alias);
  const resolve = async path => ({ realPath: realpathSync(path) });
  const path = `${alias}/../preapproved.json`;
  assert.equal(await guard({ tool: 'Write', file_path: path }, { stat: resolve }), true);
  assert.equal(await guard({ tool: 'Write', file_path: '~/alias/../preapproved.json' }, { stat: resolve, home: root }), true);
  assert.equal(await guard({ tool: 'Write', file_path: policy }, { stat, home: '/unrelated' }), true);
});

test('inline reads and script arguments remain allowed without statting source strings', async () => {
  let stats = 0;
  const counted = async path => { stats++; return stat(path); };
  for (const command of [
    `python3 -c "print(open('${policy}').read())"`,
    `node -e "console.log(require('fs').readFileSync('${policy}'))"`,
    `python3 script.py ${JSON.stringify(policy)}`,
    `python3 -c "${'x = 1; '.repeat(500)}print(open('${policy}').read())"`,
  ]) assert.equal(await guard({ tool: 'Bash', command }, { stat: counted }), false, command.slice(0, 80));
  assert.equal(stats, 0, 'source strings and read operands need no filesystem probes');
});

test('additional literal shell writers, nested shells and prefixes deny the policy', async () => {
  const p = JSON.stringify(policy), directory = JSON.stringify(policy.slice(0, -'/preapproved.json'.length));
  for (const command of [
    `ln -sf source ${p}`, `perl -pi -e 's/a/b/' ${p}`, `perl -i.bak -e 's/a/b/' ${p}`,
    `plutil -replace key -string value ${p}`, `plutil -insert key -string value ${p}`,
    `plutil -remove key ${p}`, `plutil -convert json ${p}`, `truncate -s 0 ${p}`, `dd if=source of=${p}`,
    `install source ${p}`, `rsync source ${p}`, `ruby -e "File.write('${policy}', '{}')"`,
    `printf '{}' >| ${p}`, `printf '{}' >& ${p}`,
    `bash -c 'tee "${policy}"'`, `sh -c 'rm "${policy}"'`, `xargs rm ${p}`,
    `printf '%s\\n' ${p} | xargs rm`, `time rm ${p}`, `nohup rm ${p}`, `env -i rm ${p}`,
    `cd ${directory} && tee preapproved.json`, `cd ${directory}; rm preapproved.json`,
    `cp source ${directory}`, `mv source ${directory}`, `rm -rf ${directory}`,
  ]) assert.equal(await guard({ tool: 'Bash', command }, { stat, home: '/Users/fixture' }), true, command);
});

test('inline write forms deny without probing code or long path-like strings', async () => {
  let stats = 0;
  const counted = async path => { stats++; return stat(path); };
  for (const command of [
    `python3 -c "p='${policy}'; open(p, mode='a').write('{}')"`,
    `node -e "const p='${policy}'; require('fs').appendFileSync(p, '{}')"`,
    `ruby -e "File.open('${policy}', 'w') { |f| f.write('{}') }"`,
  ]) assert.equal(await guard({ tool: 'Bash', command }, { stat: counted }), true, command);
  assert.equal(stats, 0);
  assert.equal(await guard({ tool: 'Bash', command: `rm ${'/x'.repeat(500)}` }, { stat: counted }), false);
  assert.equal(stats, 0, 'path operands longer than 511 characters are not probed');
});
