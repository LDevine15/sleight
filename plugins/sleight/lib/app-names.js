// The names macOS gives the app with this bundle id: its file name without .app, then CFBundleDisplayName and CFBundleName.
// Read-only: LaunchServices finds the bundle and its Info.plist is read; no app is opened. Blocks by bundle id store them.
//
//   osascript -l JavaScript app-names.js <bundle id>   prints ["Name", …], or [] when no app has that id

ObjC.import('AppKit');

function run(argv) {
  try {
    const url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]);
    if (!url || url.isNil()) return '[]';
    const names = [ObjC.unwrap(url.lastPathComponent).replace(/\.app$/i, '')];
    const bundle = $.NSBundle.bundleWithURL(url);
    if (!bundle.isNil()) for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
      const value = ObjC.unwrap(bundle.objectForInfoDictionaryKey(key));
      if (typeof value === 'string') names.push(value);
    }
    return JSON.stringify(names.filter(name => typeof name === 'string' && name));
  } catch (e) {
    return '[]';
  }
}
