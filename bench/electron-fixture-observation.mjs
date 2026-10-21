// Benchmark-only read diagnostics. No snapshot/ref creation, text/value reads, navigation, focus, or input.
// The only label read is an in-page equality comparison against one of two fixture names; no label leaves the page.
const names = new Set(['a-scratch.txt', 'a-notes.md']);
const fail = code => { throw Error(code); };
const number = (value, positive = false) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000 && (!positive || value >= 0) ? value : null;
const field = (value, key) => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const choice = (value, allowed, fallback = 'other') => allowed.includes(value) ? value : fallback;
const bool = value => typeof value === 'boolean' ? value : null;
const count = value => Number.isInteger(value) && value >= 0 && value <= 4096 ? value : 0;
const metadata = value => {
  const rect = field(value, 'rect');
  return { tag: choice(field(value, 'tag'), ['div', 'textarea', 'input', 'iframe', 'webview']),
    role: choice(field(value, 'role'), ['textbox', 'none']),
    rect: { x: number(field(rect, 'x')), y: number(field(rect, 'y')), width: number(field(rect, 'width'), true), height: number(field(rect, 'height'), true) },
    display: choice(field(value, 'display'), ['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents']),
    visibility: choice(field(value, 'visibility'), ['visible', 'hidden', 'collapse']),
    pointerEvents: choice(field(value, 'pointerEvents'), ['auto', 'none']),
    computedWidth: number(field(value, 'computedWidth'), true), inlineWidth: choice(field(value, 'inlineWidth'), ['absent', 'negative', 'zero', 'positive']),
    classCategory: choice(field(value, 'classCategory'), ['native-edit-context', 'textarea']),
    checkVisibility: bool(field(value, 'checkVisibility')), active: bool(field(value, 'active')), connected: bool(field(value, 'connected')),
    editContextPresent: bool(field(value, 'editContextPresent')), matchesFixtureName: field(value, 'matchesFixtureName') === true };
};

// Self-contained functions passed to Playwright. All page-derived strings are reduced to closed enums here,
// then validated again on the worker side. They return no DOM objects, handles, globals, labels, paths, or URLs.
export function observeFixtureDocument(fixtureName) {
  if (fixtureName !== 'a-scratch.txt' && fixtureName !== 'a-notes.md') throw Error('ELECTRON_FIXTURE_NAME');
  const finite = (value, positive = false) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000 && (!positive || value >= 0) ? value : null;
  const pick = (value, allowed) => allowed.includes(value) ? value : 'other';
  const matches = node => { const label = node.getAttribute('aria-label'); return label === fixtureName || label === fixtureName + ', preview'; };
  const editors = [], nodes = document.querySelectorAll('[role="textbox"],textarea,input');
  let textboxCount = 0, matchedCount = 0, activeFixtureEditor = false, truncated = nodes.length > 4096;
  for (let i = 0; i < Math.min(nodes.length, 4096); i++) {
    const node = nodes[i], tag = node.tagName?.toLowerCase(), role = node.getAttribute('role');
    if (role !== 'textbox' && tag !== 'textarea' && !(tag === 'input' && ['text', 'search', 'email', 'url', 'tel', null].includes(node.getAttribute('type')))) continue;
    textboxCount++;
    if (!matches(node)) continue;
    matchedCount++;
    const active = document.activeElement === node;
    activeFixtureEditor ||= active;
    if (editors.length >= 64) { truncated = true; continue; }
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node), inline = node.style?.width ?? '';
    const width = typeof style.width === 'string' && /^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(style.width) ? Number.parseFloat(style.width) : null;
    const inlineNumber = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|%|ch|vw|vh)?$/.test(inline) ? Number.parseFloat(inline) : null;
    let checkVisibility = null;
    try { if (typeof node.checkVisibility === 'function') checkVisibility = node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true; } catch { /* unavailable */ }
    editors.push({ tag: pick(tag, ['div', 'textarea', 'input']), role: pick(role ?? 'none', ['textbox', 'none']),
      rect: { x: finite(rect.x), y: finite(rect.y), width: finite(rect.width, true), height: finite(rect.height, true) },
      display: pick(style.display, ['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents']),
      visibility: pick(style.visibility, ['visible', 'hidden', 'collapse']), pointerEvents: pick(style.pointerEvents, ['auto', 'none']),
      computedWidth: finite(width, true), inlineWidth: inline === '' ? 'absent' : inlineNumber === null ? 'other' : inlineNumber < 0 ? 'negative' : inlineNumber === 0 ? 'zero' : 'positive',
      classCategory: node.classList?.contains('native-edit-context') ? 'native-edit-context' : tag === 'textarea' ? 'textarea' : 'other',
      checkVisibility, active, connected: node.isConnected === true, editContextPresent: node.editContext != null, matchesFixtureName: true });
  }
  let selectedFixtureTab = null;
  const tabs = document.querySelectorAll('[role="tab"]');
  truncated ||= tabs.length > 4096;
  for (let i = 0; i < Math.min(tabs.length, 4096); i++) if (matches(tabs[i])) {
    selectedFixtureTab = selectedFixtureTab === true || tabs[i].getAttribute('aria-selected') === 'true';
  }
  return { textboxCount, matchedCount, editors, selectedFixtureTab, activeFixtureEditor, truncated };
}

export function observeFixtureOwner(node) {
  const finite = (value, positive = false) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1000000 && (!positive || value >= 0) ? value : null;
  const pick = (value, allowed) => allowed.includes(value) ? value : 'other';
  const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
  let checkVisibility = null;
  try { if (typeof node.checkVisibility === 'function') checkVisibility = node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) === true; } catch { /* unavailable */ }
  return { tag: pick(node.tagName?.toLowerCase(), ['iframe', 'webview']), role: 'none',
    rect: { x: finite(rect.x), y: finite(rect.y), width: finite(rect.width, true), height: finite(rect.height, true) },
    display: pick(style.display, ['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents']),
    visibility: pick(style.visibility, ['visible', 'hidden', 'collapse']), pointerEvents: pick(style.pointerEvents, ['auto', 'none']),
    checkVisibility, connected: node.isConnected === true };
}

// Same pinned in-process client/server bridge and utility-world checks as trusted-dom.mjs.
// There is no MAIN-world fallback. Frame reads require no selector or snapshot; owner handles already identify the node.
async function utilityRead(subject, reader, arg, owner = false) {
  const impl = subject?._connection?.toImpl?.(subject), frame = owner ? impl?._frame : impl;
  if (!frame || frame._page?.delegate?.noUtilityWorld?.() || typeof frame.utilityContext !== 'function') fail('TRUSTED_DOM_REQUIRED');
  const utility = await frame.utilityContext();
  if (utility?.world !== 'utility' || typeof utility.evaluateExpression !== 'function') fail('TRUSTED_DOM_REQUIRED');
  return utility.evaluateExpression(reader.toString(), { isFunction: true }, owner ? impl : arg);
}
// Observe cached worlds only. Do not request a context, evaluate in MAIN, or expose a context identity.
function existingExecutionWorlds(frame) {
  let impl;
  try { impl = frame?._connection?.toImpl?.(frame); } catch { /* fixed availability only */ }
  const presence = world => {
    try {
      if (typeof impl?.existingContext !== 'function') return 'unavailable';
      return impl.existingContext(world) == null ? 'absent' : 'present';
    } catch { return 'unavailable'; }
  };
  return { main: presence('main'), utility: presence('utility') };
}
const schemeOf = frame => {
  // URL comes from the trusted protocol-backed frame, never page JavaScript, and is reduced before returning.
  const url = frame.url(), scheme = typeof url === 'string' ? /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() : undefined;
  return choice(scheme, ['http', 'https', 'file', 'about', 'data', 'blob', 'vscode-file', 'vscode-webview'], 'other');
};

export async function captureFixtureObservation(args) {
  let expired = false, timer;
  // A timeout does not cancel or detach the read: the original registry task retains its queue/guard and is collected
  // by pages.endTurn. Pending means the caller must stop; only that normal cleanup can prove the read settled.
  const capture = captureOwnedFixtureObservation(args, () => expired);
  const deadline = new Promise(resolve => { timer = setTimeout(() => {
    expired = true;
    resolve({ ok: false, code: 'ELECTRON_FIXTURE_CAPTURE_PENDING', stage: 'deadline', pending: true });
  }, 3000); });
  try { return await Promise.race([capture, deadline]); }
  finally { clearTimeout(timer); }
}

async function captureOwnedFixtureObservation({ turn, currentTurn, tab, fixtureName } = {}, expired) {
  let stage = 'input';
  const refusal = code => ({ ok: false, code, stage });
  if (!names.has(fixtureName) || typeof tab !== 'string' || tab.length > 128 || !tab) return refusal('ELECTRON_FIXTURE_INPUT_REFUSED');
  if (!turn || typeof currentTurn !== 'function') return refusal('ELECTRON_FIXTURE_TURN_REFUSED');
  const connection = turn.connection, pages = connection?.pages, provider = connection?.provider, grant = connection?.grant, targets = connection?.targets;
  const session = provider?.session;
  let expected;
  const sameEntry = entry => entry && entry === expected.entry && entry.page === expected.page && entry.targetId === expected.targetId && entry.epoch === expected.epoch &&
    entry.window?.id === expected.windowId && entry.window?.epoch === expected.windowEpoch && entry.joinNo === expected.joinNo &&
    !entry.parked && !entry.released && !entry.releasing && !entry.revoked && !entry.page.isClosed() &&
    targets.current(entry.targetId, entry.epoch) === true;
  const assertCurrent = () => {
    if (expired()) fail('ELECTRON_FIXTURE_CAPTURE_EXPIRED');
    if (currentTurn() !== turn || turn.connection !== connection || connection.pages !== pages || connection.provider !== provider ||
        connection.grant !== grant || connection.targets !== targets || provider.session !== session || grant.current() !== true) fail('ELECTRON_FIXTURE_IDENTITY_CHANGED');
    if (expected && !sameEntry(pages.tab(tab))) fail('ELECTRON_FIXTURE_IDENTITY_CHANGED');
  };
  const verify = async () => {
    assertCurrent();
    if (await provider.verifyConnection(session) !== true) fail('ELECTRON_FIXTURE_IDENTITY_CHANGED');
    assertCurrent();
  };
  try {
    stage = 'identity-pre';
    await verify();
    return await pages.enqueue(tab, async entry => {
      expected = { entry, page: entry.page, targetId: entry.targetId, epoch: entry.epoch, windowId: entry.window?.id, windowEpoch: entry.window?.epoch, joinNo: entry.joinNo };
      if (!sameEntry(entry)) fail('ELECTRON_FIXTURE_IDENTITY_CHANGED');
      await verify();
      stage = 'guard';
      const captured = await pages.guard(entry, async () => {
        await verify();
        stage = 'capture';
        const allFrames = entry.page.frames();
        if (!Array.isArray(allFrames) || !allFrames.length || allFrames.length > 16) fail('ELECTRON_FIXTURE_FRAME_LIMIT');
        const frames = [];
        for (const [ordinal, frame] of allFrames.entries()) {
          assertCurrent();
          if (frame.isDetached()) fail('ELECTRON_FIXTURE_IDENTITY_CHANGED');
          const parent = frame.parentFrame(), parentOrdinal = parent === null ? null : allFrames.indexOf(parent);
          if (parentOrdinal === -1) fail('ELECTRON_FIXTURE_IDENTITY_CHANGED');
          const worldsBefore = existingExecutionWorlds(frame);
          let owner = null, ownerStatus = parent === null ? 'root' : 'unavailable';
          if (parent !== null) {
            let handle;
            try {
              handle = await frame.frameElement();
              owner = metadata(await utilityRead(handle, observeFixtureOwner, undefined, true));
              ownerStatus = 'captured';
            } catch { /* fixed acquisition status only */ }
            finally { if (handle) await handle.dispose(); }
          }
          assertCurrent();
          let raw, captureStatus = 'captured', captureCode = null;
          try { raw = await utilityRead(frame, observeFixtureDocument, fixtureName); }
          catch (error) { captureStatus = 'unavailable'; captureCode = error?.message === 'TRUSTED_DOM_REQUIRED' ? 'utility-world-unavailable' : 'capture-failed'; }
          const worldsAfter = existingExecutionWorlds(frame);
          assertCurrent();
          if (frame.isDetached()) fail('ELECTRON_FIXTURE_IDENTITY_CHANGED');
          const rawEditors = raw === undefined ? [] : field(raw, 'editors');
          if (!Array.isArray(rawEditors) || rawEditors.length > 64) fail('ELECTRON_FIXTURE_CAPTURE_FAILED');
          frames.push({ ordinal, parentOrdinal, scheme: schemeOf(frame), owner, ownerStatus, captureStatus, captureCode,
            executionWorlds: { before: worldsBefore, after: worldsAfter },
            textboxCount: count(field(raw, 'textboxCount')), matchedCount: count(field(raw, 'matchedCount')),
            selectedFixtureTab: bool(field(raw, 'selectedFixtureTab')), activeFixtureEditor: field(raw, 'activeFixtureEditor') === true,
            truncated: field(raw, 'truncated') === true, editors: rawEditors.map(metadata) });
        }
        stage = 'identity-post';
        await verify();
        const afterFrames = entry.page.frames();
        if (allFrames.length !== afterFrames.length || allFrames.some((frame, i) => frame !== afterFrames[i] || frame.isDetached() ||
            frame.parentFrame() !== (frames[i].parentOrdinal === null ? null : allFrames[frames[i].parentOrdinal]))) fail('ELECTRON_FIXTURE_IDENTITY_CHANGED');
        return frames;
      });
      stage = 'identity-post';
      await verify();
      return { ok: true, complete: captured.every(frame => frame.captureStatus === 'captured' && frame.ownerStatus !== 'unavailable'),
        fixtureName, frameCount: captured.length, textboxCount: captured.reduce((sum, frame) => sum + frame.textboxCount, 0),
        matchedCount: captured.reduce((sum, frame) => sum + frame.matchedCount, 0),
        selectedFixtureTab: captured.some(frame => frame.selectedFixtureTab === true) ? true : captured.some(frame => frame.selectedFixtureTab === false) ? false : null,
        activeFixtureEditor: captured.some(frame => frame.activeFixtureEditor), truncated: captured.some(frame => frame.truncated), frames: captured };
    }, { mutation: false });
  } catch (error) {
    const safe = ['ELECTRON_FIXTURE_IDENTITY_CHANGED', 'ELECTRON_FIXTURE_FRAME_LIMIT', 'ELECTRON_FIXTURE_CAPTURE_FAILED'];
    return refusal(safe.includes(error?.message) ? error.message : stage === 'capture' ? 'ELECTRON_FIXTURE_CAPTURE_FAILED' : 'ELECTRON_FIXTURE_GUARD_REFUSED');
  }
}
