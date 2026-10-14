// Bench transport only. The production v3 surface supplies the entire catalog,
// validation and dispatch. Do not reserialize its plain-text MCP result as JSON.
export function createProtocol({ output = process.stdout, start, tools, validate } = {}) {
  if (!Array.isArray(tools) || typeof validate !== 'function' || typeof start !== 'function') throw Error('V3 interface required');
  let session, starting, queue = Promise.resolve(), closing = false, cleanup;
  const send = value => new Promise((resolve, reject) => {
    output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n', error => error ? reject(error) : resolve());
  });
  const run = async message => {
    const id = message?.id; if (id === undefined) return;
    if (closing) return send({ id, error: { code: -32000, message: 'Session closing' } });
    if (message.method === 'initialize') return send({ id, result: { protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} }, serverInfo: { name: 'sleight-turbo-v3-bench', version: '0.1.0' } } });
    if (message.method === 'ping') return send({ id, result: {} });
    if (message.method === 'tools/list') return send({ id, result: { tools } });
    if (message.method !== 'tools/call') return send({ id, error: { code: -32601, message: 'Method not found' } });
    let request;
    try {
      // The original task belongs to the launch boundary. Strip every outer
      // client field, including Claude Code's _meta and any purported authority.
      if (!tools.some(tool => tool.name === message.params?.name)) throw Error('Unknown v3 tool');
      request = validate({ name: message.params?.name, arguments: message.params?.arguments });
    } catch (error) { return send({ id, error: { code: -32602, message: error.message } }); }
    let result;
    try {
      starting ??= Promise.resolve().then(start); session = await starting;
      result = await session.call(request);
      if (!Array.isArray(result?.content)) throw Error('Invalid v3 result');
    } catch {
      result = { content: [{ type: 'text', text: 'Turbo bench unavailable (effect unknown). Read before any retry.' }], isError: true };
    }
    await send({ id, result });
    // An undelivered observation cannot unlock a submit retry. The product
    // surface decides which results represent deliverable observations.
    session?.delivered?.(result, request);
  };
  return Object.freeze({
    message(message) { const work = queue.then(() => run(message)); queue = work.catch(() => {}); return work; },
    close() {
      closing = true;
      return cleanup ??= (async () => {
        await queue;
        if (starting) { try { session = await starting; } catch {} }
        return session?.close();
      })();
    } });
}
