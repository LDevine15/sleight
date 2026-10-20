import { homedir, userInfo } from 'node:os';

const CI_USERS = new Set(['runner', 'root', 'gitlab-runner', 'buildkite-agent', 'circleci', 'travis',
  'jenkins', 'codespace', 'gitpod', 'vsts', 'github-actions', 'builduser']);

export function privateIdentity() {
  return { home: homedir(), username: userInfo().username };
}

export function privateMatches(text, { home, username } = privateIdentity()) {
  const matches = [];
  if (home && text.includes(home)) matches.push('home path');
  if (username?.length >= 4 && !CI_USERS.has(username.toLowerCase()) && text.includes(username)) matches.push('username');
  return matches;
}

export function privateTrackedPath(path) {
  if (path.startsWith('race-1017/')) return 'private evidence directory';
  if (!path.includes('/') && path.endsWith('-REPORT.md')) return 'root lane report';
  return null;
}
