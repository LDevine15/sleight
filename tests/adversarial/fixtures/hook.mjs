import { hookProof, hookOpen } from '../../../plugins/sleight/lib/direct-browser/page.mjs';

// Calling the page hook from a test. The hook lives at window[key] and every method takes a one-use proof
// as its first argument (see popupHook and hookProof in page.mjs). `f` is a bank fixture or a registry tab.
export const hookOf = f => (f.entry ?? f).hook;
export const proofFor = (f, method) => hookProof(hookOf(f), method);

// Source for page.evaluate: `api.name(` in code becomes a call on the hook with a fresh proof, one per call site, so
// hostile pages that replace the array helpers Playwright serializes arguments with still get a plain expression.
export function hookExpression(f, code) {
  const withProofs = code.replace(/\bapi\.(\w+)\(/g, (_, name) => `raw.${name}(${JSON.stringify(proofFor(f, name))}, `);
  return `(() => { const raw = window[${JSON.stringify(hookOf(f).key)}]; return ${withProofs}; })()`;
}

// The hook signs what it returns; hookOpen checks the signature and decodes. openDeep opens every signed string in a result.
const signed = /^[0-9a-f]{24}\.[0-9a-f]{64}\./;
export const openDeep = (f, value) => typeof value === 'string' && signed.test(value) ? hookOpen(hookOf(f), value)
  : Array.isArray(value) ? value.map(item => openDeep(f, item)) : value;
// Run `code` (see hookExpression) in the page and return what the hook answered, decoded.
export const callHook = async (f, code) => openDeep(f, await f.page.evaluate(hookExpression(f, code)));

// A function-form call for page.evaluate(fn, arg): fn receives { key, proofs } with one proof per method named.
export const hookArgs = (f, ...methods) => ({ key: hookOf(f).key, proofs: Object.fromEntries(methods.map(name => [name, proofFor(f, name)])) });

// 'live' while the hook answers, 'off' once off() ran (the property stays, its methods refuse), 'absent' if nothing is there.
export const hookState = (page, hook) => page.evaluate(({ key, proof }) => {
  const api = window[key];
  if (!api) return 'absent';
  try { api.take(proof); return 'live'; } catch (error) { return /is off/.test(error.message) ? 'off' : 'refused'; }
}, { key: hook.key, proof: hookProof(hook, 'take') });

// Unit-test fakes stand in for the page, so they answer as the hook would: a signed answer for the call the controller made.
// answerFor(hook, method, proof, value) signs `value` for `proof`; hookAnswer picks the method from what the controller sent
// (fn is the function handed to evaluate, arg its argument) and answers with values.prepare, .guard, .request, .verdict, .take.
import { createHmac } from 'node:crypto';
const textOf = (method, value) => {
  if (method === 'prepare') return value === true ? 't' : value === false ? 'f' : value.kind === 'refuse' ? 'refuse-' + value.reason : value.kind;
  if (method === 'guard' || method === 'off') return value ? 't' : 'f';
  if (method === 'takeRequest') {
    if (value === undefined) return 'u';
    if (value.violation) return 's' + value.violation;
    if (value.blocked) return 'b' + value.blocked;
    if (value.unavailable) return value.lost ? 'l' : 'n';
    return 'q' + value.url + '\0' + (value.target ?? '') + '\0' + (value.rel ?? '');
  }
  if (method === 'finish' || method === 'verdict') return typeof value === 'string' ? 's' + value : value === undefined ? 'u' : 't';
  if (method === 'take') return 'd' + value;
  return 'u';
};
export function answerFor(hook, method, proof, value) {
  const nonce = proof.slice(0, proof.indexOf('.')), text = textOf(method, value);
  return nonce + '.' + createHmac('sha256', hook.secret).update(method + ':' + nonce + ':' + text).digest('hex') + '.' + text;
}
export function hookAnswer(hook, fn, arg, values = {}) {
  if (arg?.prepare) return answerFor(hook, 'prepare', arg.prepare, values.prepare ?? true);
  if (arg?.guard) return answerFor(hook, 'guard', arg.guard, values.guard ?? true);
  const source = String(fn);
  if (/\.finish\(/.test(source)) return answerFor(hook, 'finish', arg.proof, values.verdict ?? true);
  if (/\.takeRequest\(/.test(source)) return answerFor(hook, 'takeRequest', arg.proof, values.request);
  if (/\.take\(/.test(source)) return answerFor(hook, 'take', arg.proof, values.take ?? 0);
  if (/\.off\(/.test(source)) return answerFor(hook, 'off', arg.proof, true);
  throw Error('no hook answer for ' + source.slice(0, 60));
}
