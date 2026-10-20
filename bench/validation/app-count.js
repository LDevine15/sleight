// VS Code's bundle identifies its instances even when its executable has another name.
// Finder normally stays running, so count its AX windows, including minimized windows.
// These reads never launch apps, read titles or contents, send Apple events or request permission.
ObjC.import('AppKit');
ObjC.import('ApplicationServices');

function run(args) {
  if (args && args[0] === 'vscode')
    return String(Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.microsoft.VSCode').count));
  if (args && args.length) throw new Error('Unknown app inspection');
  if (!$.AXIsProcessTrusted()) throw new Error('Finder window inspection needs existing Accessibility permission');
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder');
  var count = 0;
  for (var i = 0; i < Number(apps.count); i++) {
    var app = $.AXUIElementCreateApplication(Number(apps.objectAtIndex(i).processIdentifier));
    $.AXUIElementSetMessagingTimeout(app, 1);
    var value = Ref();
    var code = Number($.AXUIElementCopyAttributeValue(app, $('AXWindows'), value));
    if (code !== 0) throw new Error('Finder window inspection failed: ' + code);
    var windows = ObjC.castRefToObject(value[0]);
    if (!windows || (windows.isNil && windows.isNil())) throw new Error('Finder window count unavailable');
    count += Number(windows.count);
  }
  return String(count);
}
