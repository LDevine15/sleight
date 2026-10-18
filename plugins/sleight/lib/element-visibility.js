// Whether a list row Claude clicked lies inside the list's visible frame, for offscreen-click.mjs.
// Read-only, through the AX C API with a short deadline: role descriptions, AXTitle and AXDescription
// (names Claude already saw in the tree) and geometry. It never reads AXValue or other content.
//
//   request: { app, title, container, lines, index }
//   container is the list's line as shown, lines its descendants' lines, index the clicked row among them.
//   reply: { status: 'ok', inside, direction?, pages? } or { status: 'unknown' | 'denied', reason? }
ObjC.import('AppKit');
ObjC.import('ApplicationServices');

const VISIT_LIMIT = 4000, TIME_LIMIT_MS = 600;
// JXA's Ref('CGPoint') reads back as the number 0 (macOS 27.0.1, 2026-10-16): copy the struct and read it through NSValue.
function axPair(value, type) {
  const bytes = $.NSMutableData.dataWithLength(16);
  if (!$.AXValueGetValue(value, type, bytes.mutableBytes)) return null;
  const boxed = $.NSValue.valueWithBytesObjCType(bytes.bytes, type === 1 ? '{CGPoint=dd}' : '{CGSize=dd}');
  const s = ObjC.deepUnwrap(type === 1 ? boxed.pointValue : boxed.sizeValue);
  return type === 1 ? [s.x, s.y] : [s.width, s.height];
}
function attr(element, name) {
  const value = Ref();
  return Number($.AXUIElementCopyAttributeValue(element, $(name), value)) === 0 ? ObjC.castRefToObject(value[0]) : null;
}
const text = (element, name) => { const value = attr(element, name); const s = value === null ? null : ObjC.unwrap(value); return typeof s === 'string' ? s : null; };
function children(element) {
  const list = attr(element, 'AXChildren');
  return list ? Array.from({ length: Math.min(Number(list.count), 512) }, (_, i) => list.objectAtIndex(i)) : [];
}
function frame(element) {
  const position = attr(element, 'AXPosition'), size = attr(element, 'AXSize');
  const p = position && axPair(position, 1), s = size && axPair(size, 2);
  if (!p || !s || ![...p, ...s].every(Number.isFinite) || s[0] <= 0 || s[1] <= 0) return null;
  return { x: p[0], y: p[1], width: s[0], height: s[1] };
}
// A shown line's name: the text after the role and its flags, up to the first named attribute.
function shownName(body, role) {
  const rest = body.slice(role.length).trim().replace(/^(?:\([^()]*\)\s*)+/, '');
  const description = /(?:^|, )Description: (.*?)(?=, (?:Value|ID|Help|Secondary Actions|URL|Details): |$)/.exec(rest)?.[1];
  return { name: rest.split(/(?:^|, )(?:Description|Value|ID|Help|Secondary Actions|URL|Details): /)[0].trim(), description };
}
const roleOf = (body, roles) => roles.filter(role => body === role || body.startsWith(role + ' ')).sort((a, b) => b.length - a.length)[0];

function runningApp(selector) {
  const byId = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(selector);
  if (Number(byId.count) === 1) return byId.objectAtIndex(0);
  const apps = $.NSWorkspace.sharedWorkspace.runningApplications, named = [];
  for (let i = 0; i < Number(apps.count); i++) {
    const name = ObjC.unwrap(apps.objectAtIndex(i).localizedName);
    if (typeof name === 'string' && name.toLowerCase() === selector.toLowerCase()) named.push(apps.objectAtIndex(i));
  }
  return named.length === 1 ? named[0] : null;
}

function visibility(request, now = () => Date.now()) {
  const unknown = reason => ({ status: 'unknown', reason });
  if (typeof request?.app !== 'string' || typeof request.title !== 'string' || typeof request.container !== 'string' ||
      !Array.isArray(request.lines) || !Number.isSafeInteger(request.index) || request.index < 0 || request.index >= request.lines.length) return unknown('request');
  const running = runningApp(request.app);
  if (!running) return unknown('app');
  const app = $.AXUIElementCreateApplication(Number(running.processIdentifier));
  if (Number($.AXUIElementSetMessagingTimeout(app, 0.25)) !== 0) return unknown('deadline');
  const windows = attr(app, 'AXWindows');
  const matching = (windows ? Array.from({ length: Math.min(Number(windows.count), 64) }, (_, i) => windows.objectAtIndex(i)) : [])
    .filter(window => text(window, 'AXTitle') === request.title);
  if (matching.length !== 1) return unknown('window');
  const started = now();
  let visited = 0, containers = [];
  // The one element whose role description and name match the container's shown line.
  (function walk(element, depth) {
    if (depth > 64 || ++visited > VISIT_LIMIT || now() - started > TIME_LIMIT_MS) throw new Error('scan limit');
    const role = text(element, 'AXRoleDescription');
    if (role && roleOf(request.container, [role])) {
      const { name, description } = shownName(request.container, role);
      const title = text(element, 'AXTitle'), axDescription = text(element, 'AXDescription');
      if ((name && (title === name || axDescription === name)) || (description && axDescription === description)) containers.push(element);
    }
    for (const child of children(element)) walk(child, depth + 1);
  })(matching[0], 0);
  if (containers.length !== 1) return unknown('container');
  // Rows by role, in tree order: the clicked row is the nth shown line of its role, and the AX subtree must
  // hold exactly as many elements with that role description, or the mapping is unsure.
  const rows = [];
  (function walk(element, depth) {
    if (depth > 32 || ++visited > VISIT_LIMIT || now() - started > TIME_LIMIT_MS) throw new Error('scan limit');
    for (const child of children(element)) { rows.push({ element: child, role: text(child, 'AXRoleDescription') }); walk(child, depth + 1); }
  })(containers[0], 0);
  const roles = [...new Set(rows.map(row => row.role).filter(Boolean))];
  const role = roleOf(request.lines[request.index], roles);
  if (!role) return unknown('role');
  const shown = request.lines.filter(line => roleOf(line, roles) === role).length;
  const same = rows.filter(row => row.role === role);
  if (same.length !== shown) return unknown('rows');
  const nth = request.lines.slice(0, request.index).filter(line => roleOf(line, roles) === role).length;
  const box = frame(containers[0]), row = frame(same[nth].element);
  if (!box || !row) return unknown('geometry');
  const x = row.x + row.width / 2, y = row.y + row.height / 2;
  if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) return { status: 'ok', inside: true };
  const [direction, overflow, span] = y >= box.y + box.height ? ['down', row.y + row.height - (box.y + box.height), box.height]
    : y < box.y ? ['up', box.y - row.y, box.height]
    : x >= box.x + box.width ? ['right', row.x + row.width - (box.x + box.width), box.width] : ['left', box.x - row.x, box.width];
  return { status: 'ok', inside: false, direction, pages: Math.max(1, Math.ceil(overflow / span)) };
}

function run(argv) {
  try {
    if (!$.AXIsProcessTrusted()) return JSON.stringify({ status: 'denied' });
    return JSON.stringify(visibility(JSON.parse(argv[0])));
  } catch (error) {
    return JSON.stringify({ status: 'unknown', reason: String(error?.message ?? error).slice(0, 80) });
  }
}
