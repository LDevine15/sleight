// Trusted connection metadata, never page script, supplies the selected port.
const pages = new WeakMap();
export const endpointBlock = 'blocked: DevTools endpoint';
const port = url => url.port || (['https:', 'wss:'].includes(url.protocol) ? '443' : '80');
export function endpointURL(value, endpoint) {
  if (!endpoint || !value) return false;
  try { const parsed = new URL(value); return !!parsed.hostname && port(parsed) === port(new URL(endpoint)); } catch { return false; }
}
export function endpointTarget(info, endpoint) {
  return [info?.url, info?.pendingUrl, info?.pendingURL].some(url => endpointURL(url, endpoint));
}
export function bindEndpointPage(page, endpoint, cdp, { blocked, close } = {}) {
  if (!endpoint) return;
  const record = { endpoint, cdp, blocked, close, pending: undefined };
  pages.set(page, record);
  // Observe only this owned page's browser navigation metadata. Never inject a
  // page-side security check or attach to unrelated targets.
  cdp.on?.('Page.frameRequestedNavigation', event => { if (!record.frame || !event.frameId || event.frameId === record.frame) record.pending = event.url; });
  cdp.on?.('Page.frameStartedNavigating', event => { if (!record.frame || !event.frameId || event.frameId === record.frame) record.pending = event.url; });
  cdp.on?.('Page.frameNavigated', event => { if (!event.frame?.parentId) { record.frame = event.frame.id; record.pending = undefined; } });
}
export async function assertEndpointRead(page, endpoint) {
  const record = pages.get(page), selected = record?.endpoint ?? endpoint;
  if (!selected) return;
  const block = async () => {
    // Revocation happens even when physical closure needs a cleanup retry.
    await record?.close?.().catch(() => {});
    throw Error(endpointBlock);
  };
  if (record?.blocked?.()) return block();
  if (endpointURL(page.url(), selected) || endpointURL(record?.pending, selected)) return block();
  if (record?.cdp) {
    let timer;
    const { targetInfo } = await Promise.race([record.cdp.send('Target.getTargetInfo'), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('endpoint page identity unavailable')), 1500);
    })]).finally(() => clearTimeout(timer));
    if (endpointTarget(targetInfo, selected)) return block();
  }
  if (page.frames?.().some(frame => endpointURL(frame.url?.(), selected))) return block();
}
