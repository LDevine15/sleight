// FowlBrowser names the cover and the next step (mcp/src/tools.mjs:605-629) instead of
// leaving a raw timeout. Same idea for the engine's tab errors in /tmp/fb-rounds
// events.jsonl: one line saying whether input was sent, and the exact next call.

import { rewriteLocatorFailure } from './locator-errors.mjs';

const READ = 'await tab.getAXState({ disableDiffing: true })';
const DIALOG = 'nodeRepl.write((await tab.getJsDialog()) ?? "No page dialog")';
const CONFIRM = /^(?:Error: )?Browser action "([^"]+)" interrupted by JavaScript (confirm|alert|prompt|beforeunload): (.*)$/;
const LEGACY = /^(?:The action may already have taken effect; do not retry it\.(?: Inspect or dismiss the dialog before continuing\.)?|Inspect or dismiss the dialog before continuing\.)$/;
export const EVALUATE_ACTION = Object.freeze({
  drag: 'sleight.dragTo(tab, from, to)', fill: 'locator.fill(...)', click: 'locator.click()',
  select: 'selectOption(...)', check: 'locator.setChecked(...)',
  read: 'await tab.getAXState()',
});
const { drag: DRAG, fill: FILL, select: SELECT, check: CHECK } = EVALUATE_ACTION;
export const EVALUATE_WRITE = [
  [/\binsertBefore is not a function/, 'insertBefore', DRAG],
  [/\bappendChild is not a function/, 'appendChild', DRAG],
  [/\bremoveChild is not a function/, 'removeChild', DRAG],
  [/\breplaceChild is not a function/, 'replaceChild', DRAG],
  [/\bcreateEvent is not a function/, 'createEvent'],
  [/\bdispatchEvent is not a function/, 'dispatchEvent'],
  [/DragEvent is not a constructor/, 'DragEvent', DRAG],
  [/DataTransfer is not a constructor/, 'DataTransfer', DRAG],
  [/CustomEvent is not a constructor/, 'CustomEvent'],
  [/PointerEvent is not a constructor/, 'PointerEvent'],
  [/MouseEvent is not a constructor/, 'MouseEvent'],
  [/KeyboardEvent is not a constructor/, 'KeyboardEvent'],
  [/\bEvent is not a constructor/, 'Event'],
  [/Cannot set property (selectedIndex|selected)\b/, 'setting $1', SELECT],
  [/Cannot set property (value)\b/, 'setting $1', FILL],
  [/Cannot set property (checked)\b/, 'setting $1', CHECK],
  [/Cannot set property (innerHTML|textContent|className)\b/, 'setting $1'],
  [/Cannot set property (scrollTop|scrollLeft)\b/, 'setting $1'],
  [/Cannot add property (on\w+)\b/, 'assigning $1'],
];

export function rewriteTabError(text, { read = false, code = '' } = {}) {
  if (typeof text !== 'string') return text;
  const blocked = browserBlockedAdvice(text);
  if (blocked) return text + ' ' + blocked;
  text = rewriteLocatorFailure(text);
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const confirm = CONFIRM.exec(lines[i].trim());
    if (confirm) {
      let message = confirm[3].replace(/\s+The action may already[\s\S]*$/, '').trim();
      // The engine's warning terminates a multiline message. Without that boundary,
      // keep following lines as caller output rather than guessing the message length.
      const end = lines.findIndex((line, index) => index > i && LEGACY.test(line.trim()));
      if (end !== -1 && message === confirm[3].trim()) {
        message += lines.slice(i + 1, end).map(line => '\n' + line).join('');
        i = end;
        while (LEGACY.test(lines[i + 1]?.trim() ?? '')) i++;
      }
      const accept = confirm[2] === 'prompt' ? 'await dialog.accept(text) or await dialog.dismiss()' :
        confirm[2] === 'confirm' ? 'await dialog.accept() or await dialog.dismiss()' : 'await dialog.dismiss()';
      out.push(`Browser action "${confirm[1]}" interrupted by JavaScript ${confirm[2]}: ${message} Input may already have been sent; do not retry the ${confirm[1]}. Next: const dialog = await tab.getJsDialog(); if (dialog) { ${accept}; }`);
    } else out.push(rewriteLine(lines[i], read, i === 0));
  }
  const write = evaluateWriteAdvice(text);
  if (write) out.push(write);
  else if (/^TypeError: Cannot read properties of (?:null|undefined)\b/m.test(text) &&
      /^\s+at __playwrightEvaluate\b/m.test(text)) {
    out.push('The page scope is read-only; element ids are not globals, and document.querySelector returns null when nothing matches. Check the element before reading its properties.');
  }
  const shape = inputShapeAdvice(text, code, out.join('\n'));
  const rewritten = shape ? out.join('\n') + ' ' + shape : out.join('\n');
  if (/^(?:Error: )?Browser Use rejected this action due to browser security policy\.(?:\n|$)/.test(text)) {
    return rewritten + '\nPermission or security policy refused this operation. Keep the action stopped. The user must decide whether to continue with an allowed operation. Do not retry or change permissions. Read-only inventory: await cua.listBrowsers().';
  }
  if (/^(?:Error: )?[\w -]{1,40} requested permissions to use a tool, but you haven't granted it yet\.(?:\n|$)/.test(text)) {
    return rewritten + '\nTool permission has not been granted. Keep the action stopped. The user must decide whether to grant permission in a later request.';
  }
  return rewritten;
}

function inputShapeAdvice(text, code, rewritten) {
  const first = text.split('\n')[0];
  const selectors = 'App selectors use cua.getApp(bundleId). Tab selectors use cua.getTab(tabId, { browser: browserId }) with a string tabId.';
  if (/^(?:(?:Type)?Error: )?Cannot use 'in' operator to search for 'mention' in /.test(first) && /\bcua\s*\.\s*getTab\s*\(/.test(code)) {
    return `${selectors} Next: await cua.listTabs(); bind an explicitly chosen or previously observed tab before reading its indices.`;
  }
  if (!/^(?:Error: )?(?:Browser input requires an element index|Accessibility action requires an element index or point|Accessibility element \d+ is stale or missing|Accessibility capture belongs to a previous page)/.test(first)) return;
  const read = rewritten.includes('.getAXState(') ? '' : ' Next: await tab.getAXState({ disableDiffing: true }).';
  return `Use a current numeric element index (a nonnegative integer) for indexed tab input. Click and scroll also accept documented [x, y] points; null is only the focus form for tab text and key input. App text and key calls omit the tab index. ${selectors}${read} Do not guess an index or retry the refused input automatically.`;
}

function browserBlockedAdvice(text) {
  const first = text.split('\n')[0];
  const extension = /^(?:Error: )?Automation is blocking automation because another extension UI is open\.$/.test(first);
  const client = /^(?:Error: )?(?:page\.goto: )?net::ERR_BLOCKED_BY_CLIENT(?: at \S+)?$/.test(first);
  if (!extension && !client) return;
  const reason = extension ? 'An extension UI is blocking browser automation. The owner must clear that UI before continuing.'
    : 'Navigation was blocked by the client. Its cause is unconfirmed. The owner must review the block before continuing.';
  return `${reason} Next read, if available: await cua.listTabs(). Do not retry the refused call or change another session.`;
}

export function evaluateWriteAdvice(text) {
  if (!/^\s+at __playwrightEvaluate\b/m.test(text)) return;
  const head = text.split('\n').find(line => /TypeError:/.test(line))?.trim();
  if (!head || !/^(?:Error: )?TypeError:/.test(head)) return;
  const nonextensible = /Cannot add property (fetch|draggable|cssText), object is not extensible\b/.exec(head);
  if (nonextensible) return `The evaluate page scope is read-only. If this was a page object, assigning ${nonextensible[1]} cannot run there. Read the controls with ${EVALUATE_ACTION.read}.`;
  for (const [pattern, operation, next] of EVALUATE_WRITE) {
    const match = pattern.exec(head);
    if (!match) continue;
    return `If this call meant to change the page, ${operation.replace(/\$1/g, match[1] ?? '')} cannot run in evaluate.${next ? ` Next: ${next}.` : ''}`;
  }
}

export function isTabBinding(code = '') {
  // Error wording only. Read-only when the raw text names no action call; a string or
  // comment that merely mentions one makes the answer uncertain.
  const source = String(code).replace(/\[\s*["'](\w+)["']\s*\]/g, '.$1');
  return !/\b(?:click|dblclick|fill|type|press|pressSequentially|pressKey|setValue|typeText|paste|scroll|selectText|selectOption|setChecked|check|uncheck|drag|dragTo|performSecondaryAction|goto|reload|downloadMedia|dispatchEvent|clear|htmlDrag|back|forward|scrollIntoViewIfNeeded|fillForm|pickFromList|reorder|accept|dismiss|close)\s*(?:\?\.)?\s*\(/.test(source);
}

function rewriteLine(text, read, firstLine) {
  const reset = firstLine && /^(?:Error: )?(?:js|JavaScript) execution timed out(?: after (\d+)ms)?;\s*kernel reset\b/i.exec(text);
  if (reset) {
    return `${text}. JavaScript execution timed out ${reset[1] ? 'after ' + reset[1] + 'ms' : '(duration not reported)'}. The input outcome is unknown after the reported kernel reset. Do not rerun the failed action. Next: await cua.listTabs(); rebind only a previously observed session tab with await cua.getTab(tabId, { browser: browserId }) and read it before input.`;
  }
  const covered = /Accessibility element (\d+) is covered by (\S+) or otherwise not hittable/.exec(text);
  if (covered) {
    return `Accessibility element ${covered[1]} is covered by ${covered[2]}; this action sent no input. Next: ${READ} and click the covering control, or dismiss it.`;
  }
  const stale = /Accessibility element (\d+) is stale or missing/.exec(text);
  if (stale) {
    return `Accessibility element ${stale[1]} is stale or missing; this action sent no input. Next: ${READ} and use a fresh index or a locator.`;
  }
  const cdp = /(?:^Error: )?Timed out after (\d+)ms waiting for CDP command (\S+?)\.?$/.exec(text.trim());
  if (cdp) {
    const command = cdp[2].replace(/\.$/, '');
    if (/^Input\./.test(command)) {
      return `CDP command ${command} timed out after ${cdp[1]}ms; the input may already have been sent. A dialog is not confirmed by this timeout. Inspect with ${DIALOG}. Read the page before retrying input: ${READ}.`;
    }
    const input = /^Emulation\./.test(command) ? 'this command sent no input' : 'whether this command sent input is unknown';
    if (/^Emulation\./.test(command)) {
      return `CDP command ${command} timed out after ${cdp[1]}ms; ${input}. Next: ${DIALOG}. An open page dialog may be blocking the command. ${read ? 'Re-read after the dialog is handled.' : 'Read the page before retrying input; do not retry the timed-out call.'}`;
    }
    return `CDP command ${command} timed out after ${cdp[1]}ms; ${input}. Next: ${READ} (do not retry the timed-out call).`;
  }
  if (/^(?:Error: )?(?:CDP operation exceeded its deadline\b|Timed out after \d+ms waiting for selector .+: CDP operation exceeded its deadline\b)/.test(text)) {
    const beforeDispatch = /before command dispatch\b/.test(text);
    return `${text}; ${beforeDispatch ? 'this action sent no input' : 'the input outcome is unknown'}${/\d+ms/.test(text) ? '' : '; duration not reported'}. Next: ${READ}.${beforeDispatch ? '' : ' Do not retry the timed-out action before reading the page.'}`;
  }
  const download = /^(?:Error: )?Timed out after (\d+)ms (?:downloading media|waiting for download)\.?$/.exec(text.trim());
  if (download) {
    return `Download timed out after ${download[1]}ms; if a tab.click on the link came earlier, it can stall later downloads in that tab. Next: const fresh = await cua.createBrowserTab(b.browserId, await tab.url()); await fresh.playwright.locator('<download link>').downloadMedia({}).`;
  }
  const debuggerError = /^(?:Error: )?(Debugger unattached(?: \([^()\n]+\))?)\.?$/.exec(text.trim());
  if (debuggerError) {
    return `${debuggerError[1]}; ${read ? 'no input was sent' : "this call's input may already have been sent"}. Next: re-bind with await cua.getTab(id, { browser }), or await cua.createBrowserTab(browser, url); read the page before retrying an action.`;
  }
  return text;
}
