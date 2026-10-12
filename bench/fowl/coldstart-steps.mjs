export async function coldstartSteps(js, { emptyOnly = false, browserId, open = 'create', url }) {
  const row = { empty: await js('1') };
  if (emptyOnly) return row;
  row.getBrowser = await js(`let b = await cua.getBrowser({ extensionInstanceId: ${JSON.stringify(browserId)} }); 1`);
  row.createTab = await js(open === 'new' ? `let t = await b.tabs.new(); await t.goto(${JSON.stringify(url)}); 1` :
    `let t = await cua.createBrowserTab(b.browserId, ${JSON.stringify(url)}, { sessionName: 'cold start' }); 1`);
  row.read = await js('await t.getAXState()');
  row.second = await js('await t.getAXState()');
  return row;
}

export function coldstartMode(args, argv) {
  const emptyOnly = argv.includes('--empty-only');
  const concurrency = Number(args.concurrency ?? 1), prepareMs = Number(args['prepare-ms'] ?? 0);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 13 ||
      !Number.isFinite(prepareMs) || prepareMs < 0 || prepareMs > 10000) throw new Error('Invalid concurrency or preparation delay.');
  if (concurrency > 1 && !emptyOnly) throw new Error('Concurrent trials require --empty-only.');
  return { emptyOnly, concurrency, prepareMs };
}
