// The ordinary launcher with an empty benchmark approval store. No user approval file is read or written.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PreapprovedApps } from '../../plugins/sleight/lib/preapproved.mjs';
import { requireReplayLauncher } from './launcher-contract.mjs';

export const replayApprovalStorage = {
  load: () => new PreapprovedApps({ version: 1, apps: [] }),
  live: store => store,
  add: () => { throw Error('Replay cannot persist app approval'); },
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--worktree')) throw Error('Expected --worktree PATH');
  const worktree = args.length ? resolve(args[1]) : fileURLToPath(new URL('../..', import.meta.url));
  const entry = pathToFileURL(requireReplayLauncher(worktree));
  const { run } = await import(entry);
  // Keep payment guards active. No payment card is answered or shown by this headless driver.
  await run({ directBrowser: false, approvalStorage: replayApprovalStorage, paymentCardFactory: () => undefined });
}
