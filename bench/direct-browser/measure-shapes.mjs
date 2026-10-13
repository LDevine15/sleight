import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { browserTools, validateCall } from './tools.mjs';

// Named deterministic lexical tokenizer. It is a proxy, not a model BPE or
// evidence of billed Haiku output. Value text is measured separately, not cut.
export const TOKENIZER = 'sleight-json-lexical-v1: Unicode words and punctuation (proxy)';
export const tokenize = text => text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
export function size(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { bytes: Buffer.byteLength(text), lexical_tokens_proxy: tokenize(text).length,
    chars_div_4_proxy: text.length / 4 };
}
export function measureShapes() {
  const scenarios = [
    { name: 'action', arguments: { tab: 't1', op: 'click', ref: 'r7' }, tool: 'browser_act',
      prior: { name: 'js', arguments: { title: 'Click Continue', code: 'await tab.playwright.getByRole("button", { name: "Continue", exact: true }).click(); nodeRepl.write(await tab.getAXState());' } } },
    { name: 'read', arguments: { tab: 't1' }, tool: 'browser_read',
      prior: { name: 'js', arguments: { title: 'Read tab', code: 'nodeRepl.write(await tab.getAXState({ disableDiffing: true }));' } } },
    { name: 'form', arguments: { tab: 't1', fields: [{ ref: 'r8', value: 'Ada' }, { ref: 'r9', value: true }] }, tool: 'browser_fill',
      prior: { name: 'js', arguments: { title: 'Fill observed form', code: 'await tab.playwright.getByLabel("Name", {exact:true}).fill("Ada"); await tab.playwright.getByRole("checkbox", {name:"Updates",exact:true}).check(); nodeRepl.write(await tab.getAXState());' } } },
  ];
  const schema = size(browserTools());
  const rows = scenarios.map(example => {
    const call = validateCall({ name: example.tool, arguments: example.arguments });
    const response = { completed: example.name === 'form' ? 2 : 1,
      results: [{ effect: 'verified' }], observation: { text: 'fixture state', untrusted: true } };
    return { name: example.name, arguments: size(example.arguments), call: size(call), response: size(response),
      exchange: size({ call, response }), prior_synthetic_call: size(example.prior),
      extra_recovery_read: size({ name: 'browser_read', arguments: { tab: 't1' } }),
      final_narration_example: size('The requested field state is verified.'), thinking_tokens: null, actual_model_tokens: null };
  });
  return { tokenizer: TOKENIZER, corpus: 'synthetic matched intents, no model or browser', schema, rows,
    schema_amortization: [1, 13, 100].map(calls => ({ calls, bytes_per_call: schema.bytes / calls,
      lexical_tokens_proxy_per_call: schema.lexical_tokens_proxy / calls })),
    short_field_pair_excluding_value_text: size({ ref: 'r8', value: '' }),
    model_argument_token_targets: { action: 40, read: 20, short_field_pair_excluding_value_text: 15 },
    model_target_verdict: 'unmeasured; no named model tokenizer installed',
    historical_projection_seconds: [41.7, 64.2], historical_projection_is_measured_saving: false };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.stdout.write(JSON.stringify(measureShapes(), null, 2) + '\n');
