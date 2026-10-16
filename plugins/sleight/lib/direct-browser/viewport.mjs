// The viewport step of browser_act: set a size and report the old one, or give the original back.
// The original is the page's own size before the first override on that page.
const original = new WeakMap();

async function innerSize(page) {
  let session, timer;
  try {
    session = await page.context().newCDPSession(page);
    const { result } = await Promise.race([session.send('Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('size read timed out')), 1500); })]);
    const [width, height] = Array.isArray(result?.value) ? result.value : [];
    return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ? { width, height } : null;
  } catch { return null; }
  finally { clearTimeout(timer); await session?.detach().catch(() => {}); }
}

export async function setViewport(page, { width, height }) {
  if (width === undefined) {
    const size = original.get(page);
    if (!size) return 'viewport unchanged: no size was set on this tab';
    await page.setViewportSize(size);
    original.delete(page);
    return `viewport restored to ${size.width}x${size.height}`;
  }
  const before = await innerSize(page);
  if (before && !original.has(page)) original.set(page, before);
  await page.setViewportSize({ width, height });
  const now = await innerSize(page);
  return `viewport ${now ? now.width + 'x' + now.height : width + 'x' + height}`
    + (before ? ` (was ${before.width}x${before.height}); a viewport step with no size restores ${original.get(page).width}x${original.get(page).height}`
      : '; previous size unknown');
}
