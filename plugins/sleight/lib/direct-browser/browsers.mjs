import { userInfo } from 'node:os';
import { join } from 'node:path';

// Fixed metadata, in automatic preference order. Only qualified entries are startup candidates.
const browsers = [
  { id: 'chrome', name: 'Google Chrome', bundleId: 'com.google.Chrome', profile: 'Google/Chrome', scheme: 'chrome', qualified: true },
  { id: 'helium', name: 'Helium', bundleId: 'net.imput.helium', profile: 'net.imput.helium', scheme: 'chrome', qualified: true },
  { id: 'chrome-beta', name: 'Google Chrome Beta', bundleId: 'com.google.Chrome.beta', profile: 'Google/Chrome Beta', scheme: 'chrome', qualified: false },
  { id: 'chrome-dev', name: 'Google Chrome Dev', bundleId: 'com.google.Chrome.dev', profile: 'Google/Chrome Dev', scheme: 'chrome', qualified: false },
  { id: 'chrome-canary', name: 'Google Chrome Canary', bundleId: 'com.google.Chrome.canary', profile: 'Google/Chrome Canary', scheme: 'chrome', qualified: false },
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
export const browserApplicationName = executable => {
  const name = typeof executable === 'string' ? /\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1] : undefined;
  return browsers.find(browser => browser.name === name)?.name;
};
