// Shared by the patched runner and admission. Unsupported tasks remain in the
// runner's input so it can write their not-supported rows without agent setup.
const BROWSER_ARMS = ['playwright-mcp', 'chrome-devtools-mcp', 'claude-in-chrome', 'claude-cu', 'browser-use'];
export const REAL_BROWSER_ARMS = ['sleight-turbo', 'sleight', 'lcu', 'cua', 'peekaboo', 'codex'];
export function taskSupport(task, surface, { world = false, remote = null, realBrowser } = {}) {
  if (realBrowser) {
    if (remote) return 'Real browser gate is local only';
    if (!REAL_BROWSER_ARMS.includes(surface)) return 'Real browser gate uses sleight-turbo, sleight, lcu, cua, peekaboo or codex';
    if (!['chrome', 'helium', 'firefox'].includes(task.browser)) return 'Real browser gate supports browser tasks only';
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
