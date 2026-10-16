import test from 'node:test';
import assert from 'node:assert/strict';
import { scrub } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';

const R = '[redacted]';

for (const secret of ['o', 'on', 'ab', 'xyz', '12', '123', '🔑', '密码', 'é']) {
  test(`a ${Array.from(secret).length}-character secret blanks nothing outside its own row: ${secret}`, () => {
    for (const text of ['Account controls', 'Page 123 of 12', 'on xyz ab 🔑 密码 é résumé', `echo ${secret}`]) assert.equal(scrub(text, [secret]), text);
  });
}

test('a letters-only value of 4 to 7 characters goes only as a whole token', () => {
  assert.equal(scrub('test, the latest test results; test', ['test']), `${R}, the latest ${R} results; ${R}`);
  assert.equal(scrub('open the opened Open "open"', ['open']), `${R} the opened Open "${R}"`);
  assert.equal(scrub('contest pretest test1 attest', ['test']), 'contest pretest test1 attest');
  assert.equal(scrub('snake_test', ['test']), `snake_${R}`);
  assert.equal(scrub('Profile: hello-world', ['hello']), `Profile: ${R}-world`);
  assert.equal(scrub('naïve café', ['café']), `naïve ${R}`);
  assert.equal(scrub('cafés', ['café']), 'cafés');
});

test('a value with a digit or symbol, or a long word, goes wherever it appears', () => {
  assert.equal(scrub('code1234 and 1234x', ['1234']), `code${R} and ${R}x`);
  assert.equal(scrub('hunter2xyz and hunter2', ['hunter2']), `${R}xyz and ${R}`);
  assert.equal(scrub('a-b-c user:pa$$word!', ['pa$$word']), `a-b-c user:${R}!`);
  assert.equal(scrub('xcorrecthorsex', ['correcthorse']), `x${R}x`);
  assert.equal(scrub('my passphrase here', ['my passphrase']), `${R} here`);
  assert.equal(scrub('a.b*c(d) [e]', ['.b*c(d)']), `a${R} [e]`);
});

test('multi-byte values: unspaced scripts and emoji go wherever they appear', () => {
  assert.equal(scrub('密码是你好吗吗吗', ['你好吗吗']), `密码是${R}吗`);
  assert.equal(scrub('x🔑🔑🔑🔑y', ['🔑🔑🔑🔑']), `x${R}y`);
  assert.equal(scrub('🔑🔑🔑 only three', ['🔑🔑🔑']), '🔑🔑🔑 only three');
  assert.equal(scrub('Привет мир, приветствие', ['Привет']), `${R} мир, приветствие`);
});

test('a value echoed in a label or name is removed', () => {
  assert.equal(scrub('Enter 482913 to continue', ['482913']), `Enter ${R} to continue`);
  assert.equal(scrub('Code sent: hunter22', ['hunter22']), `Code sent: ${R}`);
  assert.equal(scrub('https://example.test/?otp=482913&x=1', ['482913']), `https://example.test/?otp=${R}&x=1`);
});

test('the whitespace-normalised form of a value is removed too', () => {
  assert.equal(scrub('is alpha beta', ['alpha  beta ']), `is ${R}`);
  assert.equal(scrub('alpha​ beta', ['​alpha beta']).includes('alpha'), true, 'only the raw and normalised forms are matched');
});

test('longest first, deduplicated, and card-like digit runs always go', () => {
  assert.equal(scrub('hunter2xyz and hunter2', ['hunter2', 'hunter2xyz', 'hunter2']), `${R} and ${R}`);
  assert.equal(scrub('card 4242 4242 4242 4242 ok', []), `card ${R}ok`);
  assert.equal(scrub(undefined, ['abcdef']), '');
});
