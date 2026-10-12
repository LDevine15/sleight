// FowlBrowser's quickly (mcp/src/tools.mjs:601-646) names covered, disabled or
// hidden in one line. Keep the engine's diagnostics below the hint.

const READ = 'nodeRepl.write(await tab.playwright.domSnapshot())';
const ENGINE = [
  /^(?:Error: )?(?:Browser Use encountered an error interacting with this webpage: Error: )?strict mode violation:/,
  /^(?:Error(?: [^:\n]+)?: )?(?:Error: )?Playwright selector deadline exceeded/,
  /^(?:Error: )?Timed out after \d+ms (?:evaluating|waiting for) selector .+: (?:Playwright selector deadline exceeded|No element matched|Browser Use encountered)/,
  /^(?:(?:Error(?: [^:\n]+)?|click failed): )?(?:Error: )?Element does not receive pointer events/,
];

export function rewriteLocatorFailure(text) {
  if (typeof text !== 'string') return text;
  try {
    const lines = text.split('\n'), out = [];
    for (let i = 0; i < lines.length; i++) {
      const mark = engineMark(lines[i]);
      if (!mark) { out.push(lines[i]); continue; }
      let end = i;
      while (end + 1 < lines.length && isLocatorFollow(lines[end + 1], lines[end + 2])) end++;
      const block = lines.slice(i, end + 1).join('\n');
      out.push(locatorAdvice(block), block);
      i = end;
    }
    return out.join('\n');
  } catch {
    return text;
  }
}

function engineMark(line) {
  for (const pattern of ENGINE) {
    const match = pattern.exec(line);
    if (match) return true;
  }
}

function isLocatorFollow(line, next) {
  const text = line.trim();
  if (!text) return next !== undefined && isLocatorFollow(next);
  return /^(?:locator\.\w+(?:\([^)]*\))? failed for selector |waiting on \w+ for selector |Locator diagnostics: |\d+\) |Element does not receive pointer events|<[^>]+> intercepts the \w+|(?:Error: )?(?:Element is not (?:enabled|visible|editable)|\w+ is read-only))/.test(text);
}

function locatorAdvice(block) {
  const diag = parseDiag(block);
  const akas = [...block.matchAll(/aka (getBy\w+\(.+\))\s*$/gm)].map(match => match[1]);
  const strict = /strict mode violation: (.+?) resolved to (\d+) elements:/.exec(block);
  const failed = /locator\.(\w+)(?:\([^)]*\))? failed for selector (.+)/.exec(block);
  const waiting = /waiting on (\w+) for selector (.+)/.exec(block);
  const evaluating = /evaluating selector (.+?): Playwright selector deadline exceeded/.exec(block);
  const waitingSel = /waiting for selector (.+?): (?:Playwright selector deadline exceeded|No element matched|Browser Use encountered)/.exec(block);
  const action = diag?.action || failed?.[1] || waiting?.[1] || 'locator';
  const selector = diag?.locator || failed?.[2]?.trim() || waiting?.[2]?.trim()
    || evaluating?.[1] || waitingSel?.[1] || strict?.[1];
  const kind = cause(diag, block);
  const matches = describeMatches(diag, akas, selector).slice(0, 5);
  const target = quote(selector);
  const total = diag?.matchCount ?? strict?.[2] ?? matches.length;
  const causeText = kind === 'strict'
    ? `${action} ${target} matched ${total} elements${matches.length ? ': ' + matches.join('; ') : ''}`
    : kind === 'missing' ? `${action} ${target} is missing`
    : kind === 'hidden' ? `${action} ${target} is hidden`
    : kind === 'disabled' ? `${action} ${target} is disabled`
    : kind === 'readonly' ? `${action} ${target} is read-only`
    : kind === 'covered' ? `${action} ${target} is covered by ${coveringElement(block) || 'another element'}`
    : kind === 'matched' ? `${action} ${target}: the action failed after the element matched`
    : `${action} ${target} timed out`;
  return `${causeText}. Next: ${nextCall(kind)}.`;
}

function parseDiag(block) {
  const match = /Locator diagnostics: (\{.*\})/.exec(block);
  if (!match) return;
  try { return JSON.parse(match[1]); } catch { return; }
}

function cause(diag, block) {
  if (/strict mode violation/.test(block) || diag?.kind === 'multiple_matches' || diag?.matchCount > 1) return 'strict';
  if (diag?.kind === 'no_matches' || /No element matched selector/.test(block)) return 'missing';
  if (diag?.kind === 'no_visible_match') return 'hidden';
  const hit = Array.isArray(diag?.matches) ? diag.matches.find(Boolean) : undefined;
  if (/Element is not editable/.test(block)) return 'readonly';
  if (hit?.disabled || /Element is not enabled/.test(block)) return 'disabled';
  if (hit?.visible === false || /Element is not visible/.test(block)) return 'hidden';
  if (diag?.kind === 'intercepted' || coveringElement(block)) return 'covered';
  if (diag?.kind === 'action_failed' && hit) return 'matched';
  return 'timeout';
}

function describeMatches(diag, akas, selector) {
  const rows = Array.isArray(diag?.matches) ? diag.matches : [];
  const count = Math.min(5, Math.max(rows.length, akas.length));
  const out = [];
  for (let i = 0; i < count; i++) {
    const row = rows[i] || {};
    const name = row.ariaLabel || /name:\s*['"]([^'"]+)['"]/.exec(akas[i] || '')?.[1] || '';
    const role = row.role || impliedRole(row);
    const loc = akas[i] || locatorFor(row, i, selector, name, role);
    const visible = typeof row.visible === 'boolean' ? `visible:${row.visible}` : '';
    out.push([role, name && `"${name.replace(/\s+/g, ' ').trim().slice(0, 40)}"`, `via ${loc}`, visible].filter(Boolean).join(' '));
  }
  return out;
}

function impliedRole(row) {
  if (row.type === 'text' || row.type === 'email' || row.type === 'search') return 'textbox';
  if (row.tag === 'button' || row.type === 'submit' || row.type === 'button') return 'button';
  return row.tag || '';
}

function locatorFor(row, i, selector, name, role) {
  if (role && name) return `getByRole('${role}', { name: '${name.replace(/'/g, "\\'")}' })`;
  if (selector) return `locator(${JSON.stringify(selector)}).nth(${i})`;
  return `nth(${i})`;
}

function coveringElement(block) {
  return /Element does not receive pointer events at the \w+ point; (<[^;\n]+>|[^\n;]+?) intercepts the \w+/.exec(block)?.[1];
}

function nextCall(kind) {
  if (kind === 'strict') return `${READ} and resolve one matching locator`;
  if (kind === 'missing') return `${READ} and use a locator that matches now`;
  return READ;
}

function quote(selector) {
  if (!selector) return 'target';
  return /[\s"'=\[\]]/.test(selector) ? JSON.stringify(selector) : selector;
}
