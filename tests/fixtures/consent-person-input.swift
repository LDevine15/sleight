
func check(_ ok: Bool, _ what: String) { if !ok { print("FAIL " + what); exit(1) } }
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
final class Receipt: NSObject {
    var choices: [String] = []
    @objc func accept(_ sender: NSButton) { choices.append(sender.title) }
}
let receipt = Receipt()
// Detached AppKit controls defer AX activation until they are visible. This helper dispatches the AX action
// synchronously so the real runtime subclass and target guard can be tested without displaying a window.
final class AXFixtureButton: NSButton {
    override func accessibilityPerformPress() -> Bool { sendAction(action, to: target) }
    override func accessibilityPerformAction(_ action: NSAccessibility.Action) {
        if action == .press { _ = accessibilityPerformPress() }
    }
}
func button(_ title: String) -> NSButton { AXFixtureButton(title: title, target: receipt, action: #selector(Receipt.accept(_:))) }
func event(_ state: CGEventSourceStateID, _ pid: Int64 = 0, _ data: Int64 = 0, key: Bool = false) -> NSEvent {
    let source = CGEventSource(stateID: state)!
    let cg = key ? CGEvent(keyboardEventSource: source, virtualKey: 49, keyDown: true)!
        : CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: .zero, mouseButton: .left)!
    cg.setIntegerValueField(.eventSourceStateID, value: Int64(state.rawValue))
    cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid)
    cg.setIntegerValueField(.eventSourceUserData, value: data)
    cg.timestamp = DispatchTime.now().uptimeNanoseconds
    return NSEvent(cgEvent: cg)!
}
// No NSApplication run loop, windows, global AX calls or posted input. These are the actual button/action objects.
let always = button("Always allow")
var current: NSEvent?
let guarded = ConsentInputAction(always, currentEvent: { current })
check(!always.accessibilityPerformPress(), "AXPress refused")
check(receipt.choices.isEmpty, "AX writes no pre-approval receipt")
guarded.press(always)
check(receipt.choices.isEmpty, "no current event writes nothing")
for sample in [event(.combinedSessionState, Int64(getpid())), event(.privateState, Int64(getpid())),
    event(.hidSystemState, Int64(getpid())), event(.hidSystemState, 0, 9), event(.combinedSessionState, 0, key: true),
    event(.hidSystemState, Int64(getpid()), key: true)] {
    current = sample; guarded.press(always)
    check(receipt.choices.isEmpty, "posted input writes no pre-approval receipt")
}
// Even a leftover genuine event cannot turn AXPress into a person's click.
current = event(.hidSystemState)
check(personInput(current!.cgEvent), "HID metadata survives AppKit conversion")
check(ProcessInfo.processInfo.systemUptime - current!.timestamp < 1, "fresh HID timestamp")
check(!always.accessibilityPerformPress(), "AX refused with a current HID event")
always.accessibilityPerformAction(.press)
check(receipt.choices.isEmpty, "legacy AX refused even with current HID event")
let refused = receipt.choices
guarded.press(always)
check(receipt.choices == ["Always allow"], "HID click reaches original action exactly once")
current = event(.hidSystemState, 0, key: true); guarded.press(always)
check(receipt.choices.count == 2, "HID key reaches original action")
let session = button("Allow this session"), decline = button("Decline")
session.accessibilityPerformAction(.press)
decline.accessibilityPerformAction(.press)
check(receipt.choices.suffix(2) == ["Allow this session", "Decline"], "unprotected AX reaches original action")
for kind in ["debugger", "relaunch", "action", "opt-in", "resume", "turbo-off"] {
    for choice in ["always", "once", "relaunch", "enable", "resume", "turbo-off"] { check(personChoice(kind, choice), "protected consent") }
    for choice in ["session", "cancel", "decline"] { check(!personChoice(kind, choice), "host-answerable choice") }
}
check(personChoice("app", "always") && !personChoice("app", "once"), "ordinary app approval scope")
check(!personInput(nil), "missing CGEvent")
let old = event(.hidSystemState).cgEvent!
old.timestamp = 1
current = NSEvent(cgEvent: old); guarded.press(always)
check(receipt.choices.count == 4, "old hardware event is refused")
// Exercise installation on NSAlert's actual buttons too, without running or displaying the alert.
let alert = NSAlert()
for label in ["Allow once", "Allow this session", "Always allow", "Cancel"] { alert.addButton(withTitle: label) }
let actions = consentInputActions(alert, choices: ["once", "session", "always", "cancel"], kind: "debugger")
let sessionTarget = alert.buttons[1].target, sessionAction = alert.buttons[1].action
let cancelTarget = alert.buttons[3].target, cancelAction = alert.buttons[3].action
check(actions.count == 2 && actions.allSatisfy { $0.originalAction != nil }, "real alert modal actions wrapped")
alert.layout()
check(alert.buttons[1].target === sessionTarget && alert.buttons[1].action == sessionAction, "session action unchanged")
check(alert.buttons[3].target === cancelTarget && alert.buttons[3].action == cancelAction, "cancel action unchanged")
check(alert.buttons[2].target === actions[1], "layout retains the guarded target")
check(!alert.buttons[2].accessibilityPerformPress(), "real alert AXPress refused")
alert.buttons[2].accessibilityPerformAction(.press)
_ = alert.buttons[2].sendAction(alert.buttons[2].action, to: alert.buttons[2].target)
check(!alert.window.isVisible, "fixture never opens a window")
let result: [String: Any] = ["refused": refused, "accepted": receipt.choices]
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
