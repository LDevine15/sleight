import AppKit
import Darwin

// Check ancestry before asking AppKit to quit an exact runner-owned process.
guard CommandLine.arguments.count == 4,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let runner = Int32(CommandLine.arguments[3]), runner > 0 else { exit(1) }
var info = kinfo_proc()
var size = MemoryLayout<kinfo_proc>.stride
var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0,
      size == MemoryLayout<kinfo_proc>.stride,
      info.kp_eproc.e_ppid == runner else {
    fputs("BENCH_FIREFOX_QUIT_PARENT_MISMATCH\n", stderr)
    exit(1)
}
guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
      app.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath().path,
      app.terminate() else {
    fputs("BENCH_FIREFOX_QUIT_REFUSED\n", stderr)
    exit(1)
}
