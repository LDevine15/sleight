// Run the suite without optional host tools or package dependencies.
import { mkdtempSync, mkdirSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { trackTemp } from '../../scripts/temp-leftovers.mjs';
import { ciTestFiles } from './ci-suite.mjs';

if (existsSync('node_modules')) throw new Error('remove the worktree node_modules link before the CI audit');
const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ci-path-'))), bin = join(root, 'bin'), home = join(root, 'home');
mkdirSync(bin); mkdirSync(home);
try {
  const commands = ['bash', 'sh', 'env', 'sleep', 'mkdir', 'rm', 'mv', 'cp', 'chmod', 'cat', 'dirname',
    'basename', 'tr', 'find', 'awk', 'head', 'tail', 'date', 'sort', 'uniq', 'wc', 'git', 'mkfifo',
    'touch', 'readlink', 'ps', 'zip', 'unzip', 'true', 'false', 'xargs', 'ln', 'pwd', 'sed', 'grep',
    'rmdir', 'mktemp', 'diff', 'cut', 'stat', 'id', 'uname', 'tee', 'printf'];
  for (const name of commands) {
    const source = ['/bin', '/usr/bin'].map(dir => join(dir, name)).find(existsSync);
    if (source) symlinkSync(source, join(bin, name));
  }
  symlinkSync(process.execPath, join(bin, 'node'));
  const files = ciTestFiles();
  const child = spawn(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=./tests/fixtures/ci-reporter.mjs', ...files], {
    env: { ...process.env, PATH: bin, HOME: home }, stdio: 'inherit',
  });
  const interrupt = () => child.kill('SIGINT');
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve(code));
  });
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  process.exitCode = result ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
