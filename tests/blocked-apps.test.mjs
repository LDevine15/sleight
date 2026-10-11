import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { ALLOW_FORBIDDEN_COMMAND, isSettingsTitle, matchBlockedApp, refusedApp, SETTINGS_TITLE }
  from '../plugins/sleight/lib/blocked-apps.mjs';

// ---- What the engine refuses, and what sleight does about it -------------

test('the refused list matches terminals and OpenAI apps by bundle, name or path', () => {
  assert.deepEqual(matchBlockedApp('Terminal'), { name: 'Terminal', terminal: true });
  assert.deepEqual(matchBlockedApp('iTerm'), { name: 'iTerm2', terminal: true });
  assert.deepEqual(matchBlockedApp('/Applications/iTerm.app'), { name: 'iTerm2', terminal: true });
  assert.deepEqual(matchBlockedApp('chatgpt'), { name: 'ChatGPT', openai: true });
  assert.deepEqual(matchBlockedApp('ChatGPT Beta'), { name: 'ChatGPT', openai: true });
  assert.deepEqual(matchBlockedApp('whatever', 'com.openai.codex'), { name: 'com.openai.codex', openai: true });
  assert.equal(matchBlockedApp('whatever', 'COM.OPENAI.CHAT.BETA').openai, true, 'bundle matching ignores case');
  assert.equal(matchBlockedApp('Mail', 'com.apple.mail'), undefined);
  assert.equal(matchBlockedApp('Calculator', 'com.apple.calculator'), undefined);
});

test('the engine refusal is recognized verbatim, with the refused identifier', () => {
  assert.equal(refusedApp("Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons."), 'com.apple.Terminal');
  assert.equal(refusedApp('some other failure'), undefined);
});

test('settings and preferences windows are recognized by title', () => {
  assert.equal(isSettingsTitle('Settings'), true);
  assert.equal(isSettingsTitle('Preferences…'), true);
  assert.equal(isSettingsTitle('settings'), true);
  assert.equal(isSettingsTitle('Réglages'), true);
  assert.equal(isSettingsTitle('Codex — chat'), false);
  assert.equal(isSettingsTitle('ChatGPT'), false);
  assert.equal(SETTINGS_TITLE.flags, 'i');
});

// ---- Relay: the refusal note ---------------------------------------------

const tick = () => new Promise(r => setImmediate(r));
const refusalText = "Computer Use is not allowed to use the app 'com.apple.Terminal' for safety reasons.";

function harness(options = {}) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const toClient = [];
  serverIn.resume();
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1', ...options });
  return {
    toClient,
    fromClient: msg => clientIn.write(JSON.stringify(msg) + '\n'),
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
  };
}

test('an engine refusal names the setting the user can change, and nothing else to try', async () => {
  const h = harness({ ask: async () => 'accept' });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("Terminal")' } } });
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: refusalText }] } });
  await tick();
  const texts = h.toClient[0].result.content.map(c => c.text).join('\n');
  assert.match(texts, /refuses com\.apple\.Terminal before any approval/);
  assert.ok(texts.includes(ALLOW_FORBIDDEN_COMMAND));
  assert.match(texts, /Don't work around this/);
  assert.doesNotMatch(texts, /blocked_app/);
});

test('results without the refusal pass through unchanged', async () => {
  const h = harness({ ask: async () => 'accept' });
  h.fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'let app = await cua.getApp("TextEdit")' } } });
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Window: "a.txt", App: TextEdit' }] } });
  await tick();
  assert.equal(h.toClient[0].result.content.length, 1);
});
