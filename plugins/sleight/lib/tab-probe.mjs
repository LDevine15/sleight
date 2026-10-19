import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyWindowIdentity } from './window-identity.mjs';
import { tabFocusRefusal } from './menu-continuation.mjs';
import { tokens } from './flow-rules.mjs';

// Only an awaited Cmd+T, literal URL, Return chain. The splitter already excludes intervening reads and other handles.
export function nativeTabPlan(plan) {
  if (plan?.actions?.length !== 3 || plan.actions[0].selector?.kind !== 'key' ||
      !/^(?:super|cmd|command|meta)\+t$/i.test(plan.actions[0].selector.value) ||
      plan.actions[2].selector?.kind !== 'key' || !/^(?:return|enter)$/i.test(plan.actions[2].selector.value)) return false;
  const action = plan.actions[1], ts = tokens(plan.code.slice(action.start, action.end)).filter(t => t.v !== ';');
  return ts.length === 7 && ts[3]?.v === 'typeText' && !ts[3].string && ts[5]?.string === true &&
    /^https?:\/\/[^\s\u0000-\u001f]+$/i.test(ts[5].v);
}

// The same identity and focus evidence as the tab continuation, sampled again inside its remainder.
// `since` and `now` are wall-clock milliseconds, since the guard and relay have different performance clocks.
export function tabProbeRefusal(expected, observed, since, now, transition = false, baselineOnly = false) {
  if (!Number.isSafeInteger(expected?.windowNumber) || expected.windowNumber <= 0) return 'no-window-number';
  if (!expected.nativeIdentity) return 'no-baseline';
  if (typeof observed?.title !== 'string' || !(observed.url === null || typeof observed.url === 'string') ||
      typeof observed.epoch !== 'string' || observed.window <= 0 || observed.pid <= 0 || observed.processStart <= 0) return 'malformed-identity';
  try { verifyWindowIdentity(transition ? { ...expected, title: observed?.title, url: observed?.url } : expected, observed); } catch { return 'identity-mismatch'; }
  if (observed.windowNumber !== expected.windowNumber) return 'window-number-changed';
  if (observed.headerMatches !== 1 || observed.windowSubrole !== 'AXStandardWindow') return 'ambiguous-header';
  if (!Number.isFinite(observed.hidIdleSeconds) || observed.hidIdleSeconds <= 0 ||
      !Number.isFinite(since) || !Number.isFinite(now) || now < since || observed.hidIdleSeconds < (now - since) / 1000) return 'hid-input';
  const valid = c => c?.complete === true && Number.isSafeInteger(c.group) && c.group > 0 &&
    Array.isArray(c.children) && c.children.length === c.childCount && c.childCount > 0 && c.childCount <= 256 &&
    c.children.every(r => Number.isSafeInteger(r) && r > 0) && new Set(c.children).size === c.children.length &&
    Array.isArray(c.tabs) && c.tabs.length === c.tabCount && c.tabCount > 0 && c.tabs.every(t =>
      Number.isSafeInteger(t?.ref) && c.children.includes(t.ref) && typeof t.selected === 'boolean') &&
    new Set(c.tabs.map(t => t.ref)).size === c.tabCount && c.tabs.filter(t => t.selected).length === 1 &&
    Number.isSafeInteger(c.addressField) && c.addressField > 0;
  const was = expected.nativeIdentity.chrome, current = observed.chrome;
  if (!valid(was) || !valid(current)) return 'incomplete-chrome';
  if (was.group !== current.group || was.addressField !== current.addressField) return 'chrome-replaced';
  if (transition) {
    const added = current.children.filter(r => !was.children.includes(r));
    const addedTabs = current.tabs.filter(t => !was.tabs.some(old => old.ref === t.ref));
    if (current.childCount !== was.childCount + 1 || current.tabCount !== was.tabCount + 1 || added.length !== 1 ||
        addedTabs.length !== 1 || addedTabs[0].ref !== added[0] || !addedTabs[0].selected ||
        JSON.stringify(current.children.filter(r => r !== added[0])) !== JSON.stringify(was.children) ||
        JSON.stringify(current.tabs.filter(t => t.ref !== added[0]).map(t => t.ref)) !== JSON.stringify(was.tabs.map(t => t.ref))) return 'no-new-tab';
  } else if (JSON.stringify(current.children) !== JSON.stringify(was.children) || JSON.stringify(current.tabs) !== JSON.stringify(was.tabs)) return 'tab-strip-changed';
  if (baselineOnly) return;
  if (current.focused !== current.addressField) return 'focus-not-address';
  return tabFocusRefusal(observed);
}

// The engine sandbox can read the lease directory but cannot call the helper. A bounded observer supplies metadata only.
// Each action waits for a sample started after it entered its guard. A missing or refused sample falls back to the tree.
export function createTabProbe({ directory, observe, intervalMs = 10, timeoutMs = 600, deadlineMs = 650, freshMs = 100,
  now = Date.now } = {}) {
  const calls = new Map();
  const run = async call => {
    if (call.ended || now() >= call.until) return;
    const start = now();
    let timer, observed;
    try {
      observed = await Promise.race([Promise.resolve().then(() => observe({ ...call.target, focus: true, tabCertificate: true,
        ...(call.mode === 'new-tab' ? { followTab: true } : {}) })),
        new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]);
    } catch { /* A failed probe records no identity. */ }
    finally { clearTimeout(timer); }
    if (call.ended) return;
    try {
      call.observations.push({ start, end: now(), observed });
      call.observations = call.observations.slice(-8);
      writeFileSync(call.path + '.tmp', JSON.stringify({ ...call.observations.at(-1), observations: call.observations }), { mode: 0o600 });
      renameSync(call.path + '.tmp', call.path);
    } catch { /* The guard reads the tree if publication fails. */ }
    if (!observed) return; // Do not queue another native call behind a timed-out one.
    call.timer = setTimeout(() => run(call), intervalMs);
    call.timer.unref?.();
  };
  return {
    begin(id, target, since = now(), mode = 'remainder') {
      if (!directory || !target?.appId || !target.nativeIdentity || calls.has(id)) return;
      const call = { path: join(directory, `tab-${randomUUID()}.obs`), target, mode, observations: [], until: now() + 10000 };
      calls.set(id, call);
      void run(call);
      return { path: call.path, target, since, deadlineMs, freshMs, mode };
    },
    end(id) {
      const call = calls.get(id);
      if (!call) return;
      call.ended = true; calls.delete(id); clearTimeout(call.timer);
      for (const path of [call.path, call.path + '.tmp']) try { rmSync(path, { force: true }); } catch {}
    },
    dispose() { for (const id of calls.keys()) this.end(id); },
  };
}
