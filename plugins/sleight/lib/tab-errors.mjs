// FowlBrowser names the cover and the next step (mcp/src/tools.mjs:605-629) instead of
// leaving a raw timeout. Same idea for the engine's tab errors in /tmp/fb-rounds
// events.jsonl: one line saying whether input was sent, and the exact next call.

const READ = 'await tab.getAXState({ disableDiffing: true })';
const DIALOG = 'const dialog = await tab.getJsDialog(); if (dialog) { await dialog.dismiss(); }';
const CONFIRM = /^(?:Error: )?Browser action "([^"]+)" interrupted by JavaScript (confirm|alert|prompt|beforeunload): (.*)$/;
const LEGACY = /^(?:The action may already have taken effect; do not retry it\.(?: Inspect or dismiss the dialog before continuing\.)?|Inspect or dismiss the dialog before continuing\.)$/;

export function rewriteTabError(text, { read = false } = {}) {
  if (typeof text !== 'string') return text;
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
  if (/^TypeError: Cannot read properties of (?:null|undefined)\b/m.test(text) &&
      /^\s+at __playwrightEvaluate\b/m.test(text)) {
    out.push('The page scope is read-only; element ids are not globals, and document.querySelector returns null when nothing matches. Check the element before reading its properties.');
  }
  return out.join('\n');
}

export function isTabBinding(code = '') {
  // Error wording only: binding and arbitrary reads send no input unless a known action is named.
  let templateAction = false;
  const source = code.replace(/\[\s*["'](\w+)["']\s*\]/g, '.$1')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, value => {
    if (value.startsWith('`')) templateAction ||= [...value.matchAll(/\$\{([\s\S]*?)\}/g)].some(m => !isTabBinding(m[1]));
    return ' ';
  });
  return !templateAction && !/\b(?:click|dblclick|fill|clear|type|typeText|press|pressKey|pressSequentially|drag|dragTo|htmlDrag|setValue|selectOption|check|uncheck|setChecked|goto|back|forward|reload|paste|performSecondaryAction|scroll|scrollIntoViewIfNeeded|selectText|fillForm|pickFromList|accept|dismiss|close|downloadMedia)\s*(?:\?\.)?\s*\(/.test(source);
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
      return `CDP command ${command} timed out after ${cdp[1]}ms; the input may already have been sent. Next: ${DIALOG} if a page dialog is open, otherwise ${READ}.`;
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
