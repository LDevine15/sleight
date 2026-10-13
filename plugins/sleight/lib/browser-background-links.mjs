// FowlBrowser's MIT mcp/src/popups.mjs suggested opening noopener links through
// the tab API. This read-only adapter leaves opener-dependent navigation alone.
export function inspectBackgroundLink(element) {
  if (Array.isArray(element)) element = document.elementFromPoint(...element);
  const link = element?.closest('a,area');
  const submitter = element?.closest('button,input'), form = submitter?.form;
  if (!link) {
    const target = submitter?.formTarget || form?.target;
    if (!target || /^_(?:self|parent|top|unfencedtop)$/i.test(target)) return null;
    const fallback = { fallback: 'form submission needs the original click to preserve fields, validation and submit handlers' };
    if (!form || submitter.type !== 'submit' || submitter.matches(':disabled') ||
        form.getAttribute('onsubmit') !== null || submitter.getAttribute('onclick') !== null) return fallback;
    const rel = String(form.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('opener') || (target.toLowerCase() !== '_blank' && !rel.some(value => ['noopener', 'noreferrer'].includes(value))))
      return { fallback: 'window.opener or an existing named context may be required' };
    const method = submitter.getAttribute('formmethod') === null ? form.method : submitter.formMethod;
    const charset = form.getAttribute('accept-charset');
    if (method !== 'get' || charset && !/^utf-8$/i.test(charset)) return fallback;
    const fields = Array.from(form.elements);
    if (fields.some(field => field.willValidate && !field.validity.valid) && !form.noValidate && !submitter.formNoValidate) return fallback;
    const query = new URLSearchParams();
    for (const field of fields) {
      if (field.matches(':disabled') || !field.name || /^(?:reset|button)$/.test(field.type) ||
          /^(?:checkbox|radio)$/.test(field.type) && !field.checked || field.type === 'submit' && field !== submitter) continue;
      if (field.name === '_charset_' || !/^(?:INPUT|TEXTAREA|SELECT|BUTTON)$/.test(field.tagName) || /^(?:file|image)$/.test(field.type) || field.getAttribute?.('dirname')) return fallback;
      const values = field.tagName === 'SELECT' ? Array.from(field.selectedOptions).filter(option => !option.matches(':disabled')).map(option => option.value) : [field.value];
      for (const value of values) query.append(field.name.replace(/\r?\n|\r/g, '\r\n'), String(value).replace(/\r?\n|\r/g, '\r\n'));
    }
    const action = submitter.getAttribute('formaction') === null ? form.action : submitter.formAction;
    if (!/^https?:\/\//i.test(action ?? '')) return fallback;
    const url = new URL(action); url.search = query.toString();
    const rect = submitter.getBoundingClientRect(), doc = form.ownerDocument;
    const style = doc.defaultView.getComputedStyle(submitter);
    const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (rect.width <= 0 || rect.height <= 0 || style.visibility !== 'visible' || style.pointerEvents === 'none' || !hit || !submitter.contains(hit)) return fallback;
    return { url: url.href };
  }
  if (link.hasAttribute('download')) return null;
  if (link.getAttribute('onclick') !== null) return { fallback: 'the link has a click handler' };
  const target = link.target || link.ownerDocument.querySelector('base[target]')?.target || '';
  if (!target || /^_(?:self|parent|top|unfencedtop)$/i.test(target)) return null;
  const rel = String(link.rel ?? '').toLowerCase().split(/\s+/);
  if (rel.includes('opener') || (target.toLowerCase() !== '_blank' && !rel.some(value => ['noopener', 'noreferrer'].includes(value))))
    return { fallback: 'window.opener or an existing named context may be required' };
  if (!/^https?:\/\//i.test(link.href ?? '')) return null;
  const rect = link.getBoundingClientRect(), doc = link.ownerDocument;
  const style = doc.defaultView.getComputedStyle(link);
  const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (rect.width <= 0 || rect.height <= 0 || style.visibility !== 'visible' ||
      style.pointerEvents === 'none' || !hit || !link.contains(hit))
    return { fallback: 'engine actionability checks are needed for this hidden or covered link' };
  return { url: link.href };
}

function installBackgroundLinks(cua, inspect) {
  if (globalThis.__sleightBackgroundLinks || typeof cua?.getBrowser !== 'function') return;
  globalThis.__sleightBackgroundLinks = true;
  const views = new WeakMap(), browsers = new WeakSet(), originals = new WeakMap();
  const factories = new Set(['locator', 'frameLocator', 'getByRole', 'getByText', 'getByLabel',
    'getByPlaceholder', 'getByTestId', 'filter', 'first', 'last', 'nth', 'and', 'or', 'all']);
  const unwrap = value => {
    if (!value || typeof value !== 'object') return value;
    if (originals.has(value)) return originals.get(value);
    if (Array.isArray(value)) return value.map(unwrap);
    if (Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
    return value;
  };
  const note = text => nodeRepl.write('sleight: ' + text);
  const wrap = (raw, tab = raw, browserId, kind = 'tab') => {
    if (!raw || typeof raw !== 'object') return raw;
    if (views.has(raw)) return views.get(raw);
    const proxy = new Proxy(raw, { get(target, name) {
      const value = Reflect.get(target, name, target);
      if (kind === 'tab' && name === 'playwright') return wrap(value, tab, browserId, 'playwright');
      if (typeof value !== 'function') return value;
      if (name === 'click' && kind !== 'playwright') return async (...args) => {
        const options = args[kind === 'tab' ? 1 : 0] ?? {};
        if (options.button && options.button !== 'left' || options.modifiers?.length || options.key ||
            options.mouseButton && options.mouseButton !== 'left' || options.clickCount > 1)
          return value.apply(target, args.map(unwrap));
        let candidate;
        if (kind === 'locator') candidate = await target.evaluate(inspect);
        else if (Array.isArray(args[0])) candidate = await tab.playwright.evaluate(inspect, args[0]);
        else if (Number.isInteger(args[0])) {
          // Resolve a unique ID or exact role from the engine tree, never a DOM index.
          const tree = await tab.getAXState({ disableDiffing: true, emit: false });
          const line = String(tree).split('\n').find(row => new RegExp('^\\t*' + args[0] + ' ').test(row));
          const id = /\bID: (.*?)(?=, (?:Value|Help|Description):|$)/.exec(line ?? '')?.[1];
          const role = /^\t*\d+ (link|button) (.*?)(?=, (?:Value|Help|Description|ID):|$)/.exec(line ?? '');
          const loc = id ? tab.playwright.locator('[id=' + JSON.stringify(id) + ']')
            : role ? tab.playwright.getByRole(role[1], { name: role[2], exact: true }) : undefined;
          if (loc && await loc.count() === 1) candidate = await loc.evaluate(inspect);
        }
        if (!candidate) return value.apply(target, args.map(unwrap));
        if (candidate.fallback || !browserId) {
          note(`original click retained: ${candidate.fallback ?? 'the source browser identity is unknown'}. Popup focus remains possible.`);
          return value.apply(target, args.map(unwrap));
        }
        // These supported APIs retain the engine's ownership and navigation policy.
        // A refused navigation propagates, without retrying through the original click.
        const browser = await cua.getBrowser({ id: browserId });
        const child = await browser.tabs.new();
        note(`new tab ${child.id} created for this link.`);
        await child.goto(candidate.url);
      };
      if (kind !== 'tab' && factories.has(name)) return (...args) => {
        const result = value.apply(target, args.map(unwrap));
        const wrapped = result => Array.isArray(result) ? result.map(item => wrap(item, tab, browserId, 'locator'))
          : wrap(result, tab, browserId, 'locator');
        return result?.then ? result.then(wrapped) : wrapped(result);
      };
      return (...args) => value.apply(target, args.map(unwrap));
    } });
    views.set(raw, proxy); originals.set(proxy, raw);
    return proxy;
  };
  for (const name of ['getTab', 'createBrowserTab']) if (typeof cua[name] === 'function') {
    const get = cua[name].bind(cua);
    cua[name] = async (...args) => wrap(await get(...args), undefined, name === 'getTab' ? args[1]?.browser : args[0]);
  }
  const getBrowser = cua.getBrowser.bind(cua);
  cua.getBrowser = async (...args) => {
    const browser = await getBrowser(...args);
    if (!browsers.has(browser)) {
      browsers.add(browser);
      for (const name of ['get', 'new']) if (typeof browser.tabs[name] === 'function') {
        const get = browser.tabs[name].bind(browser.tabs);
        browser.tabs[name] = async (...values) => wrap(await get(...values), undefined, browser.browserId);
      }
    }
    return browser;
  };
}

export function backgroundLinksCode(code) {
  return `(${installBackgroundLinks.toString()})(cua, (${inspectBackgroundLink.toString()}));\n${code}`;
}
