// v2 section 7 and the retained v1 safety matrix. Inputs are trusted classified
// intent, never page claims. This matrix cannot infer effects of arbitrary JS.
export const CONSEQUENCES = Object.freeze(['payment', 'deletion', 'cancellation', 'access', 'sharing',
  'account-finalization', 'credentials', 'oauth', 'save-password', 'save-card', 'captcha',
  'installation', 'execution', 'communication', 'post', 'appointment', 'subscription',
  'notifications', 'security', 'medical']);
const exceptions = new Set(['login', 'permission', 'age', 'warning', 'upload', 'move', 'rename']);
const ordinary = new Set(['ordinary', 'cookie', 'tos', 'download']);
const handoffs = new Set(['password-change', 'safety-barrier', 'paywall', 'native']);
export function siteOrigin(intent) {
  if (intent.kind !== 'navigate' && intent.kind !== 'open') return intent.scope.origin;
  const url = new URL(intent.args.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('navigation');
  return url.origin;
}
export function verdict(intent, authority = {}) {
  const result = (value, reason) => ({ verdict: value, reason });
  let origin;
  try { origin = new URL(intent.scope.origin); } catch { return result('deny', 'origin'); }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== intent.scope.origin)
    return result('deny', 'origin');
  try { siteOrigin(intent); } catch { return result('deny', 'origin'); }
  if (handoffs.has(intent.consequence)) return result('handoff', 'human-required');
  if (!ordinary.has(intent.consequence) && !exceptions.has(intent.consequence) && !CONSEQUENCES.includes(intent.consequence))
    return result('deny', 'unclassified-effect');
  if (!authority.site) return result('confirm', 'site');
  if (intent.transmission && !authority.transmission && !authority.confirmed)
    return result('confirm', 'transmission-before-input');
  if (CONSEQUENCES.includes(intent.consequence)) {
    if (authority.confirmed) return result('allow', 'confirmed-operation');
    if (intent.consequence === 'payment' && authority.exactRequest && authority.confirmPayments !== 'always')
      return result('allow', 'exact-payment-request');
    return result('confirm', 'action-time');
  }
  if (exceptions.has(intent.consequence) && !authority.confirmed && !authority.exactRequest)
    return result('confirm', 'specific-request-required');
  return result('allow', 'authorized');
}
