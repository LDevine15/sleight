// FowlBrowser names the cover and the next step (mcp/src/tools.mjs:605-629) instead of
// leaving a raw timeout. Same idea for the engine's tab errors in /tmp/fb-rounds
// events.jsonl: one line saying whether input was sent, and the exact next call.

import { rewriteLocatorFailure } from './locator-errors.mjs';

const READ = 'await tab.getAXState({ disableDiffing: true })';
const DIALOG = 'const dialog = await tab.getJsDialog(); if (dialog) { await dialog.dismiss(); }';
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

export function rewriteTabError(text, { read = false } = {}) {
  if (typeof text !== 'string') return text;
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
    } else out.push(rewriteLine(lines[i], read));
  }
  const write = evaluateWriteAdvice(text);
  if (write) out.push(write);
  else if (/^TypeError: Cannot read properties of (?:null|undefined)\b/m.test(text) &&
      /^\s+at __playwrightEvaluate\b/m.test(text)) {
    out.push('The page scope is read-only; element ids are not globals, and document.querySelector returns null when nothing matches. Check the element before reading its properties.');
  }
  return out.join('\n');
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

function rewriteLine(text, read) {
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
      return `CDP command ${command} timed out after ${cdp[1]}ms; the input may already have been sent. Next: ${DIALOG} Read the page before retrying input: ${READ}.`;
    }
    const input = /^Emulation\./.test(command) ? 'this command sent no input' : 'whether this command sent input is unknown';
    if (/^Emulation\./.test(command)) {
      return `CDP command ${command} timed out after ${cdp[1]}ms; ${input}. Next: ${DIALOG} An open page dialog may be blocking the command. ${read ? 'Re-read after the dialog is handled.' : 'Read the page before retrying input; do not retry the timed-out call.'}`;
    }
    return `CDP command ${command} timed out after ${cdp[1]}ms; ${input}. Next: ${READ} (do not retry the timed-out call).`;
  }
  if (/^(?:Error: )?(?:CDP operation exceeded its deadline\b|Timed out after \d+ms waiting for selector .+: CDP operation exceeded its deadline\b)/.test(text)) {
    return `${text}; this action sent no input. Next: ${READ}.`;
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
