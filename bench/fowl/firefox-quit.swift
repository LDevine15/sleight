import AppKit
import Darwin

// LaunchServices parents the harness Firefox to launchd, so ownership is the exact
// "-profile <root>" argv pair plus the start second recorded at launch. Check both
// before asking AppKit to quit that one process.
guard CommandLine.arguments.count == 5,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let started = Int(CommandLine.arguments[4]), started > 0 else { exit(1) }
let executable = CommandLine.arguments[2], profile = CommandLine.arguments[3]
func refuse(_ code: String) -> Never { fputs(code + "\n", stderr); exit(1) }

var info = kinfo_proc()
var size = MemoryLayout<kinfo_proc>.stride
var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0,
      size == MemoryLayout<kinfo_proc>.stride,
      info.kp_proc.p_un.__p_starttime.tv_sec == started else { refuse("BENCH_FIREFOX_QUIT_START_MISMATCH") }

func arguments(_ pid: Int32) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var length = 0
    guard sysctl(&mib, 3, nil, &length, nil, 0) == 0, length > 4 else { return nil }
    var bytes = [UInt8](repeating: 0, count: length)
    guard sysctl(&mib, 3, &bytes, &length, nil, 0) == 0, length > 4 else { return nil }
    let argc = Int(bytes.withUnsafeBytes { $0.load(as: Int32.self) })
    var index = 4
    while index < length && bytes[index] != 0 { index += 1 }  // exec path
    while index < length && bytes[index] == 0 { index += 1 }  // padding
    var result: [String] = []
    while result.count < argc && index < length {
        let start = index
        while index < length && bytes[index] != 0 { index += 1 }
        result.append(String(decoding: bytes[start..<index], as: UTF8.self))
        index += 1
    }
    return result.count == argc ? result : nil
}
guard let argv = arguments(pid),
      argv.indices.dropLast().contains(where: { argv[$0] == "-profile" && argv[$0 + 1] == profile }) else {
    refuse("BENCH_FIREFOX_QUIT_PROFILE_MISMATCH")
}
guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
      app.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: executable).resolvingSymlinksInPath().path,
      app.terminate() else { refuse("BENCH_FIREFOX_QUIT_REFUSED") }
