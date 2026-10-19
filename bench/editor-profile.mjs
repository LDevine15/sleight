// Launch flags and settings for an editor (VS Code family) running on a throwaway profile, so a benchmark never
// touches the owner's editor state: no workspace trust prompt, extensions, restored windows or recent-folder entries.
export const EDITOR_FLAGS = ['--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry',
  '--disable-updates', '--disable-crash-reporter', '--skip-add-to-recently-opened', '--new-window'];
export const EDITOR_SETTINGS = { 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none', 'security.workspace.trust.enabled': false, 'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': false, 'workbench.enableExperiments': false, 'workbench.tips.enabled': false };
