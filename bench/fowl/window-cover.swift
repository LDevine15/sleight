import AppKit

// Records which windows cover the benchmark browser's window at a task's start (bench/fowl/window-cover.mjs). The engine's
// background drags miss in a covered window (docs/known-problems.md), and in 2026-10-18's Safari round the race's Terminal
// window sat over the settings list. It never activates an app, raises a window, posts an event or moves the pointer. With
// `place` it moves the benchmark's own browser window (AXPosition, size kept) to the display where the fewest other windows
// would overlap it, when that is less than where it is; AXRaise can't lift a background app's window over another app's.
//
//   window-cover <pid>          the pid's largest on-screen window and the other apps' windows in front of it that overlap it
//   window-cover <pid> place    the same before and after the move, plus "moved"
// Output is one JSON line. Failures are {"ok":false,"error":CODE}.

func fail(_ code: String) -> Never {
    print("{\"ok\":false,\"error\":\"\(code)\"}")
    exit(0)
}

struct Window { let id: Int; let pid: Int32; let owner: String; let layer: Int; let bounds: CGRect }

// Front to back, normal and floating layers only (the menu bar, Dock and other system layers sit at 20 and above).
func onScreen() -> [Window] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { fail("window-list") }
    return list.compactMap { info in
        guard let id = info[kCGWindowNumber as String] as? Int, let pid = info[kCGWindowOwnerPID as String] as? Int32,
              let layer = info[kCGWindowLayer as String] as? Int, layer >= 0, layer < 20,
              let raw = info[kCGWindowBounds as String] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw),
              (info[kCGWindowAlpha as String] as? Double ?? 1) > 0, bounds.width > 1, bounds.height > 1 else { return nil }
        return Window(id: id, pid: pid, owner: info[kCGWindowOwnerName as String] as? String ?? "", layer: layer, bounds: bounds)
    }
}

let args = CommandLine.arguments
guard args.count == 2 || (args.count == 3 && args[2] == "place"), let pid = Int32(args[1]), pid > 0 else { fail("usage") }

func target(_ windows: [Window]) -> Window {
    guard let found = windows.filter({ $0.pid == pid && $0.layer == 0 }).max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else { fail("no-window") }
    return found
}
func cover(_ windows: [Window], _ target: Window) -> [[String: Any]] {
    let area = target.bounds.width * target.bounds.height
    var covering: [[String: Any]] = []
    for window in windows {
        if window.id == target.id { break }
        if window.pid == pid { continue }
        let overlap = window.bounds.intersection(target.bounds)
        if overlap.isNull || overlap.width * overlap.height < 1 { continue }
        covering.append(["owner": window.owner, "layer": window.layer, "fraction": (overlap.width * overlap.height / area * 1000).rounded() / 1000])
    }
    return covering
}
func frame(_ rect: CGRect) -> [String: Any] { ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height] }
// Area of other apps' windows over a rect, whatever their stacking: a window behind now may come forward later.
func overlapArea(_ windows: [Window], _ rect: CGRect) -> CGFloat {
    windows.filter { $0.pid != pid }.reduce(0) { sum, window in
        let overlap = window.bounds.intersection(rect)
        return overlap.isNull ? sum : sum + overlap.width * overlap.height
    }
}
func emit(_ value: [String: Any]) -> Never {
    var out = value
    out["ok"] = true
    guard let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) else { fail("encode") }
    print(line)
    exit(0)
}

let windows = onScreen()
let before = target(windows)
let result: [String: Any] = ["frame": frame(before.bounds), "covering": cover(windows, before)]
if args.count == 2 { emit(result) }

// Screens in the window list's coordinates (origin at the top left of the main display).
let mainHeight = NSScreen.screens.first?.frame.height ?? 0
var best = before.bounds, bestArea = overlapArea(windows, before.bounds)
for screen in NSScreen.screens {
    let visible = screen.visibleFrame
    let top = CGRect(x: visible.minX, y: mainHeight - visible.maxY, width: visible.width, height: visible.height)
    guard before.bounds.width <= top.width - 40, before.bounds.height <= top.height - 40 else { continue }
    // Positions 80 points apart across the display, 20 points in from its edges.
    for x in stride(from: top.minX + 20, through: top.maxX - 20 - before.bounds.width, by: 80) {
        for y in stride(from: top.minY + 20, through: top.maxY - 20 - before.bounds.height, by: 80) {
            let candidate = CGRect(x: x, y: y, width: before.bounds.width, height: before.bounds.height)
            let area = overlapArea(windows, candidate)
            if area < bestArea - 1 { best = candidate; bestArea = area }
        }
    }
}
if abs(best.minX - before.bounds.minX) < 1 && abs(best.minY - before.bounds.minY) < 1 { emit(result.merging(["moved": false]) { $1 }) }
var value: CFTypeRef?
guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &value) == .success,
      let axWindows = value as? [AXUIElement] else { fail("ax-windows") }
let match = axWindows.first { window in
    var p: CFTypeRef?, s: CFTypeRef?, position = CGPoint.zero, size = CGSize.zero
    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &p) == .success,
          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &s) == .success else { return false }
    AXValueGetValue(p as! AXValue, .cgPoint, &position)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return abs(position.x - before.bounds.minX) < 2 && abs(position.y - before.bounds.minY) < 2 && abs(size.width - before.bounds.width) < 2 && abs(size.height - before.bounds.height) < 2
}
guard let window = match else { fail("ax-window") }
var origin = best.origin
guard let position = AXValueCreate(.cgPoint, &origin), AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position) == .success else { fail("move") }
RunLoop.current.run(until: Date().addingTimeInterval(0.3))
let after = onScreen()
let moved = target(after)
emit(["frame": frame(moved.bounds), "covering": cover(after, moved), "moved": true, "from": result])
