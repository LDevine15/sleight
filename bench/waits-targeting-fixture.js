// Fixture bookkeeping uses document IDs; cleanup never matches by title.
ObjC.import('AppKit');
function run(argv) {
  const request = JSON.parse(argv[0]);
  const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(request.appId ?? 'com.apple.TextEdit');
  const launchedAt = target => { const date = target.launchDate; return !date || date.isNil() ? null : Number(date.timeIntervalSince1970) * 1000; };
  if (request.op === 'running') return JSON.stringify({ running: Number(running.count) > 0,
    pids: Array.from({ length: Number(running.count) }, (_, i) => Number(running.objectAtIndex(i).processIdentifier)),
    launchDates: Array.from({ length: Number(running.count) }, (_, i) => launchedAt(running.objectAtIndex(i))) });
  if (request.op === 'quit') {
    if (Number(running.count) !== 1) throw new Error('Expected one owned app');
    // With a pid or a launch time, quit only that process, launched no earlier than that time.
    const target = running.objectAtIndex(0);
    if (request.pid !== undefined && Number(target.processIdentifier) !== request.pid) throw new Error('Owned app pid changed');
    if (request.launchedAtMs !== undefined && !(launchedAt(target) >= request.launchedAtMs)) throw new Error('Owned app launch date unconfirmed');
    target.terminate;
    return JSON.stringify({ requested: true });
  }
  const app = Application('TextEdit');
  if (request.op === 'documents') return JSON.stringify(app.documents().map(doc => String(doc.name())));
  const matches = app.documents().filter(doc => String(doc.name()) === request.id);
  if (matches.length !== 1) throw new Error('Owned document ID missing or ambiguous');
  if (request.op === 'close') { matches[0].close({ saving: 'no' }); return JSON.stringify({ closed: true }); }
  throw new Error('Unknown fixture operation');
}
