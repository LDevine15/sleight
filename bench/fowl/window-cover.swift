import AppKit

// Records which windows cover the benchmark browser's window at a task's start (bench/fowl/window-cover.mjs). The engine's
// background drags miss in a covered window (docs/known-problems.md), and in 2026-10-18's Safari round the race's Terminal
// window sat over the settings list. It reads the window list only: it never activates an app, raises or moves a window,
// posts an event or moves the pointer.
//
//   window-cover <pid>    the pid's largest on-screen window and the other apps' windows in front of it that overlap it
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
guard args.count == 2, let pid = Int32(args[1]), pid > 0 else { fail("usage") }
let windows = onScreen()
guard let target = windows.filter({ $0.pid == pid && $0.layer == 0 }).max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else { fail("no-window") }
let area = target.bounds.width * target.bounds.height
var covering: [[String: Any]] = []
for window in windows {
    if window.id == target.id { break }
    if window.pid == pid { continue }
    let overlap = window.bounds.intersection(target.bounds)
    if overlap.isNull || overlap.width * overlap.height < 1 { continue }
    covering.append(["owner": window.owner, "layer": window.layer, "fraction": (overlap.width * overlap.height / area * 1000).rounded() / 1000])
}
let frame: [String: Any] = ["x": target.bounds.minX, "y": target.bounds.minY, "width": target.bounds.width, "height": target.bounds.height]
guard let data = try? JSONSerialization.data(withJSONObject: ["ok": true, "frame": frame, "covering": covering], options: [.sortedKeys]),
      let line = String(data: data, encoding: .utf8) else { fail("encode") }
print(line)
