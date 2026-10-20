// Production shell launch and cleanup, with an offline engine and no host health probes.
import { run } from '../../plugins/sleight/lib/launch.mjs';
await run({ shellRoute: true, leaseDirectory: process.argv[2],
  healthHelperFactory: () => ({ close: async () => {}, keyboardTaps: async () => [] }),
});
