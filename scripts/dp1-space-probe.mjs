// Read-only DP1 metadata count probe. No Apple events or app launches.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const health = readFileSync(new URL('../plugins/sleight/lib/app-health.js', import.meta.url), 'utf8');
const identity = readFileSync(new URL('../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
const count = identity.slice(identity.indexOf('const cg = ObjC.castRefToObject'), identity.indexOf('windowCount = held;'));
if (!count || !count.includes('spaceWindows')) throw Error('Close-count source not found');
const source = `
${health}
function run() {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier('com.apple.finder');
    if (Number(apps.count) !== 1) throw Error('Expected already-running Finder');
    const finder = Number(apps.objectAtIndex(0).processIdentifier);
    const processStart = Number(apps.objectAtIndex(0).launchDate.timeIntervalSince1970);
    const result = [{finder, processStart}];
    const inspect = eval(${JSON.stringify(`(function () { ${identity.slice(0, identity.indexOf('function run(argv)'))}
      function run(pid) {
        const deadline = Date.now() + 150;
        let unknownReason = 'helper-error';
        const expired = () => { if (Date.now() >= deadline) { unknownReason = 'deadline'; throw Error('deadline'); } };
        try { ${count} return { held, candidates: n, total, spacesBroken }; }
        catch { return { status: 'unknown', unknownReason }; }
      }
      return run;
    })()`)});
    const fullCount = eval(${JSON.stringify(`(function () { ${identity}; return run; })()`)});
    for (const pid of [finder, 2147483647]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const start = Date.now();
        try { result.push({pid, attempt, count: inspect(pid), ms: Date.now() - start}); }
        catch (error) { result.push({pid, attempt, error: String(error.message || error), ms: Date.now() - start}); }
      }
      const start = Date.now();
      result.push({pid, full: JSON.parse(fullCount([JSON.stringify({ appId: 'com.apple.finder', closeCount: true,
        nativeIdentity: { pid, processStart: pid === finder ? processStart : 1 } })])), ms: Date.now() - start});
    }
    return JSON.stringify(result);
}`;
// spawnSync owns and reaps the sole child, including its bounded timeout.
const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript'], {
  input: source, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
