// App knowledge is data. Fixtures, drivers and checks dispatch only on kinds/formats.
const descriptors = {
  notes: { containers: 'folders', items: 'notes', constructor: 'Note', properties: { name: '$marker', body: '$marker' } },
  reminders: { containers: 'lists', items: 'reminders', constructor: 'Reminder', properties: { name: '$marker' } },
  calendar: { containers: 'calendars', items: 'events', constructor: 'Event', properties: {
    summary: '$marker', startDate: { minutesFromNow: 60 }, endDate: { minutesFromNow: 90 } } },
};
// Multi-step work inside one app's scrap area, checked by one engine read for the expected text.
// ZCode (owner, 2026-10-11): its scrap project only, never the agent seats that run in it.
const SCRAP = 'In ZCode, work only in the project named sleight-scrap (if it is not listed under Projects, add the folder ~/sleight-scrap with Add project first). ' +
  'Start a new task there and send exactly: Reply with the single word ok. $marker';
const flows = {
  'zcode-send': { steps: SCRAP, expect: ['$marker'] },
  'zcode-rename': { steps: `${SCRAP}\nThen rename that task to: scrap $marker`, expect: ['scrap $marker'] },
  'zcode-pin': { steps: `${SCRAP}\nThen rename that task to: pin $marker\nPin it, confirm it is listed under Pinned, then unpin it.`, expect: ['pin $marker'] },
  'zcode-sidebar': { steps: 'In ZCode\'s sidebar, collapse the Projects section and expand it again, switch the sidebar view to Group and back to Project, ' +
    `then open the sleight-scrap project. ${SCRAP.slice(SCRAP.indexOf('Start a new task'))}`, expect: ['$marker'] },
};
const groups = {
  'doc-file': [
    ['textedit', 'TextEdit', 'com.apple.TextEdit', 'txt', 'edit'],
    ['word', 'Microsoft Word', 'com.microsoft.Word', 'docx', 'edit', ['Word']],
    ['excel', 'Microsoft Excel', 'com.microsoft.Excel', 'xlsx', 'edit', ['Excel']],
    ['powerpoint', 'Microsoft PowerPoint', 'com.microsoft.Powerpoint', 'pptx', 'edit', ['PowerPoint']],
    ['pages', 'Pages', 'com.apple.iWork.Pages', 'docx', 'edit'],
    ['numbers', 'Numbers', 'com.apple.iWork.Numbers', 'xlsx', 'edit'],
    ['keynote', 'Keynote', 'com.apple.iWork.Keynote', 'pptx', 'edit'],
    ['preview', 'Preview', 'com.apple.Preview', 'pdf', 'read'],
    ['vscode', 'Visual Studio Code', 'com.microsoft.VSCode', 'md', 'edit', ['VS Code', 'Code']],
    ['cursor', 'Cursor', 'com.todesktop.230313mzl4w4u92', 'html', 'edit'],
    ['finder', 'Finder', 'com.apple.finder', 'txt', 'read'],
    ['notion', 'Notion', 'notion.id', 'md', 'read', [], true, 'local-file opening must be supported; otherwise record failure'],
  ],
  'self-message': [
    ['slack', 'Slack', 'com.tinyspeck.slackmacgap'], ['discord', 'Discord', 'com.hnc.Discord'],
    ['whatsapp', 'WhatsApp', 'net.whatsapp.WhatsApp'], ['messages', 'Messages', 'com.apple.MobileSMS'],
    ['mail', 'Mail', 'com.apple.mail'],
  ],
  'web-page': [
    ['safari', 'Safari', 'com.apple.Safari'], ['chrome', 'Google Chrome', 'com.google.Chrome', null, null, ['Chrome']],
    ['helium', 'Helium', 'net.imput.helium'], ['firefox', 'Firefox', 'org.mozilla.firefox'],
    ['arc', 'Arc', 'company.thebrowser.Browser'],
  ],
  'app-state': [
    ['calculator', 'Calculator', 'com.apple.calculator', null, 'calculate'],
    ['notes', 'Notes', 'com.apple.Notes', null, 'create'],
    ['reminders', 'Reminders', 'com.apple.reminders', null, 'create'],
    ['calendar', 'Calendar', 'com.apple.iCal', null, 'create'],
    ['music', 'Music', 'com.apple.Music', null, 'read'], ['maps', 'Maps', 'com.apple.Maps', null, 'read'],
    ['photos', 'Photos', 'com.apple.Photos', null, 'read'], ['spotify', 'Spotify', 'com.spotify.client', null, 'read'],
    ['zoom', 'zoom.us', 'us.zoom.xos', null, 'read', ['Zoom']],
  ],
  'app-flow': Object.keys(flows).map(id => [id, 'ZCode', 'dev.zcode.app', null, 'flow', [], false]),
};
const goals = {
  'doc-file': 'Open the fixture in the named app. For edits replace PENDING with DONE, keep the marker, and save in the same format and path. For reads report its marker without changing the file.',
  'self-message': 'Find the owner-seeded self-message. Read only. Report the marker, sender and displayed time.',
  'web-page': 'Open the loopback fixture page in the named browser. Read its marker and report it.',
  'app-state': 'Use only the isolated fixture. Create the named item if requested, or read the owner-seeded item without changing it. Leave its marker visible for a single engine read.',
  'app-flow': 'Do the steps below in the app\'s scrap area only. Leave the result visible for a single engine read.',
};
export const tasks = Object.freeze(Object.entries(groups).flatMap(([kind, entries]) => entries.map(
  ([id, app, bundle, format, mode = 'read', aliases = [], ownerPresent = kind === 'self-message' || (kind === 'app-state' && mode !== 'calculate'), conditional]) => Object.freeze({ id, app, bundle, aliases,
    fixtureKind: kind, checkKind: kind, format, mode: mode ?? 'read', goal: goals[kind],
    scripting: descriptors[id], steps: flows[id]?.steps, expect: flows[id]?.expect,
    ownerPresent, conditional,
  }))));
export const counts = selected => Object.fromEntries(Object.keys(groups).map(kind =>
  [kind, selected.filter(task => task.fixtureKind === kind).length]));
export const approvedApps = ownerPresent => tasks.filter(task => !task.ownerPresent || ownerPresent)
  .flatMap(task => [task.app, task.bundle, ...task.aliases]);
