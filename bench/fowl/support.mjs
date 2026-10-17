// Shared by the patched runner and admission. Unsupported tasks remain in the
// runner's input so it can write their not-supported rows without agent setup.
const BROWSER_ARMS = ['playwright-mcp', 'chrome-devtools-mcp', 'claude-in-chrome', 'claude-cu', 'browser-use'];
export const REAL_BROWSER_ARMS = ['sleight-turbo', 'lcu', 'cua', 'peekaboo', 'codex'];
export function taskSupport(task, surface, { world = false, remote = null, realBrowser } = {}) {
  if (realBrowser) {
    if (remote) return 'Real browser gate is local only';
    if (!REAL_BROWSER_ARMS.includes(surface)) return 'Real browser gate uses sleight-turbo, lcu, cua, peekaboo or codex';
    if (!['chrome', 'helium'].includes(task.browser)) return 'Real browser gate supports browser tasks only';
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
