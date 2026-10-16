// Trusted semantic classification only. Page observations never grant permission.
export function siteOrigin(intent) {
  if (intent.kind !== 'navigate' && intent.kind !== 'open') return intent.scope.origin;
  const url = new URL(intent.args.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('navigation');
  return url.origin;
}
export function verdict(intent, authority = {}) {
  try {
    const url = new URL(intent.scope.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== intent.scope.origin) throw Error();
    siteOrigin(intent);
  } catch { return { verdict: 'deny', reason: 'origin' }; }
  if (intent.consequence === 'payment' && intent.args?.action !== 'dismiss') {
    if (authority.confirmed) return { verdict: 'allow', reason: 'confirmed-payment' };
    // Only 'always' stops an exact user request here. 'never' acts as 'requested': this path has no figure check to skip.
    if (authority.exactRequest && authority.confirmPayments !== 'always') return { verdict: 'allow', reason: 'user-payment-request' };
    return { verdict: 'confirm', reason: 'payment' };
  }
  return { verdict: 'allow', reason: 'authorized' };
}
