import { tokens } from './flow-rules.mjs';

const actions = new Set(['click', 'doubleClick', 'rightClick', 'setValue', 'typeText', 'pressKey', 'paste',
  'scroll', 'selectText', 'performSecondaryAction', 'performAction']);

function parseTree(text) {
  const lines = text.split('\n'), header = lines[0];
  const id = /^Browser tab: (\d+), Title: "(?:[^"\\]|\\.)*", URL: "(?:[^"\\]|\\.)*"\.$/.exec(header)?.[1];
  if (!id) return;
  const rows = {};
  let last;
  for (const line of lines.slice(1)) {
    if (/browser tree lines omitted|^[+~-] \t*\d+ /.test(line)) return { id };
    const match = /^\t*(\d+) (.+)$/.exec(line);
    if (match) { last = match[1]; rows[last] = match[2]; }
    else if (line && last !== undefined && !/^The focused UI element /.test(line)) rows[last] += '\n' + line;
    else last = undefined;
  }
  return { id, header, rows };
}

function samePage(a, b) {
  const parse = h => /^Browser tab: (\d+), Title: "(?:[^"\\]|\\.)*", URL: ("(?:[^"\\]|\\.)*")\.$/.exec(h ?? '');
  const A = parse(a), B = parse(b);
  return Boolean(A && B && A[1] === B[1] && A[2] === B[2]);
}

function sameRow(was, now) {
  if (was === now) return true;
  if (typeof was !== 'string' || typeof now !== 'string') return false;
  const [full, bare] = was.length > now.length ? [was, now] : [now, was];
  return full.startsWith(bare) && (full.length === bare.length || full[bare.length] === ',' || full[bare.length] === '\n');
}

function install(cua, config, parse, methods, samePage, sameRow) {
  let state = globalThis.__sleightBrowserStale;
  if (!state) {
    state = globalThis.__sleightBrowserStale = { config, wrapped: new WeakMap(), owners: new Map(), browsers: new WeakSet(), call: new WeakMap() };
    const wrap = (tab, browser) => {
      if (!tab || typeof tab.getAXState !== 'function' || tab.id === undefined) return tab;
      if (state.wrapped.has(tab)) return state.wrapped.get(tab);
      const owners = state.owners.get(String(tab.id)) ?? new Set();
      owners.add(browser ?? 'unknown'); state.owners.set(String(tab.id), owners);
      const proxy = new Proxy(tab, { get(raw, name) {
        const value = Reflect.get(raw, name, raw);
        if (typeof value !== 'function') return value;
        if (!methods.includes(name)) return value.bind(raw);
        return async (...args) => {
          const current = state.config, seen = current.trees[String(raw.id)];
          if (typeof args[0] === 'number' && current.literals.includes(args[0]) && seen) {
            const requested = args[0];
            const call = state.call.get(raw) ?? { moved: Object.create(null) };
            state.call.set(raw, call);
            const number = call.moved[requested] ?? requested;
            if (number !== requested) args = [number, ...args.slice(1)];
            let text;
            try {
              text = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(Object.assign(new Error('sleight-stale-timeout'), { staleTimeout: true })), 1500);
                raw.getAXState({ disableDiffing: true, emit: false }).then(value => {
                  clearTimeout(timer); resolve(value);
                }, err => { clearTimeout(timer); reject(err); });
              });
            } catch (err) {
              if (err?.staleTimeout) {
                nodeRepl.write(`sleight: ${name}(${requested}) ran without a stale-number check: the tab read timed out after 1.5 s.\n`);
                return value.apply(raw, args);
              }
              throw err;
            }
            const fresh = parse(text);
            const was = seen.rows[requested];
            const now = fresh?.rows?.[number];
            const unique = seen.unique.includes(requested);
            if (was === undefined || !fresh?.header || !samePage(fresh.header, seen.header) || !sameRow(was, now)) {
              const matches = was === undefined || !fresh?.rows ? []
                : Object.entries(fresh.rows).filter(([, line]) => sameRow(was, line));
              if (owners.size === 1 && current.literals.length === 1 && current.literals[0] === requested &&
                  unique && samePage(fresh.header, seen.header) &&
                  !/^[a-z][a-z ]*(?: \([^)]*\))*$/.test(was ?? '') && matches.length === 1) {
                const to = Number(matches[0][0]);
                nodeRepl.write(`sleight: ${name}(${requested}) went to element ${to}, the same ${JSON.stringify(was)}: the tab renumbered since you read it.\n`);
                args = [to, ...args.slice(1)];
                call.moved[requested] = to;
              } else throw new Error(`sleight stopped before ${name}(${requested}): element ${requested} changed or is missing since you read the tab. Read this tab again before using its numbers.` + (typeof text === 'string' ? '\n' + text : ''));
            } else call.moved[requested] = number;
          }
          return value.apply(raw, args);
        };
      } });
      state.wrapped.set(tab, proxy);
      return proxy;
    };
    for (const name of ['getTab', 'createBrowserTab']) if (typeof cua[name] === 'function') {
      const get = cua[name].bind(cua);
      cua[name] = async (...args) => wrap(await get(...args), name === 'createBrowserTab' ? args[0] : args[1]?.browser);
    }
    if (typeof cua.getBrowser === 'function') {
      const get = cua.getBrowser.bind(cua);
      cua.getBrowser = async (...args) => {
        const browser = await get(...args);
        if (!state.browsers.has(browser) && browser.tabs) {
          state.browsers.add(browser);
          for (const name of ['new', 'get']) if (typeof browser.tabs[name] === 'function') {
            const make = browser.tabs[name].bind(browser.tabs);
            browser.tabs[name] = async (...values) => wrap(await make(...values), browser.browserId);
          }
        }
        return browser;
      };
    }
  }
  state.config = config;
  state.call = new WeakMap();
}

export function createBrowserStaleGuard() {
  const trees = new Map();
  return {
    reset() { trees.clear(); },
    observe(content) {
      for (const item of content) if (item.type === 'text' && typeof item.text === 'string' &&
          !/^(?:## Computer Use|# Other Browser APIs)\n/.test(item.text)) {
        if (/There has been no change in the accessibility tree/.test(item.text) &&
            !/^\t*\d+ /m.test(item.text)) continue;
        const parts = item.text.split(/(?=^Browser tab: )/m).filter(part => part.startsWith('Browser tab: '));
        for (const part of parts) {
          if (/There has been no change in the accessibility tree/.test(part)) continue;
          const tree = parseTree(part.split(/^Window: /m)[0].trimEnd());
          if (!tree) continue;
          if (!tree.rows) { trees.delete(tree.id); continue; }
          if (!Object.keys(tree.rows).length) continue;
          trees.delete(tree.id);
          trees.set(tree.id, tree);
        }
      }
      while (trees.size > 64) trees.delete(trees.keys().next().value);
    },
    code(code) {
      const ts = tokens(code), literals = [];
      for (let i = 0; i < ts.length - 4; i++) if (ts[i].v === '.' && actions.has(ts[i + 1].v) &&
          ts[i + 2].v === '(' && !ts[i + 3].string && /^\d+$/.test(ts[i + 3].v) &&
          [',', ')'].includes(ts[i + 4].v)) literals.push(Number(ts[i + 3].v));
      const numbers = [...new Set(literals)], selected = {};
      for (const [id, tree] of trees) selected[id] = { header: tree.header,
        rows: Object.fromEntries(numbers.filter(n => tree.rows[n] !== undefined).map(n => [n, tree.rows[n]])),
        unique: numbers.filter(n => tree.rows[n] !== undefined && Object.values(tree.rows).filter(line => line === tree.rows[n]).length === 1) };
      const config = { trees: selected, literals: ts.some(t => t.v === '<template>') ? [] : numbers };
      return `(${install.toString()})(cua,${JSON.stringify(config)},${parseTree.toString()},${JSON.stringify([...actions])},${samePage.toString()},${sameRow.toString()});\n${code}`;
    },
  };
}
