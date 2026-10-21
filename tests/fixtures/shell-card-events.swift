// Event encoding only, using nonexistent positive IDs and no AppKit windows.
// No local receiver transform, activation, posting, Accessibility or run loop.
typealias WindowLocationGetter = @convention(c) (CGEvent) -> CGPoint
guard let framework = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW | RTLD_LOCAL),
    let symbol = dlsym(framework, "CGEventGetWindowLocation") else {
    print("WINDOW_LOCATION_GETTER_UNAVAILABLE"); exit(1)
}
let windowLocation = unsafeBitCast(symbol, to: WindowLocationGetter.self)
var records: [[String: Any]] = []
for mode in ["pid", "hid"] {
    guard let source = CGEventSource(stateID: mode == "hid" ? .hidSystemState : .privateState) else {
        print("EVENT_SOURCE_UNAVAILABLE"); exit(1)
    }
    source.userData = 0
    for (window, rect, point) in [
        (UInt32(2147483001), CGRect(x: 556, y: 318, width: 400, height: 199), CGPoint(x: 866, y: 447)),
        (UInt32(2147483002), CGRect(x: -900, y: -200, width: 400, height: 199), CGPoint(x: -590, y: -71))
    ] {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            guard let event = shellMouseEvent(type: type, source: source, mode: mode, window: window, rect: rect, point: point),
                let original = NSEvent(cgEvent: event),
                let data = event.data, let restored = CGEvent(withDataAllocator: nil, data: data), let ns = NSEvent(cgEvent: restored) else {
                print("EVENT_ROUND_TRIP_FAILED"); exit(1)
            }
            records.append(["mode": mode, "window": ns.windowNumber, "expectedWindow": window,
                "windowLocal": [windowLocation(restored).x, windowLocation(restored).y],
                "originalWindowLocal": [windowLocation(event).x, windowLocation(event).y],
                "cocoaLocalFromAnnotation": [windowLocation(restored).x, rect.height - windowLocation(restored).y],
                "originalCocoaLocalFromAnnotation": [windowLocation(event).x, rect.height - windowLocation(event).y],
                "originalWindow": original.windowNumber,
                "originalGlobal": [event.location.x, event.location.y],
                "clickCount": ns.clickCount,
                "global": [restored.location.x, restored.location.y],
                "expectedGlobal": [point.x, point.y], "type": restored.type.rawValue,
                "eventNumber": ns.eventNumber, "flags": ns.modifierFlags.rawValue,
                "sourceState": restored.getIntegerValueField(.eventSourceStateID), "expectedState": source.sourceStateID.rawValue,
                "originalState": event.getIntegerValueField(.eventSourceStateID),
                "originalPid": event.getIntegerValueField(.eventSourceUnixProcessID),
                "originalUserData": event.getIntegerValueField(.eventSourceUserData),
                "sourcePid": restored.getIntegerValueField(.eventSourceUnixProcessID), "expectedPid": mode == "hid" ? 0 : Int64(getpid()),
                "userData": restored.getIntegerValueField(.eventSourceUserData)])
        }
    }
}
print(String(data: try! JSONSerialization.data(withJSONObject: records), encoding: .utf8)!)
