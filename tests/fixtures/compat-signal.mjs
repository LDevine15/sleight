// Runs the live tier with fakes that hang inside the Calculator check (or, with "browser", inside the browser check
// after its fixture setup failed), for the signal cleanup tests. The interval stands in for the engine session, which
// keeps a real run alive.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveTier } from '../../bench/compat.mjs';

const [dir, mode] = process.argv.slice(2);
const mark = text => appendFileSync(join(dir, 'marks'), text + '\n');
const real = await import('../../bench/compat/live.mjs');
await liveTier({ ownerAway: true, holdPath: join(dir, 'hold'), lockPath: join(dir, 'live.lock'),
  open: async () => ({ close: async () => mark('client closed') }),
  live: { ...real, CALCULATOR: 'com.apple.calculator', idleSeconds: async () => 999, fixtures: {},
    launchApp: async () => ({ pid: 41 }), quitApp: async (bundle, launched) => mark(`quit ${launched.pid}`),
    quitLaunchedSince: async (bundle, since, options) => mark(`quit ${bundle} pid ${options.pid} launched since ${typeof since}`),
    openSafariPage: async ({ onDiagnostics }) => { onDiagnostics({ pid: 41 }); throw new Error('Fixture setup failed'); },
    runCalculator: async (client, host) => {
      if (mode === 'browser') return { id: 'live-calculator', status: 'pass' };
      await host.launchApp('com.apple.calculator'); setInterval(() => {}, 1000); console.log('ready'); await new Promise(() => {});
    },
    runBrowserRead: async (client, host) => {
      await host.openPage().catch(() => {}); setInterval(() => {}, 1000); console.log('ready'); await new Promise(() => {});
    } } });
