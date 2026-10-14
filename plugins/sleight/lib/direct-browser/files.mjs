import { randomBytes } from 'node:crypto';
import { createFileAuthority } from './host-files.mjs';
import { sameAuthority } from './protected-proof.mjs';
import { canonical } from './authority.mjs';

// V3 actions consume the existing private-channel provider's single-use bytes.
// Neither a tool's paths nor the inspected page can supply event or binding.
export async function stageUserUploads(files, paths, ref) {
  if (!files?.event || files.binding?.ref !== ref || typeof files.provider?.offer !== 'function' ||
      typeof files.provider?.stage !== 'function') throw Error('user-named file provider required; use the engine browser path');
  const handle = files.provider.offer(files.event, paths, ref);
  return files.provider.stage([handle], files.binding);
}

// readUserMessage is the private authenticated user channel, never an IPC field
// or page string. It returns the user's exact message and owning session.
export function createUserFileProvider({ readUserMessage, resolveInput, current, now = Date.now } = {}) {
  if ([readUserMessage, resolveInput, current, now].some(f => typeof f !== 'function')) throw Error('USER_FILE_PROVIDER_REQUIRED');
  const offers = new Map(), stages = new Map(); let approval, closed = false;
  const authority = createFileAuthority({ now, approve: data => approval && canonical(data) === canonical(approval) });
  const reject = () => { throw Error('USER_NAMED_FILE_REQUIRED'); };
  const names = name => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  function cleanup(session) {
    for (const [stage, binding] of stages) {
      if (session !== undefined && binding.clientSession !== session) continue;
      try { if (stage.cleanup()?.retained === false) stages.delete(stage); } catch {}
    }
    return { retained: [...stages.values()].filter(binding => session === undefined || binding.clientSession === session).length };
  }
  return Object.freeze({ authority,
    offer(event, paths, ref) {
      if (closed || offers.size >= 128) reject();
      const message = readUserMessage(event), input = resolveInput(ref);
      if (!input || !sameAuthority(input, current()) || message?.session !== input.clientSession ||
          typeof message?.text !== 'string' || typeof input.name !== 'string' || !input.name.trim() ||
          !Array.isArray(paths) || !paths.length || paths.length > 16 || paths.some(path => typeof path !== 'string') || new Set(paths).size !== paths.length) reject();
      // A deliberately closed user-message grammar. Mentions, negations, path
      // prefixes and another input's name confer no file authority. The host
      // may supply a parsed exact upload intent from that same user channel.
      const parsed = message.upload;
      const match = /^(?:Please\s+)?(?:Upload|Attach)\s+(.+?)\s+(?:to|in|for)\s+(.+?)[.]?$/i.exec(message.text.trim());
      let namedPaths, namedInput;
      if (parsed?.paths && typeof parsed.input === 'string') { namedPaths = parsed.paths; namedInput = parsed.input; }
      else if (match) {
        namedInput = match[2];
        namedPaths = match[1].split(/,\s*(?=["'])/).map(path => path.replace(/^(["'])(.*)\1$/, '$2'));
      }
      if (!Array.isArray(namedPaths) || canonical(namedPaths) !== canonical(paths) || typeof namedInput !== 'string' || names(namedInput) !== names(input.name)) reject();
      // Snapshot canonical identity and bytes while the authenticated request is
      // fresh. A path mentioned only by a page cannot reach this entry.
      const snapshot = authority.checkPaths(paths), issued = now();
      if (!Number.isFinite(issued) || issued < 0) reject();
      const handle = 'f' + randomBytes(16).toString('hex');
      offers.set(handle, { input: structuredClone(input), paths: [...paths], snapshot, issued });
      return handle;
    },
    async stage(handles, binding) {
      if (closed || !Array.isArray(handles) || handles.length !== 1) reject();
      const entry = offers.get(handles[0]), input = resolveInput(binding.ref), time = now();
      offers.delete(handles[0]); // Unknown or failed transfer is never replayed.
      if (!entry || !input || !sameAuthority(binding, current()) || !sameAuthority(entry.input, binding) ||
          input.ref !== entry.input.ref || input.ref !== binding.ref || input.name !== entry.input.name || !sameAuthority(input, binding) ||
          !Number.isFinite(time) || time < entry.issued || time >= entry.issued + 30000 || !authority.unchanged(entry.snapshot)) reject();
      approval = { binding: structuredClone(binding), paths: entry.paths };
      try {
        const capability = await authority.issue(entry.paths, binding);
        if (!sameAuthority(binding, current())) reject();
        const stage = authority.stage(capability, binding); stages.set(stage, structuredClone(binding)); return stage;
      } finally { approval = undefined; }
    },
    cleanup,
    dispose() { closed = true; approval = undefined; offers.clear(); return cleanup(); },
  });
}
