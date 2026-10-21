// Fixed opt-in entry point. The imported node:test suite owns one headless browser,
// its private profile, abort handling and cleanup. No live application is attached.
if (process.argv.length !== 2) throw Error('usage: node bench/edit-context-real-check.mjs');
process.env.SLEIGHT_EDIT_CONTEXT_REAL_TEST = '1';
await import('../tests/direct-browser-edit-context.real.test.mjs');
