import { userInfo } from 'node:os';
import { join } from 'node:path';

// Fixed metadata, in automatic preference order. Only qualified entries are startup candidates.
// team is the Apple-issued Developer ID Team ID the browser is signed with (executable-trust.mjs). It is set only where
// it was read from an installed copy: Google LLC from Chrome's designated requirement, which names all four channels,
// and imput LLC from Helium's (codesign -d -r-, 2026-10-17).
const browsers = [
  { id: 'chrome', name: 'Google Chrome', bundleId: 'com.google.Chrome', team: 'EQHXZ8M8AV', profile: 'Google/Chrome', scheme: 'chrome', qualified: true },
  { id: 'helium', name: 'Helium', bundleId: 'net.imput.helium', team: 'S4Q33XPHB4', profile: 'net.imput.helium', scheme: 'chrome', qualified: true },
  { id: 'chrome-beta', name: 'Google Chrome Beta', bundleId: 'com.google.Chrome.beta', team: 'EQHXZ8M8AV', profile: 'Google/Chrome Beta', scheme: 'chrome', qualified: false },
  { id: 'chrome-dev', name: 'Google Chrome Dev', bundleId: 'com.google.Chrome.dev', team: 'EQHXZ8M8AV', profile: 'Google/Chrome Dev', scheme: 'chrome', qualified: false },
  { id: 'chrome-canary', name: 'Google Chrome Canary', bundleId: 'com.google.Chrome.canary', team: 'EQHXZ8M8AV', profile: 'Google/Chrome Canary', scheme: 'chrome', qualified: false },
  { id: 'chromium', name: 'Chromium', bundleId: 'org.chromium.Chromium', profile: 'Chromium', scheme: 'chrome', qualified: false },
  { id: 'brave', name: 'Brave Browser', bundleId: 'com.brave.Browser', profile: 'BraveSoftware/Brave-Browser', scheme: 'brave', qualified: false },
  { id: 'edge', name: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac', profile: 'Microsoft Edge', scheme: 'edge', qualified: false },
  { id: 'vivaldi', name: 'Vivaldi', bundleId: 'com.vivaldi.Vivaldi', profile: 'Vivaldi', scheme: 'vivaldi', qualified: false },
];

// Tests supply private temporary locations; constructing the table never inspects an app or profile.
export const browserDefinitions = (home = userInfo().homedir, apps = '/Applications') => browsers.map(({ profile, scheme, ...browser }) => ({
  ...browser, executable: join(apps, `${browser.name}.app/Contents/MacOS/${browser.name}`),
  profileRoot: join(home, 'Library/Application Support', profile), inspectURL: `${scheme}://inspect/#remote-debugging`,
}));

export const browserChoices = () => browsers.map(browser => browser.id).join('|');
export const qualifiedBrowserNames = () => browsers.filter(browser => browser.qualified).map(browser => browser.name).join(' or ');
export const browserBundleId = name => browsers.find(browser => browser.name === name)?.bundleId;
export const browserApplicationName = executable => {
  const name = typeof executable === 'string' ? /\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1] : undefined;
  return browsers.find(browser => browser.name === name)?.name;
};
