// Page-chosen strings (title, URL path, dialog text, element names) must reach the model only inside an
// "(untrusted page content)" label. Trusted lines carry the origin and neutral words.
// A page can pick its hostname (a link or a redirect), so trusted lines cap it: 63 characters per label, 100 in all.
const capHost = host => { const text = host.split('.').map(label => label.length > 63 ? label.slice(0, 60) + '…' : label).join('.'); return text.length > 100 ? text.slice(0, 97) + '…' : text; };
export const originOf = url => { try { const u = new URL(url); return u.origin !== 'null' ? u.protocol + '//' + capHost(u.hostname) + (u.port ? ':' + u.port : '') : u.protocol + (u.pathname === 'blank' ? 'blank' : ''); } catch { return 'unknown origin'; } };
export const pathOf = url => { try { const u = new URL(url), path = (u.pathname + u.search).replace(/[\r\n\t]+/g, ' '); return path === '/' ? '' : path.slice(0, 100); } catch { return ''; } };

// A chooser is never opened natively: a listener makes Playwright intercept it (Page.setInterceptFileChooserDialog).
// The page can open one after the step returns, so the dispatcher reports the growth since the last result the
// model received (state.chooserReported, state.hiddenReported). A chooser whose input is not visible has no ref
// in the snapshot, so the upload step has nothing to target.
const guarded = new WeakSet();
export function guardChooser(page, state) {
  if (!page?.on || guarded.has(page)) return;
  guarded.add(page);
  state.chooserProbes ??= new Set();
  page.on('filechooser', chooser => {
    state.chooser = (state.chooser ?? 0) + 1;
    const probe = (async () => { try { if (!await chooser.element().isVisible()) state.chooserHidden = (state.chooserHidden ?? 0) + 1; } catch { state.chooserHidden = (state.chooserHidden ?? 0) + 1; } })();
    state.chooserProbes.add(probe); probe.finally(() => state.chooserProbes.delete(probe));
  });
}
export async function chooserNote(state) {
  if ((state.chooser ?? 0) <= (state.chooserReported ?? 0)) return null;
  await Promise.all([...state.chooserProbes ?? []]);
  const note = (state.chooserHidden ?? 0) > (state.hiddenReported ?? 0)
    ? 'a file picker opened and was suppressed, but its input has no ref in the snapshot; upload with the engine browser path'
    : 'a file picker opened and was suppressed, use an upload step with the user-named file';
  return { note, chooser: state.chooser ?? 0, hidden: state.chooserHidden ?? 0 };
}
