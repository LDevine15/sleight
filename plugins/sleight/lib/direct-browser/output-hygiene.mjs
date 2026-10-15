// Page-chosen strings (title, URL path, dialog text, element names) must reach the model only inside an
// "(untrusted page content)" label. Trusted lines carry the origin and neutral words.
export const originOf = url => { try { const u = new URL(url); return u.origin !== 'null' ? u.origin : u.protocol + (u.pathname === 'blank' ? 'blank' : ''); } catch { return 'unknown origin'; } };
export const pathOf = url => { try { const u = new URL(url), path = (u.pathname + u.search).replace(/[\r\n\t]+/g, ' '); return path === '/' ? '' : path.slice(0, 100); } catch { return ''; } };

// A chooser is never opened natively: a listener makes Playwright intercept it (Page.setInterceptFileChooserDialog),
// and the count lets the step report it. Uploads go through the upload step.
const guarded = new WeakSet();
export function guardChooser(page, state) {
  if (!page?.on || guarded.has(page)) return;
  guarded.add(page);
  page.on('filechooser', () => { state.chooser = (state.chooser ?? 0) + 1; });
}
