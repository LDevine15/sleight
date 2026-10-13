// The parse-error pattern lives inside the function: the relay injects `locateList.toString()` into the engine, so module scope is lost.
export async function locateList(tab, list, helper) {
  const PARSE = /Unexpected token|not a valid selector|Malformed selector|failed to parse selector/i;
  const counted = async loc => {
    if (!loc) return 0;
    try { return await loc.count(); }
    catch (err) {
      if (PARSE.test(String(err?.message ?? err))) return 0;
      throw err;
    }
  };
  let loc = typeof list === 'string' ? tab.playwright.locator(list) : list;
  if (typeof list === 'string') {
    const css = await counted(loc);
    if (css > 1) throw new Error(`${helper} found ${css} lists for ${JSON.stringify(list)}.`);
    if (css === 0) {
      loc = null;
      for (const role of ['listbox', 'combobox', 'list']) {
        const named = tab.playwright.getByRole?.(role, { name: list, exact: true });
        const n = await counted(named);
        if (n > 1) throw new Error(`${helper} found ${n} lists for ${JSON.stringify(list)}.`);
        if (n === 1) { loc = named; break; }
      }
      if (!loc) {
        const labeled = tab.playwright.getByLabel?.(list, { exact: true });
        const n = await counted(labeled);
        if (n > 1) throw new Error(`${helper} found ${n} lists for ${JSON.stringify(list)}.`);
        if (n === 1) loc = labeled;
      }
    }
  }
  if (!loc || await counted(loc) !== 1) {
    throw new Error(`${helper} needs exactly one list (a CSS selector, a locator, or the list's accessible name).`);
  }
  return { loc };
}
