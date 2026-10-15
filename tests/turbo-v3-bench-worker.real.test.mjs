// Host-only: the benchmark arm's worker launches its own headless Chromium, serves the five
// v3 tools through the installed worker and trust join, and leaves no browser or profile behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const live = process.env.SLEIGHT_LIVE_DOM_TEST === '1';
const benchProfiles = () => readdirSync(tmpdir()).filter(name => name.startsWith('sleight-bench-v3-'));
const benchBrowsers = () => {
  try { return execFileSync('/bin/ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes('chrome-headless-shell') && line.includes('sleight-bench-v3-')).length; }
  catch { return -1; }
};

test('benchmark worker opens and reads a real local page by 127.0.0.1 and by name, then removes its browser and profile',
  { skip: live ? false : 'host real-page runner only (SLEIGHT_LIVE_DOM_TEST=1)', timeout: 90000 }, async t => {
    const posts = [];
    const server = createServer((req, res) => {
      if (req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', () => { posts.push(body); res.end('<title>Saved</title><p>Saved</p>'); }); return; }
      res.end('<!doctype html><title>Bench fixture</title><h1>Bench fixture</h1><form method="post" action="/save">' +
        '<label>Name<input name="name"></label><button>Save</button></form>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const profilesBefore = new Set(benchProfiles()), browsersBefore = benchBrowsers();  // earlier runs' orphans don't count
    const { createSession } = await import('../bench/turbo/v3-session.mjs');
    const session = await createSession({ origins: [origin], taskMessage: 'Open ' + origin + '/ and save the name Bench.' });
    const call = async (name, args) => { const request = { name, arguments: args }; const result = await session.call(request);
      session.delivered?.(result, request); return result; };
    try {
      const opened = await call('browser_open', { url: origin + '/' });
      assert.equal(opened.isError, false, opened.text);
      const tab = /\bt[0-9a-f]{32}\b/.exec(opened.text)?.[0];
      assert.ok(tab, opened.text);
      const read = await call('browser_read', { tab });
      assert.equal(read.isError, false, read.text);
      assert.match(read.text, /Bench fixture/);
      assert.equal(benchBrowsers() - browsersBefore, 1);
      // Names other than 127.0.0.1 resolve too: the bench browser reaches hosts like the user's own Chrome does.
      const named = await call('browser_open', { url: 'http://localhost:' + server.address().port + '/' });
      assert.equal(named.isError, false, named.text);
      assert.match(named.text, /Bench fixture/);
    } finally {
      await session.close();
    }
    for (let n = 0; n < 50 && benchBrowsers() > browsersBefore; n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(benchBrowsers(), browsersBefore);
    assert.deepEqual(benchProfiles().filter(name => !profilesBefore.has(name)), []);
  });
