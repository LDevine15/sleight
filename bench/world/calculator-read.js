// Read one current input field from the exact fixture process. Never launch or focus an app.
function readCalculatorField(api, request) {
  if (!api.trusted()) throw new Error('Calculator AX permission unavailable');
  const apps = api.apps('com.apple.calculator');
  if (!Number.isSafeInteger(request.pid) || request.pid <= 0 || apps.length !== 1 || apps[0].pid !== request.pid ||
    !Number.isFinite(apps[0].start) || apps[0].start <= 0 || (request.start !== undefined && apps[0].start !== request.start)) {
    throw new Error('Calculator fixture process absent or changed');
  }
  // Since engine 26.1013 a driven app can carry an extra non-standard window beside its own; a modal one is still a dialog.
  const all = api.windows(apps[0].element), subrole = element => api.subrole?.(element);
  if (all.some(item => api.modal?.(item))) throw new Error('Calculator dialog present');
  const windows = all.length === 1 ? all : all.filter(item => subrole(item) === 'AXStandardWindow');
  if (windows.length !== 1) throw new Error('Calculator window absent or ambiguous');
  const window = windows[0];
  if (api.role(window) !== 'AXWindow' || api.sheets(window).length || api.modal?.(window)) throw new Error('Calculator dialog present');
  const stack = [window], visited = [], values = [], modes = [];
  while (stack.length) {
    const node = stack.pop();
    if (visited.some(prior => api.same(prior, node))) throw new Error('Calculator AX cycle');
    if (visited.length >= 2048) throw new Error('Calculator AX tree limit');
    visited.push(node);
    if (api.hidden(node)) continue;
    if (api.description(node) === 'Edit field') {
      const value = api.value(node);
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Calculator input field unavailable');
      if (/[\r\n]/.test(String(value))) throw new Error('Calculator input field malformed');
      values.push(String(value));
    }
    const mode = /^Mode: ([a-z]+);/.exec(api.identifier(node) ?? '');
    if (mode) modes.push(mode[1]);
    stack.push(...api.children(node));
  }
  if (values.length !== 1) throw new Error('Calculator input field absent or ambiguous');
  return { pid: apps[0].pid, start: apps[0].start, value: values[0], mode: modes.length === 1 ? modes[0] : null };
}

if (typeof module !== 'undefined') module.exports = { readCalculatorField };
else {
  ObjC.import('AppKit');
  ObjC.import('ApplicationServices');
}
function nativeAPI() {
  const attr = (element, name, optional = false) => {
    const result = Ref(), error = Number($.AXUIElementCopyAttributeValue(element, $(name), result));
    if (error === 0) return ObjC.castRefToObject(result[0]);
    if (optional && (error === -25205 || error === -25212)) return null;
    throw new Error(name + ': AX error ' + error);
  };
  const scalar = value => value === null ? null : ObjC.deepUnwrap(value);
  const array = value => { const result = []; for (let i = 0; i < Number(value?.count ?? 0); i++) result.push(value.objectAtIndex(i)); return result; };
  return {
    trusted: () => Boolean($.AXIsProcessTrusted()),
    apps: bundle => array($.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle)).map(running => {
      const pid = Number(running.processIdentifier), element = $.AXUIElementCreateApplication(pid);
      if (Number($.AXUIElementSetMessagingTimeout(element, 0.5)) !== 0) throw new Error('Calculator AX deadline unavailable');
      return { pid, start: Number(running.launchDate.timeIntervalSince1970), element };
    }),
    windows: element => array(attr(element, 'AXWindows')), sheets: element => array(attr(element, 'AXSheets', true)),
    role: element => scalar(attr(element, 'AXRole')), value: element => scalar(attr(element, 'AXValue')),
    description: element => scalar(attr(element, 'AXDescription', true)), identifier: element => scalar(attr(element, 'AXIdentifier', true)),
    hidden: element => scalar(attr(element, 'AXHidden', true)) === true,
    modal: element => scalar(attr(element, 'AXModal', true)) === true,
    subrole: element => scalar(attr(element, 'AXSubrole', true)),
    children: element => array(attr(element, 'AXChildren', true)), same: (a, b) => Boolean($.CFEqual(a, b)),
  };
}
function run(argv) { return JSON.stringify(readCalculatorField(nativeAPI(), JSON.parse(argv[0]))); }
