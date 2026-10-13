ObjC.import('AppKit');
function run(argv) {
  const ws = $.NSWorkspace.sharedWorkspace, name = argv[0];
  let url = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(name) ? ws.URLForApplicationWithBundleIdentifier(name) : undefined;
  if (!url || url.isNil()) { const path = ws.fullPathForApplication(name); if (!path.isNil()) url = $.NSURL.fileURLWithPath(path); }
  if (!url || url.isNil()) return '';
  const bundle = $.NSBundle.bundleWithURL(url);
  return bundle.isNil() || bundle.bundleIdentifier.isNil() ? '' : ObjC.unwrap(bundle.bundleIdentifier);
}
