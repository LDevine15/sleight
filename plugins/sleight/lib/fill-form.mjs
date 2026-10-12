// Role dispatch and per-field reporting adapt FowlBrowser's MIT fill_form tool
// (mcp/src/tools.mjs:1250-1285). Actions use the engine's documented locator API.
export async function fillForm(tab, fields) {
  if (!tab?.playwright || !Array.isArray(fields)) throw new Error('fillForm needs a browser tab and a field array.');
  const options = { timeoutMs: 1000 }, notes = [];
  let filled = 0, tree;
  const attribute = value => '"' + value.replace(/["\\\x00-\x1f]/g, char => '\\' + char.charCodeAt(0).toString(16) + ' ') + '"';
  // Resolve numeric references before input. Later actions use the resulting ID or exact label,
  // so adding a validation message does not turn the next index into another control.
  if (fields.some(field => Number.isInteger(field?.index))) {
    try { tree = await tab.getAXState({ disableDiffing: true, emit: false }); }
    catch (error) { tree = ''; notes.push('Index read failed: ' + error.message); }
  }
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i], name = field?.label ?? field?.index ?? (typeof field?.locator === 'string' ? field.locator : i + 1);
    let fallback;
    try {
      if (!field || ['label', 'index', 'locator'].filter(key => field[key] !== undefined).length !== 1) {
        throw new Error('give exactly one label, index or locator');
      }
      if (!['string', 'number', 'boolean'].includes(typeof field.value) ||
          (typeof field.value === 'number' && !Number.isFinite(field.value))) throw new Error('value must be text, a finite number or a boolean');
      let loc;
      if (field.index !== undefined) {
        if (!Number.isInteger(field.index) || field.index < 0) throw new Error('index must be a nonnegative integer');
        const line = tree?.split('\n').find(line => new RegExp('^\\t*' + field.index + ' ').test(line));
        if (!line) throw new Error('index is missing from the current tree');
        const id = /\bID: (.*?)(?=, (?:Value|Help|Description):|$)/.exec(line)?.[1];
        const label = /\bDescription: (.*?)(?=, (?:Value|Help|ID):|$)/.exec(line)?.[1];
        if (id) loc = tab.playwright.locator('[id=' + attribute(id) + ']');
        else if (label) loc = tab.playwright.getByLabel(label, { exact: true });
        else throw new Error('index has no stable ID or label; use a locator');
      } else if (typeof field.label === 'string') loc = tab.playwright.getByLabel(field.label, { exact: true });
      else if (typeof field.locator === 'string') loc = tab.playwright.locator(field.locator);
      else loc = field.locator;
      if (!loc || await loc.count() !== 1) throw new Error('field must match exactly one control');
      const state = () => loc.evaluate(el => ({
        tag: el.tagName?.toLowerCase(), type: el.type, role: el.getAttribute('role'),
        checked: typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked'),
        value: el.value ?? el.getAttribute('aria-valuenow'),
        min: el.getAttribute('min') ?? el.getAttribute('aria-valuemin') ?? '0',
        max: el.getAttribute('max') ?? el.getAttribute('aria-valuemax') ?? '100',
        step: el.getAttribute('step') ?? '1',
      }), undefined, options);
      const meta = await state();
      const check = ['checkbox', 'radio'].includes(meta.type) ||
        ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(meta.role) ||
        (typeof meta.checked === 'boolean' && typeof meta.tag === 'string' && meta.tag.includes('-'));
      if (check) {
        const on = typeof field.value === 'boolean' ? field.value :
          /^(?:true|on|yes|checked|1)$/i.test(String(field.value)) ? true :
            /^(?:false|off|no|unchecked|0)$/i.test(String(field.value)) ? false : undefined;
        if (on === undefined) throw new Error('checked value must be true or false');
        try { await loc.setChecked(on, options); }
        catch (error) {
          const now = (await state()).checked;
          if (![true, false, 'true', 'false'].includes(now)) throw error;
          if ((now === true || now === 'true') !== on) {
            if ((meta.type === 'radio' || meta.role === 'radio') && !on) throw new Error('choose another radio option to uncheck this one');
            await loc.click(options);
            const after = (await state()).checked;
            if ((after === true || after === 'true') !== on) throw new Error('checked state did not match after clicking');
          }
          fallback = 'checked state verified after fallback';
        }
      } else if (meta.tag === 'select') {
        try { await loc.selectOption({ label: String(field.value) }, options); }
        catch { await loc.selectOption({ value: String(field.value) }, options); fallback = 'selected by value fallback'; }
      } else if (meta.type === 'range' || meta.role === 'slider') {
        const min = Number(meta.min), max = Number(meta.max), step = Number(meta.step), value = Number(field.value);
        const steps = (value - min) / step;
        if (![min, max, step, value, steps].every(Number.isFinite) || step <= 0 || value < min || value > max ||
            Math.abs(steps - Math.round(steps)) > 1e-8 || steps > 200) throw new Error('slider needs an in-range value within 200 steps of its minimum');
        await loc.press('Home', options);
        for (let n = 0; n < Math.round(steps); n++) await loc.press('ArrowRight', options);
        if (Number((await state()).value) !== value) throw new Error('slider value did not match; read the field before retrying');
      } else {
        if (['file', 'submit', 'reset', 'button', 'image', 'hidden'].includes(meta.type) || meta.role === 'button') {
          throw new Error('control is not a form value; fillForm never submits');
        }
        try { await loc.fill(String(field.value), options); }
        catch {
          if (meta.role === 'combobox' && meta.tag !== 'input' && meta.tag !== 'textarea') {
            await loc.click(options);
            await tab.playwright.getByRole('option', { name: String(field.value), exact: true }).click(options);
          } else {
            await loc.press('ControlOrMeta+A', options);
            await loc.type(String(field.value), options);
          }
          fallback = 'filled with fallback';
        }
      }
      filled++;
      if (fallback) notes.push(`Field ${i + 1} (${name}): ${fallback}.`);
    } catch (error) {
      notes.push(`Field ${i + 1} (${name}) failed: ${String(error.message).replace(/\s+/g, ' ')}. Input may have been sent; read this field before retrying.`);
    }
  }
  return `Filled ${filled} of ${fields.length} fields.` + (notes.length ? '\n' + notes.join('\n') : '');
}

export function fillFormCode(code) {
  if (!/\bsleight\s*\.\s*fillForm\s*\(/.test(code)) return code;
  return `globalThis.sleight ??= {}; globalThis.sleight.fillForm = (${fillForm.toString()});\n${code}`;
}
