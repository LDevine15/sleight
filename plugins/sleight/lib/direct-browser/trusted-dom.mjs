// Playwright 1.64.0 is pinned and runs in-process, including when its browser
// transport uses CDP. The client bridge resolves the exact held node; the server
// adopts it into that frame's utility world without consulting page JavaScript.
// There is deliberately no MAIN-world or selector-based fallback.
async function utilityFor(handle) {
  const node = handle?._connection?.toImpl?.(handle);
  const utility = await node?._frame?.utilityContext?.();
  if (!node || utility?.world !== 'utility' || typeof utility.evaluateExpression !== 'function')
    throw Error('TRUSTED_DOM_REQUIRED');
  return { node, utility };
}

export async function trustedRead(handle, reader, arg) {
  const { node, utility } = await utilityFor(handle);
  return utility.evaluateExpression('([el, arg]) => (' + reader.toString() + ')(el, arg)', { isFunction: true }, [node, arg]);
}

export async function trustedHandle(handle, reader) {
  const { node, utility } = await utilityFor(handle);
  return utility.evaluateExpressionHandle('el => (' + reader.toString() + ')(el)', { isFunction: true }, node);
}

export async function trustedLocatorRead(locator, reader, arg) {
  const handle = typeof locator.elementHandle === 'function' ? await locator.elementHandle({ timeout: 1000 }) : locator;
  try { return await trustedRead(handle, reader, arg); }
  finally { if (handle !== locator) await handle?.dispose(); }
}
