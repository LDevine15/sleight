// One transaction per acquisition, held inside the existing probe helper. No pointer events.
function frontRestoreController(io) {
  const calls = new Map();
  const identity = app => app && typeof app.bundleId === 'string' && app.bundleId &&
    Number.isInteger(app.pid) && app.pid > 0;
  const same = (a, b) => identity(a) && identity(b) && a.pid === b.pid && a.bundleId === b.bundleId;
  const quiet = (state, call) => Number.isFinite(state.time) && Number.isFinite(state.idleSeconds) &&
    state.time >= call.started && state.time - call.started < 600 && state.idleSeconds >= state.time - call.started;
  return request => {
    if (request.action === 'begin') {
      if (typeof request.selector !== 'string' || !request.selector) return {};
      const state = io.observe(request.selector);
      if (!identity(state.front) || state.targets?.length !== 0 || !Number.isFinite(state.time) ||
          !Number.isFinite(state.idleSeconds)) return {};
      // Bound abandoned calls, including calls interrupted before an engine reply.
      if (calls.size >= 128) calls.delete(calls.keys().next().value);
      const token = io.token();
      calls.set(token, { selector: request.selector, previous: { ...state.front }, started: state.time, armed: false });
      return { token };
    }
    const call = calls.get(request.token);
    if (!call) return { armed: false, restored: false };
    if (request.action === 'arm') {
      const state = io.observe(call.selector, call.previous);
      if (call.armed || !same(state.front, call.previous) || state.targets?.length !== 0 || !quiet(state, call)) {
        calls.delete(request.token); return { armed: false };
      }
      call.armed = true;
      return { armed: true };
    }
    // Consume before checking or activating, so even an activation failure cannot retry.
    calls.delete(request.token);
    if (request.action !== 'finish' || request.success !== true || !call.armed) return { restored: false };
    const state = io.observe(call.selector, call.previous), target = state.targets?.[0];
    if (state.targets?.length !== 1 || !same(state.front, target) || !same(state.previous, call.previous) ||
        !identity(target) || target.bundleId === call.previous.bundleId || target.pid === call.previous.pid ||
        !quiet(state, call)) return { restored: false };
    if (!io.activate(call.previous)) return { restored: false };
    return { restored: true, ...call.previous };
  };
}

let frontRestoreNative;
function run(request) {
  const info = app => !app || app.isNil() || app.terminated ? undefined : {
    bundleId: ObjC.unwrap(app.bundleIdentifier), pid: Number(app.processIdentifier), app: ObjC.unwrap(app.localizedName),
  };
  if (!frontRestoreNative) frontRestoreNative = frontRestoreController({
    token: () => ObjC.unwrap($.NSUUID.UUID.UUIDString),
    observe: (selector, previous) => {
      // Start the interval before reading focus, so input during that observation counts too.
      const time = Number($.NSProcessInfo.processInfo.systemUptime);
      return {
        time, front: info($.NSWorkspace.sharedWorkspace.frontmostApplication),
        targets: matchingApps($.NSWorkspace.sharedWorkspace.runningApplications, selector).map(info),
        previous: previous && info($.NSRunningApplication.runningApplicationWithProcessIdentifier(previous.pid)),
        // HID system state observes real input without an event tap or a new permission request.
        idleSeconds: Number($.CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF)),
      };
    },
    activate: previous => {
      const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(previous.pid), current = info(app);
      if (current?.bundleId !== previous.bundleId || current.pid !== previous.pid || !app.activateWithOptions(0)) return false;
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.005));
      const front = info($.NSWorkspace.sharedWorkspace.frontmostApplication);
      return front?.bundleId === previous.bundleId && front.pid === previous.pid;
    },
  });
  return frontRestoreNative(request);
}
