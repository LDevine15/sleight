// The README's shape: the three blocks bench/results-hub.mjs writes appear once each, in order, and the hand-written
// text around them stays under 110 lines. INSTALL.md exists and the README links it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');
const BLOCKS = ['hub:claim', 'hub:headline', 'hub:benchmarks'];

const count = (text, needle) => text.split(needle).length - 1;

test('each generated block appears once, opened before it is closed, in the planned order', () => {
  let last = -1;
  for (const name of BLOCKS) {
    assert.equal(count(readme, `<!-- ${name} -->`), 1, `${name} opens once`);
    assert.equal(count(readme, `<!-- /${name} -->`), 1, `${name} closes once`);
    const open = readme.indexOf(`<!-- ${name} -->`), close = readme.indexOf(`<!-- /${name} -->`);
    assert.ok(open < close, `${name} opens before it closes`);
    assert.ok(open > last, `${name} follows the block before it`);
    last = close;
  }
});

test('the README is under 110 lines outside the generated blocks', () => {
  let inside = false, outside = 0;
  for (const line of readme.trimEnd().split('\n')) {
    const marker = BLOCKS.find(name => line.trim() === `<!-- ${name} -->` || line.trim() === `<!-- /${name} -->`);
    if (marker) { inside = !line.includes('/hub:'); continue; }
    if (!inside) outside++;
  }
  assert.ok(outside < 110, `${outside} hand-written lines`);
});

test('the first screen explains the app, requirements and setup limits before the demo and claim', () => {
  const demo = readme.indexOf('src="docs/assets/demo.gif"');
  assert.ok(demo > readme.indexOf('ChatGPT desktop app'));
  assert.ok(demo > readme.indexOf('fresh macOS user'));
  assert.ok(demo < readme.indexOf('<!-- hub:claim -->'));
  assert.ok(readme.indexOf('<!-- hub:claim -->') < readme.indexOf('## Install'));
  assert.ok(readme.indexOf('## Install') < readme.indexOf('## Where it runs'));
});

test('INSTALL.md exists, the README links it, and it names the steps only the user can do', () => {
  assert.ok(existsSync(new URL('INSTALL.md', root)));
  assert.match(readme, /\]\(INSTALL\.md\)/);
  const install = readFileSync(new URL('INSTALL.md', root), 'utf8');
  for (const step of [/administrator/, /Accessibility and Screen Recording/, /Always allow/, /chrome:\/\/inspect\/#remote-debugging/])
    assert.match(install, step);
});

test('the README carries the agent prompt on a line of its own, as the plan writes it', () => {
  // bench/agent-install.mjs reads the prompt from this line.
  assert.match(readme, /^Install sleight from https:\/\/github\.com\/Land-o-Clusters\/sleight and check it with its doctor\.$/m);
});

test("INSTALL.md's shell commands find the plugin through the host's listing and stay plain", () => {
  // The agent-install sandbox can't read ~/.claude or ~/.codex, and its allowlist refuses scripts, substitutions and if blocks.
  const install = readFileSync(new URL('INSTALL.md', root), 'utf8');
  const shell = [...install.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]).join('');
  assert.ok(shell.length > 0);
  for (const line of shell.trim().split('\n')) {
    assert.doesNotMatch(line, /\$\(|`|^\s*(if|then|for|while|do)\b|\b(bash|sh|zsh|node|python3?)\s+-c\b|&&|\|\|/, line);
    assert.doesNotMatch(line, /~\/\.(claude|codex)\b/, line);
  }
  assert.match(shell, /^claude plugin list --json$/m);
  assert.match(shell, /^codex plugin list --json$/m);
  assert.ok(shell.includes('${CODEX_HOME:-$HOME/.codex}/plugins/'));
  assert.doesNotMatch(shell, /"\$CODEX_HOME\//);
});

test('the hosts table carries a Cursor row, switched off inside the cursor-row comment or switched on', () => {
  // Until Cursor's first live install passes, the row sits in an HTML comment right after the table's last row, so
  // deleting the comment's two marker lines adds it to the table.
  const table = readme.slice(readme.indexOf('## Where it runs'), readme.indexOf('<!-- hub:headline -->'));
  assert.match(table, /^\| Cursor \|/m);
  const off = /<!-- cursor-row:[^\n]*\n\| Cursor \|[^\n]*\n-->/.test(table);
  const on = !table.includes('cursor-row') && /^\| Other MCP clients \|[^\n]*\n\| Cursor \|/m.test(table);
  assert.ok(off || on, 'the Cursor row is either wholly inside the cursor-row comment or a plain table row');
});
