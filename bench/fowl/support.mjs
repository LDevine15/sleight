// Shared by the patched runner and admission. Unsupported tasks remain in the
// runner's input so it can write their not-supported rows without agent setup.
const BROWSER_ARMS = ['playwright-mcp', 'chrome-devtools-mcp', 'claude-in-chrome', 'claude-cu', 'browser-use'];
export const REAL_BROWSER_ARMS = ['sleight-turbo', 'sleight', 'lcu', 'cua', 'peekaboo', 'codex', 'fowlbrowser', 'claude-in-chrome'];
export function taskSupport(task, surface, { world = false, remote = null, realBrowser } = {}) {
  if (realBrowser) {
    if (remote) return 'Real browser gate is local only';
    if (!REAL_BROWSER_ARMS.includes(surface)) return `Real browser gate uses ${REAL_BROWSER_ARMS.join(', ')}`;
    if (!['chrome', 'helium', 'firefox', 'safari'].includes(task.browser)) return 'Real browser gate supports browser tasks only';
    if (surface === 'claude-in-chrome' && realBrowser !== 'chrome') return 'Claude in Chrome runs in Chrome only';
    if (surface === 'fowlbrowser' && !['chrome', 'helium'].includes(realBrowser)) return 'FowlBrowser runs in Chrome or Helium only';
    if (realBrowser === 'safari') {
      if (surface === 'sleight-turbo') return 'Safari has no turbo surface; use sleight on the engine computer surface';
      if (task.viewport) return 'Safari computer arms have no qualified device viewport and restoration path';
      if (task.downloads) return 'Safari AX tab inventory cannot observe completed downloads';
      if (task.takeover) return 'Takeover requires the separate user-takeover test protocol';
      return null;
    }
    if (realBrowser === 'firefox' && surface === 'sleight-turbo') return 'Firefox has no turbo surface; use sleight on the engine computer surface';
    if (realBrowser !== 'firefox' && surface === 'sleight') return 'Use sleight-turbo for Chrome/Helium real-browser gates';
    if (realBrowser === 'firefox' && task.viewport) return 'Firefox computer arms have no qualified device viewport and restoration path';
    if (realBrowser === 'firefox' && task.downloads) return 'Firefox sessionstore cannot observe completed downloads';
    if (realBrowser === 'firefox' && task.takeover) return 'Takeover requires the separate user-takeover test protocol';
    return null;
  }
  if (['lcu', 'cua', 'peekaboo'].includes(surface)) return 'Native browser arms require --real-browser';
  if (surface === 'sleight-turbo' && remote) return 'Turbo bench is local only';
  if (world && surface === 'codex-agent') return 'codex-agent does not run Claude Code';
  if (world && remote) return 'Isolated world arms do not support remote configuration';
  if (BROWSER_ARMS.includes(surface) && remote) return 'This browser arm does not support remote configuration';
  if (BROWSER_ARMS.includes(surface) && !['chrome', 'helium'].includes(task.browser)) return 'This arm supports browser tasks only';
  if (surface === 'claude-in-chrome' && task.browser !== 'chrome') return 'Claude in Chrome requires the benchmark Chrome device';
  return null;
}
export const runnableTasks = (tasks, options) => tasks.filter(task => !taskSupport(task, task.surface, options));
