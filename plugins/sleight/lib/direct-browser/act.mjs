// Independent implementation informed by FowlBrowser (MIT), pinned 8b68924:
// request-before-input watching and short Playwright actionability timeouts.
// No upstream source copied. All browser input stays on the owned Playwright page.
import { stageUserUploads } from './files.mjs';
import { isV3Context } from './v3-context.mjs';
import { intent, keyClass } from './rules.mjs';
import { trustedLocatorRead } from './trusted-dom.mjs';
import { endpointURL, endpointBlock } from './endpoint-guard.mjs';
const OPS = new Set('click type press select check uncheck hover scroll drag upload dialog wait back forward reload viewport'.split(' '));
const REF_OPS = new Set('click type select check uncheck hover drag upload'.split(' '));
const TIMEOUT = 1000;
const pendingInputs = new WeakMap();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clean = value => String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 240);
const refOf = value => typeof value === 'string' && /^(?:f\d+)?e\d+$/.test(value) ? value : null;
async function bounded(task, ms) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('action still pending after its deadline')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function validate(steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > 12) throw Error('steps needs 1 to 12 operations');
  for (const s of steps) {
    if (!s || !OPS.has(s.do)) throw Error('unsupported do operation');
    const needs = name => { throw Error(s.do + ' needs ' + name); };
    if (REF_OPS.has(s.do) && !refOf(s.ref)) needs('ref');
    if (s.ref !== undefined && !refOf(s.ref)) needs('a valid ref');
    if (s.do === 'type' && typeof s.text !== 'string') needs('text');
    if (s.do === 'press' && (typeof s.key !== 'string' || !s.key.trim() || s.key.length > 100)) needs('key');
    if (s.do === 'select' && (!Array.isArray(s.values) || !s.values.length || s.values.some(v => typeof v !== 'string'))) needs('values');
    if (s.do === 'drag' && !refOf(s.to)) needs('to');
    if (s.do === 'upload' && (!Array.isArray(s.paths) || !s.paths.length || s.paths.some(p => typeof p !== 'string' || !p))) needs('paths');
    if (s.do === 'dialog' && typeof s.accept !== 'boolean') needs('accept');
    if (s.do === 'viewport' && ![s.width, s.height].every(n => Number.isInteger(n) && n >= 100 && n <= 10000)) needs('width and height between 100 and 10000');
    if (s.do === 'scroll') {
      if (s.until !== undefined && (typeof s.until !== 'string' || !s.until.trim() || s.until.length > 500)) needs('until text');
      if ([s.dx, s.dy].some(n => n !== undefined && (!Number.isFinite(n) || Math.abs(n) > 10000))) needs('finite dx and dy up to 10000');
    }
  }
}

// Only risk classification and a comparison fingerprint cross this boundary.
// Form values never enter an outcome line or a snapshot through this reader.
export function inspectTarget(el, unused, read = (node, key) => { const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value; }) {
  const words = node => [read(node, 'getAttribute')('aria-label'), read(node, 'textContent'), read(node, 'getAttribute')('value')].filter(Boolean).join(' ');
  const payment = text => /\b(?:pay|payment|purchase|buy|checkout|donate|subscribe|place order|complete order|order now|book now|upgrade|send money|charge)\b/i.test(text);
  const associated = read(el, 'form');
  const form = associated === undefined ? read(el, 'closest')('form') : associated, tag = read(el, 'localName'), role = read(el, 'getAttribute')('role'), name = words(el).trim().slice(0, 100);
  const button = tag === 'button' || tag === 'input' && /^(?:button|submit|image)$/.test(read(el, 'type')) || role === 'button';
  const formPayment = !!form && [...read(form, 'querySelectorAll')('input,button,iframe')].some(node =>
    /^cc-/i.test(read(node, 'getAttribute')('autocomplete') ?? '') || /(?:card|cc[-_ ]?(?:number|csc)|cvv|cvc)/i.test(read(node, 'id') + ' ' + read(node, 'getAttribute')('name')) ||
    read(node, 'localName') === 'iframe' || (read(node, 'localName') === 'button' || read(node, 'type') === 'submit') && payment(words(node)));
  const submit = !!(button && (read(el, 'type') === 'submit' && form || /\b(?:save|submit|send|confirm|book|pay|place order|finish|complete)\b/i.test(name) || payment(name)));
  let hash = 2166136261;
  if (form) {
    const content = read(form, 'textContent') + [...read(form, 'querySelectorAll')('input,select,textarea')].map(n => [read(n, 'value'), read(n, 'checked'), read(n, 'selectedIndex')].join(':')).join('|');
    for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
  }
  return { name, tag, role, kind: button ? 'button' : ['file', 'color'].includes(read(el, 'type')) ? read(el, 'type') : tag === 'select' ? 'select' : 'text', button, form: !!form, submit, payment: payment(name) || submit && formPayment,
    formPayment, formSignature: form ? hash : null };
}

function scrollPoint(el) {
  const r = el.getBoundingClientRect();
  return { x: Math.max(1, Math.min(innerWidth - 1, r.x + r.width / 2)), y: Math.max(1, Math.min(innerHeight - 1, r.y + r.height / 2)) };
}

function coverDetails(el) {
  const r = el.getBoundingClientRect(); let hit = el.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  while (hit?.shadowRoot?.elementFromPoint) { const next = hit.shadowRoot.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); if (!next || next === hit) break; hit = next; }
  if (!hit || hit === el || el.contains(hit)) return null;
  const root = hit.closest('[role="dialog"],dialog,[aria-modal="true"]') ?? hit;
  return { name: (root.getAttribute('aria-label') || root.innerText || root.localName).slice(0, 100),
    buttons: [...root.querySelectorAll('button,[role="button"],input[type="button"]')].slice(0, 6)
      .map(n => (n.getAttribute('aria-label') || n.innerText || n.value || '').slice(0, 80)) };
}

function watch(page, state) {
  const pending = new Set(), completed = new Set(), listeners = []; let boundary, dialogResolve, stopped = false;
  const dialogReady = new Promise(resolve => { dialogResolve = resolve; });
  const stop = () => { stopped = true; for (const [event, fn] of listeners) page.off(event, fn); };
  const on = (event, fn) => {
    const listener = (...args) => { if (!stopped) fn(...args); };
    page.on(event, listener); listeners.push([event, listener]);
  };
  on('request', r => { if (['document', 'xhr', 'fetch', 'script', 'stylesheet'].includes(r.resourceType())) pending.add(r); });
  on('requestfinished', r => { if (pending.delete(r)) completed.add(r); });
  on('requestfailed', r => { pending.delete(r); });
  on('framenavigated', frame => { if (frame === page.mainFrame()) boundary = { kind: 'navigation' }; });
  on('load', () => { boundary ??= { kind: 'document' }; });
  on('dialog', dialog => { state.dialog = dialog; boundary = { kind: 'dialog', dialog }; dialogResolve(boundary); });
  on('popup', popup => { boundary = { kind: 'popup', popup }; });
  on('close', () => { boundary = { kind: 'close' }; state.dialog = null; stop(); });
  return { pending, completed, dialogReady, get boundary() { return boundary; },
    stop };
}

function pendingGate(state, step) {
  if (state.actionPending && step.do !== 'dialog') throw Error('an earlier input is still pending; wait for it before more input');
  if (step.do === 'dialog' && [...pendingInputs.get(state)?.tokens ?? []].some(token => token.dialog === state.dialog))
    throw Error('the dialog answer is still pending; wait for it before another answer');
}

function ownInput(state, dialog) {
  let bank = pendingInputs.get(state);
  if (!bank) { bank = { tokens: new Set(), external: !!state.actionPending }; pendingInputs.set(state, bank); }
  const token = { dialog }; bank.tokens.add(token); state.actionPending = true;
  return () => {
    bank.tokens.delete(token);
    state.actionPending = bank.external || bank.tokens.size > 0;
    if (!bank.tokens.size) pendingInputs.delete(state);
  };
}

function ruleMessage(result) {
  if (result === 'allow' || result?.verdict === 'allow' || result?.kind === 'allow') return null;
  if (result?.verdict === 'confirm' || result?.kind === 'confirm') return 'confirmation required through the trusted consent UI; use the engine browser path if needed';
  return clean(result?.message ?? result?.msg ?? 'rule check refused; read the page or use the engine browser path');
}

// Dependencies are the other v3 lanes' fixed interfaces. Injecting them keeps unit
// and host-runner tests independent while those modules are built in parallel.
export function createActionRunner({ check, snapshot, backgroundClick = (tab, locator, click) => click({}), actionTimeoutMs = 7000, now = Date.now, sleep = pause } = {}) {
  if (typeof check !== 'function' || typeof snapshot !== 'function') throw Error('action runner needs check and snapshot');
  return async function runSteps(tab, steps, ctx = {}) {
    validate(steps);
    const { page, state } = tab, since = state.snapshotNo > 0 ? state.snapshotNo : undefined, lines = []; let stoppedAt = null;
    let observed, observeError, confirmation, blocker;
    const read = async options => { const capturedAt = now(), result = await snapshot(page, options); observed = { ...result, capturedAt }; return observed; };
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index], label = `${index + 1} ${step.do}${step.ref ? ' ' + step.ref : ''}`;
      let locator, target, started = false, armed, staging, submit, inputPending = false, stepFinished = false;
      try {
        if (state.dialog && step.do !== 'dialog') throw Error('a page dialog is waiting; answer it with the dialog operation');
        if (step.do === 'dialog' && !state.dialog) throw Error('no waiting dialog; read the page');
        pendingGate(state, step);
        locator = step.ref ? page.getByRef(step.ref) : step.do === 'press' ? page.locator(':focus') : null;
        if (step.do === 'press' && !step.ref && !await locator.count()) locator = page.locator('body');
        let info = locator ? await trustedLocatorRead(locator, inspectTarget) : {};
        const enter = step.do === 'press' && !!keyClass(step.key).name;
        let submits = step.do === 'click' && info.submit || enter && (info.submit || info.form && keyClass(step.key).name === 'Enter');
        target = { ...info, element: info, page, locator, state, ref: step.ref, do: step.do, key: step.key,
          paths: step.paths, submit: !!submits, payment: !!submits && (info.payment || info.formPayment),
          ...(step.do === 'dialog' ? { type: state.dialog.type(), message: state.dialog.message(), accept: step.accept } : {}) };
        const trusted = isV3Context(ctx);
        const gate = async () => {
          const verdict = trusted ? await ctx.check(step.do, target) : await check(ctx, step.do, target);
          if (verdict?.verdict === 'confirm' || verdict?.kind === 'confirm') confirmation = { step: index + 1, terms: verdict.terms };
          const message = ruleMessage(verdict);
          if (message) throw Error(message);
          if (trusted && target.locator) locator = target.locator;
          if (trusted) submits = intent(step.do, target).submit && step.do !== 'dialog';
          if (submits) {
            submit = { startedAt: now(), snapshotNo: state.snapshotNo ?? 0 };
            state.submitUnconfirmed = submit;
          }
        };
        // Pin the element before popup preparation. Check final risk and consume
        // authority inside the actual click callback, after that preparation.
        if (trusted && locator) { await ctx.prepareTarget(target); locator = target.locator; }
        if (!trusted) await gate();
        if (step.do === 'upload') {
          if (trusted) await gate();
          staging = trusted ? await ctx.stageUploads(target, step.paths) : await stageUserUploads(ctx.files, step.paths, step.ref);
          if (!Array.isArray(staging?.payloads) || !staging.payloads.length) throw Error('user-named file staging required');
        }
        armed = watch(page, state); const start = now();
        const options = { timeout: TIMEOUT };
        const perform = async () => {
          if (step.do === 'click') return backgroundClick(tab, locator, async extra => {
            if (trusted) { await gate(); ctx.beginInput(target); }
            started = true; return locator.click({ ...options, ...extra });
          });
          if (trusted && step.do !== 'upload') { await gate(); ctx.beginInput(target); }
          started = true;
          if (step.do === 'type') return locator.fill(step.text, options);
          if (step.do === 'press') return trusted ? ctx.pressTarget(target, step.key, options) : step.ref ? locator.press(step.key, options) : page.keyboard.press(step.key);
          if (step.do === 'select') return locator.selectOption(step.values, options);
          if (step.do === 'check') return locator.check(options);
          if (step.do === 'uncheck') return locator.uncheck(options);
          if (step.do === 'hover') return locator.hover(options);
          if (step.do === 'drag') return trusted ? ctx.dragTo(target, page.getByRef(step.to)) : locator.dragTo(page.getByRef(step.to), options);
          if (step.do === 'upload') return locator.setInputFiles(staging.payloads, options);
          if (step.do === 'viewport') return page.setViewportSize({ width: step.width, height: step.height });
          if (step.do === 'back') return page.goBack({ ...options, waitUntil: 'commit' });
          if (step.do === 'forward') return page.goForward({ ...options, waitUntil: 'commit' });
          if (step.do === 'reload') return page.reload({ ...options, waitUntil: 'commit' });
          if (step.do === 'dialog') {
            const dialog = state.dialog;
            if (step.accept) await dialog.accept(step.text); else await dialog.dismiss();
            if (state.dialog === dialog) state.dialog = null; return;
          }
          if (step.do === 'wait') {
            if (locator) return locator.waitFor({ ...options, state: 'visible' });
            await sleep(100); return;
          }
          if (step.do === 'scroll') {
            const end = now() + 4000, dx = step.dx ?? 0, dy = step.dy ?? 500;
            if (locator) { await locator.scrollIntoViewIfNeeded(options); const point = await locator.evaluate(scrollPoint); await page.mouse.move(point.x, point.y); }
            for (let n = 0; n <= (step.until ? 60 : 1); n++) {
              if (step.until) {
                const result = await read({ ref: step.ref, find: step.until, maxChars: 2000 });
                const row = result.text.split('\n').find(line => line.toLocaleLowerCase().includes(step.until.toLocaleLowerCase()) && /\[ref=/.test(line));
                if (row) return 'found ' + clean(row);
                if (n === 60 || now() >= end || armed.boundary) return 'text not found within 60 wheel steps or 4 s; read the list';
              } else if (n === 1) return;
              await page.mouse.wheel(dx, dy); await sleep(16);
            }
          }
        };
        pendingGate(state, step);
        // A Playwright click can remain pending until a page dialog is answered.
        // Returning the dialog stops the batch; the pending promise is observed,
        // never resent, and finishes after a later explicit dialog action.
        const releaseInput = ownInput(state, step.do === 'dialog' ? state.dialog : undefined);
        inputPending = true;
        const performed = perform().finally(() => {
          inputPending = false; releaseInput();
          if (stepFinished) armed.stop();
        });
        const result = await bounded(Promise.race([performed, armed.dialogReady]), actionTimeoutMs);
        let formChanged = false;
        const settleUntil = start + (submits ? 5000 : 600);
        while (!armed.boundary && now() < settleUntil) {
          if (submits && locator) {
            formChanged = (await trustedLocatorRead(locator, inspectTarget)).formSignature !== info.formSignature;
          }
          if ((submits && (formChanged || armed.completed.size)) || (!submits && armed.completed.size && !armed.pending.size)) break;
          await sleep(Math.min(50, settleUntil - now()));
        }
        const boundary = armed.boundary;
        if (boundary?.kind === 'dialog') state.dialog = boundary.dialog;
        if (submit && state.submitUnconfirmed === submit) {
          if (boundary?.kind === 'navigation' || boundary?.kind === 'document' || formChanged || armed.completed.size) state.submitUnconfirmed = false;
          else submit.settledAt = now();
        }
        const outcome = boundary?.kind === 'navigation' ? 'navigated to ' + clean(page.url()) + ' (new page below)'
          : boundary?.kind === 'document' ? 'new document (read below)'
          : boundary?.kind === 'dialog' ? `dialog ${clean(boundary.dialog.type())} "${clean(boundary.dialog.message())}" is waiting`
          : boundary?.kind === 'popup' ? endpointURL(boundary.popup.url(), tab.endpoint) ? endpointBlock : boundary.popup.isClosed() ? 'opened background tab that closed itself; opener below'
            : 'opened background tab with its opener: ' + clean(boundary.popup.url())
          : boundary?.kind === 'close' ? 'tab closed'
          : typeof result === 'string' ? result
          : submits && state.submitUnconfirmed ? 'submit unconfirmed after 5 s; read before resubmitting'
          : formChanged ? 'form changed' : armed.completed.size ? 'request finished; page below' : 'input sent; observation below';
        lines.push(label + ': ' + outcome);
        if (boundary) { stoppedAt = index + 1; break; }
      } catch (error) {
        if (started && submit && state.submitUnconfirmed === submit) submit.settledAt = now();
        let detail = step.do === 'upload' && started ? 'upload did not finish; inspect the control before retrying' : String(error.message);
        for (const value of [step.text, ...step.values ?? [], ...step.paths ?? []]) if (typeof value === 'string' && value) detail = detail.replaceAll(value, '[redacted]');
        detail = clean(detail);
        if (/intercepts pointer events/i.test(error.message) && locator) {
          try {
            const cover = await locator.evaluate(coverDetails, undefined, { timeout: 250 });
            if (cover) {
              detail = `covered by ${clean(cover.name)}; buttons: ${cover.buttons.map(clean).join(', ')}; dismiss the cover first`;
              blocker = await read({ find: cover.buttons[0] || cover.name, maxChars: 2000 });
            }
          } catch {}
        }
        lines.push(label + ': ' + (started ? 'effect unconfirmed; read before retrying. ' : 'not run: ') + detail);
        stoppedAt = index + 1; break;
      } finally {
        stepFinished = true;
        if (isV3Context(ctx) && target) ctx.finishInput(target);
        // A deadline ends the call, not the underlying Playwright input. Keep
        // its dialog listener until that exact promise settles or the page closes.
        if (!inputPending) armed?.stop();
        try { await staging?.cleanup?.(); } catch { lines.push('Upload staging cleanup unavailable.'); }
        if (isV3Context(ctx) && target && !inputPending) await ctx.releaseTarget(target);
      }
    }
    if (stoppedAt !== null) for (let i = stoppedAt; i < steps.length; i++) lines.push(`${i + 1} ${steps[i].do}: not reached`);
    // Never turn a delivered input into a tool error because its observation
    // failed. The caller delivers this snapshot and records its number.
    if (!state.dialog && state.actionPending) lines.push('Read deferred: input still pending; wait for it before browser_read.');
    else if (!state.dialog) try { await read({ since, maxChars: 8000 }); } catch (error) { observeError = clean(error.message); }
    if (blocker && observed && observed !== blocker && !observed.text.includes(blocker.text)) observed.text += '\nBlocker controls (untrusted page content):\n' + blocker.text;
    if (observed) {
      const changed = observed.text.split('\n').filter(line => /^[+~-]\s/.test(line)).length;
      const detail = changed ? changed + ' lines changed (batch observation below)'
        : /no (?:visible )?changes?/i.test(observed.text) ? 'no visible change within 600 ms' : 'input sent; page below';
      for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace('input sent; observation below', detail);
    }
    if (observeError) lines.push('Read unavailable: ' + observeError + '; use browser_read before retrying.');
    return { lines, stoppedAt, observe: observed, ...(confirmation ? { confirmation } : {}) };
  };
}

let defaultRunner;
export async function runSteps(tab, steps, ctx) {
  if (!isV3Context(ctx)) throw Error('TRUSTED_TURN_REQUIRED');
  if (!defaultRunner) {
    const [{ check }, { snapshot }, { backgroundClick }] = await Promise.all([import('./rules.mjs'), import('./snapshot.mjs'), import('./page.mjs')]);
    defaultRunner = createActionRunner({ check, snapshot, backgroundClick });
  }
  return defaultRunner(tab, steps, ctx);
}
