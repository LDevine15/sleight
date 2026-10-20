// Build qualification for an Electron app on turbo (EPV3-6): a dry run of the path the tools use, on an app that is
// already connected (provider), with its targets started and its pages seeded. One list, one read of the first
// joined window, the renderer-to-native geometry delta, and one Escape pressed in the background through the page
// registry's guard, all under one deadline. It never launches, focuses or closes anything and never throws for an
// app state: an empty profile's sign-in overlay, zero joined windows or a park end in a receipt with a code.
// A receipt is a hint for skipping a second dry run on the same instance. It never authorizes an operation.
export const UNQUALIFIED = 'ELECTRON_UNQUALIFIED';
const fail = code => { throw Error(code); };
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const receipts = new WeakSet();
const codeOf = error => /^[A-Z][A-Z0-9_]{2,63}(?=$|:)/.exec(String(error?.message ?? ''))?.[0] ?? 'ELECTRON_QUALIFY_FAILED';
const freeze = value => { if (plain(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Closure-free, for page.evaluate: is an open modal dialog covering the document (a first-run or sign-in overlay)?
// Generic web semantics, no app selectors. Page content can fake it, which can only make the page unqualified.
export const blockingDialog = () => [...document.querySelectorAll('dialog[open], [aria-modal="true"], [role="alertdialog"]')]
  .some(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; });

export async function qualify({ provider, targets, join, pages, read, windows, recipe, deadlineMs = 5000, now = Date.now } = {}) {
  if (!plain(provider) || typeof provider.verifyConnection !== 'function' || typeof targets?.members !== 'function' || typeof targets.geometry !== 'function' ||
      typeof join?.parked !== 'function' || typeof pages?.list !== 'function' || typeof pages.tab !== 'function' || typeof pages.guard !== 'function' ||
      typeof read !== 'function' || typeof windows?.read !== 'function' || !plain(recipe) || !Number.isFinite(deadlineMs) || deadlineMs <= 0 || typeof now !== 'function')
    fail('ELECTRON_QUALIFY_REQUIRED');
  const at = now(), end = at + deadlineMs;
  const cells = { handshake: false, targets: 0, joined: 0, parked: [], read: null, delta: null, overlay: null, escape: { sent: false } };
  const receipt = { build: recipe.build, bundleId: recipe.bundleId, sha256: recipe.sha256 ?? null, instance: null, at, ms: 0, cells, qualified: false };
  // One shared deadline: every await races what is left of it.
  const within = promise => {
    const left = end - now();
    Promise.resolve(promise).catch(() => {});
    if (left <= 0) return Promise.reject(Error('ELECTRON_QUALIFY_DEADLINE'));
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('ELECTRON_QUALIFY_DEADLINE')), left); })]).finally(() => clearTimeout(timer));
  };
  const delta = (geometry, frame) => ({ width: Math.abs(geometry.width - frame.width), height: Math.abs(geometry.height - frame.height) });
  let failed, stage = 'recipe';
  try {
    if (typeof recipe.sha256 !== 'string') fail('RECIPE_UNFILLED');
    stage = 'handshake';
    const identity = provider.identity;
    if (!plain(identity) || !Number.isSafeInteger(identity.pid) || typeof identity.birth !== 'string' || !Number.isSafeInteger(identity.epoch) ||
        typeof identity.instance !== 'string') fail('ELECTRON_QUALIFY_HANDSHAKE');
    receipt.instance = { pid: identity.pid, pidBirth: identity.birth, epoch: identity.epoch, instance: identity.instance };
    if (await within(provider.verifyConnection(provider.session)) !== true) fail('ELECTRON_QUALIFY_HANDSHAKE');
    cells.handshake = true;
    stage = 'targets';
    if (join.parked()) fail('ELECTRON_PARKED');
    const members = targets.members();
    cells.targets = members.length;
    if (!members.length) fail('ELECTRON_QUALIFY_NO_TARGETS');
    stage = 'join';
    const rows = await within(pages.list());
    const joined = rows.filter(row => row.status === 'joined');
    cells.joined = joined.length;
    cells.parked = rows.filter(row => row.status === 'parked').map(row => String(row.reason ?? 'parked'));
    if (!joined.length) {
      // The title-bar delta is what keeps a window from joining, so it is still measured when it can be named.
      if (members.length === 1) {
        const geometry = await within(targets.geometry(members[0].targetId));
        const usable = (await within(windows.read())).windows.filter(row => row.onScreen && !row.minimized);
        if (usable.length === 1) cells.delta = delta(geometry, usable[0].frame);
      }
      fail('ELECTRON_QUALIFY_NO_JOIN');
    }
    const entry = pages.tab(joined[0].tab);
    // Geometry can be measured even when the snapshot is unavailable.
    stage = 'geometry';
    const geometry = await within(targets.geometry(entry.targetId));
    const frame = (await within(windows.read())).windows.find(row => row.id === entry.window.id && row.epoch === entry.window.epoch)?.frame;
    if (!frame) fail('ELECTRON_QUALIFY_NO_JOIN');
    cells.delta = delta(geometry, frame);
    stage = 'read';
    // The dry-run read is never delivered to the model, so it must not count as the model's read of this join.
    const { readJoinNo, readEpoch } = entry.state;
    const started = now();
    let text;
    try { ({ text } = await within(read(entry.page, { maxChars: 8000 }))); }
    finally {
      Object.assign(entry.state, { readJoinNo, readEpoch });
    }
    cells.read = { ms: now() - started, bytes: Buffer.byteLength(String(text ?? '')) };
    stage = 'overlay';
    const overlay = { before: await within(entry.page.evaluate(blockingDialog)) === true, after: false };
    cells.overlay = overlay;
    stage = 'escape';
    const pressed = now();
    await within(pages.guard(entry, async () => {
      if (now() >= end) fail('ELECTRON_QUALIFY_DEADLINE');
      cells.escape.sent = true;
      await entry.page.keyboard.press('Escape');
    }));
    cells.escape.ms = now() - pressed;
    if (overlay.before) overlay.after = await within(entry.page.evaluate(blockingDialog)) === true;
    if (overlay.after) fail('ELECTRON_STARTUP_OVERLAY');
  } catch (error) { failed = codeOf(error); }
  receipt.ms = now() - at;
  if (failed) { receipt.failed = failed; receipt.failedStage = stage; }
  receipt.qualified = !failed;
  receipts.add(freeze(receipt));
  return receipt;
}

/** True only for a receipt qualify() made, for the same hash, build, process, instance and broker epoch, younger than ttlMs. */
export function receiptCurrent(receipt, identity, recipe, now = Date.now, ttlMs = 30000) {
  try {
    if (!receipts.has(receipt) || !plain(identity) || !plain(recipe) || typeof recipe.sha256 !== 'string') return false;
    const age = now() - receipt.at;
    return receipt.sha256 === recipe.sha256 && receipt.build === recipe.build && receipt.bundleId === recipe.bundleId && receipt.instance?.pid === identity.pid &&
      receipt.instance.pidBirth === identity.birth && receipt.instance.instance === identity.instance && receipt.instance.epoch === identity.epoch &&
      age >= 0 && age < ttlMs;
  } catch { return false; }
}
