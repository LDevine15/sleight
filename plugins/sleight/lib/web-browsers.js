// The apps LaunchServices lists as handlers for https: what makes an app a web browser for sleight's site limits on the
// engine path. Read-only: it asks LaunchServices and acts on no app.
//
//   osascript -l JavaScript web-browsers.js '{}'   prints { ok, ids: [bundle id, …] }

ObjC.import('CoreServices');

function run() {
  try {
    const list = $.LSCopyAllHandlersForURLScheme($('https'));
    const ids = list ? ObjC.deepUnwrap(ObjC.castRefToObject(list)) : [];
    return JSON.stringify({ ok: true, ids: Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [] });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e.message || e) });
  }
}
