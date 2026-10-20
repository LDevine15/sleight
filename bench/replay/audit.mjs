import { replayCalls } from './engine.mjs';
import { prepareReplay } from './fixtures.mjs';

// Offline only. A mapping read has no recorded response and cannot consume the next action's result.
export async function auditRecording(recording) {
  const prepared = prepareReplay(recording, '/private/tmp/sleight-replay-offline-audit/fixture');
  let fed = 0;
  const replay = await replayCalls(recording.calls, { mapper: prepared.mapper, call: async (server, name, args) => {
    const original = recording.calls[fed];
    if (!original || server !== original.server || name !== original.name ||
        JSON.stringify(args) !== JSON.stringify(prepared.mapper.arguments(original.arguments)))
      throw Error('Offline audit has no recorded response for a mapping read');
    fed++;
    // Fixture substitutions are the only changes to the recorded response stream.
    const result = structuredClone(original.result);
    for (const block of result.content ?? []) if (block.type === 'text') block.text = prepared.mapper.replaceStrings(block.text);
    return result;
  } });
  return { planned: recording.calls.length, fed, reached: replay.calls.length, verdict: replay.verdict, reason: replay.reason ?? null };
}
