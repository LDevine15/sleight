import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { verifyWindowIdentity } from '../plugins/sleight/lib/window-identity.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

for (const [header, missing] of [
  ['Window: "Document", App: Example\n0 standard window Document', 'bundle ID'],
  ['unavailable observation', 'bundle ID, full window header'],
]) test(`a missing lease identity names ${missing} and preserves its supported read`, async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-lease-guidance-')));
  const lease = new InputLease({directory});
  const streams = Array.from({length: 4}, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], received = [];
  serverIn.on('data', data => sent.push(JSON.parse(data.toString())));
  clientOut.on('data', data => received.push(JSON.parse(data.toString())));
  const relay = createRelay({clientIn, clientOut, serverIn, serverOut, inputLease: lease, changeReview: false});
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); lease.close(); removeTemp(directory); });
  const call = (id, code) => clientIn.write(JSON.stringify({id, method: 'tools/call', params: {name: 'js', arguments: {code}}}) + '\n');
  call(1, 'let app = await cua.getApp("Example");');
  serverOut.write(JSON.stringify({id: 1, result: {content: [{type: 'text', text: header}]}}) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const before = sent.length;
  call(2, 'await app.click(1);');
  assert.equal(sent.length, before, 'refused input never reaches the engine');
  const reply = received.find(m => m.id === 2);
  assert.equal(reply.result.isError, true);
  const text = reply.result.content.map(c => c.text).join('\n');
  assert.ok(text.includes(`Missing target identity: ${missing}.`), text);
  assert.match(text, /Send exactly.*await cua\.(?:getApp|getState)\(/);
  assert.equal(lease.owned.size, 0);
});

test('unavailable native identity lists its missing fields and an exact read', () => {
  assert.throws(() => verifyWindowIdentity({appId: 'sample.app'}, {status: 'unknown'}), error => {
    assert.match(error.message, /Missing target identity:.*epoch.*window.*pid.*processStart/);
    assert.match(error.message, /await cua.getApp\("sample.app"\)/);
    return true;
  });
});

test('changed native identity retains the mismatch and gives a read before any input', () => {
  const expected = {appId: 'sample.app', title: 'Document', url: null,
    nativeIdentity: {epoch: 'one', window: 1, pid: 123, processStart: 1}};
  assert.throws(() => verifyWindowIdentity(expected, {...expected, status: 'ok', matches: 1,
    epoch: 'one', window: 2, pid: 123, processStart: 1}), error => {
    assert.match(error.message, /native window or its process changed/);
    assert.match(error.message, /Changed target identity/);
    assert.match(error.message, /await cua.getApp\("sample.app"\)/);
    return true;
  });
});

test('a competing lease keeps the holder, remaining time and wait instruction', () => {
  const lease = new InputLease({holder: 'this session', now: () => 2000});
  const error = lease.refusal({holder: 'other session', expires: 31000});
  assert.match(error.message, /held by other session; 29 s remaining/);
  assert.match(error.message, /Stop actions and retry after that turn ends or the lease expires/);
  assert.equal(lease.owned.size, 0);
  lease.close();
});
