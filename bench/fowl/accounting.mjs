import { PRICES } from '../api-auth.mjs';
import { pathToFileURL } from 'node:url';

export const modelId = model => ({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }[model] ?? model);

// Every Claude arm runs on the owner's account login (owner, 2026-10-15). Only Browser Use needs the API key, and it
// runs in a round of its own (computer use keeps its login beside it).
export function roundAuth(model, surfaces) {
  surfaces = surfaces.filter(Boolean);
  if (!surfaces.includes('browser-use')) return 'account';
  if (surfaces.some(surface => !['browser-use', 'claude-cu'].includes(surface))) {
    throw new Error('Claude arms run on the owner\'s login; run browser-use, which needs the API key, in a round of its own');
  }
  return 'api';
}

export function roundPlan(args) {
  let model = 'opus', surface = 'fowlbrowser';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model') model = args[++i];
    else if (args[i] === '--surface') surface = args[++i];
  }
  if (!model || !surface) throw new Error('Model and surface options need a value');
  model = modelId(model);
  return { model, surface, auth: roundAuth(model, [surface]), command: 'node', args: ['tools/rounds.mjs', '--effort', 'medium', ...args.filter(arg => arg !== '--plan'), '--model', model] };
}

export function tokenCost(result, model) {
  const usage = result?.modelUsage;
  const entries = usage && typeof usage === 'object' && Object.keys(usage).length ? Object.entries(usage) :
    model && result?.usage ? [[model, { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
      cacheReadInputTokens: result.usage.cache_read_input_tokens, cacheCreationInputTokens: result.usage.cache_creation_input_tokens }]] : [];
  if (!entries.length) return;
  let total = 0;
  for (const [id, value] of entries) {
    const price = PRICES[modelId(id.replace(/\[.*\]$/, ''))];
    const counts = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'].map(key => value?.[key]);
    if (!price || counts.some(count => !Number.isFinite(count) || count < 0)) return;
    total += (counts[0] * price.input + counts[1] * price.output + counts[2] * price.cacheRead + counts[3] * price.input * 2) / 1e6;
  }
  return Math.round(total * 1e7) / 1e7;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--model-id' && args.length === 2) process.stdout.write(modelId(args[1]) + '\n');
  else if (args[0] === '--auth-mode' && args.length === 3) process.stdout.write(roundAuth(args[1], args[2].split('\n')) + '\n');
  else if (args.includes('--plan')) process.stdout.write(JSON.stringify(roundPlan(args)) + '\n');
  else throw new Error('Use --model-id NAME or --plan with round options');
}
