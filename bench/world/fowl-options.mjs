import { modelId } from '../fowl/accounting.mjs';

export function matrixOptions({ model = 'haiku', effort = 'high', runs = 1, world = true, dryRun = false, swap = false } = {}) {
  runs = Number(runs);
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new Error('Runs must be an integer from 1 to 100');
  if (!['low', 'medium', 'high', 'max'].includes(effort)) throw new Error('Invalid effort');
  if (typeof model !== 'string' || !model.trim()) throw new Error('Missing model');
  return { model: modelId(model), effort, runs, world, dryRun, swap };
}

export function roundArguments(options, args) {
  return [...args, '--model', options.model, '--effort', options.effort,
    ...(options.world ? ['--world'] : []), ...(options.swap ? ['--swap'] : [])];
}
