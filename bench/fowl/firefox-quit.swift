import AppKit

// Quit only the process launched by this round, never an application by name.
guard CommandLine.arguments.count == 3,
      let pid = Int32(CommandLine.arguments[1]), pid > 0,
      let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
      app.executableURL?.resolvingSymlinksInPath().path == URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath().path,
      app.terminate() else { exit(1) }
