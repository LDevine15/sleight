// The ordinary launcher with an empty benchmark approval store. No user approval file is read or written.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { PreapprovedApps } from '../../plugins/sleight/lib/preapproved.mjs';

export const replayApprovalStorage = {
  load: () => new PreapprovedApps({ version: 1, apps: [] }),
  live: store => store,
  add: () => { throw Error('Replay cannot persist app approval'); },
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { run } = await import('../../plugins/sleight/lib/launch.mjs');
  // Keep payment guards active. No payment card is answered or shown by this headless driver.
  await run({ directBrowser: false, approvalStorage: replayApprovalStorage, paymentCardFactory: () => undefined });
}
