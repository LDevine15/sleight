// Opt-in, offline compiler. Every input still runs through createRelay's normal
// admission and injected guard; annotations never grant read or input authority.
export function dependencyPlan(actions, { handle = 'app', careful = false } = {}) {
  if (!/^[a-zA-Z_$][\w$]*$/.test(handle) || ['cua', 'nodeRepl', 'globalThis'].includes(handle)) throw new Error('invalid handle');
  if (!Array.isArray(actions) || !actions.length || actions.length > 16 || Buffer.byteLength(JSON.stringify(actions)) > 16384)
    throw new Error('plan requires 1 to 16 steps within 16 KiB');
  let previous, availableRead = false;
  const steps = actions.map((action, index) => {
    const keys = action && typeof action === 'object' ? Object.keys(action) : [];
    const verb = keys[0];
    if (keys.length !== 1 || !['read', 'click', 'set', 'key', 'type'].includes(verb)) throw new Error('unsupported plan step');
    let code;
    const quote = JSON.stringify;
    const selector = value => {
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 ||
          !['id', 'label', 'line'].includes(Object.keys(value)[0]) || typeof Object.values(value)[0] !== 'string' || !Object.values(value)[0])
        throw new Error('step needs an exact selector');
      return quote(value);
    };
    if (verb === 'read' && action.read === true) code = `await ${handle}.getAXState({ disableDiffing: true });`;
    else if (verb === 'click') code = `await ${handle}.click(${selector(action.click)});`;
    else if (verb === 'set') {
      const { value, ...target } = action.set ?? {};
      if (typeof value !== 'string') throw new Error('set needs text');
      code = `await ${handle}.setValue(${selector(target)}, ${quote(value)});`;
    } else if (verb === 'type' && typeof action.type === 'string') code = `await ${handle}.typeText(${quote(action.type)});`;
    else if (verb === 'key' && typeof action.key === 'string' && action.key) code = `await ${handle}.pressKey(${quote(action.key)});`;
    else throw new Error('invalid plan step');
    const quiet = previous && (['type', 'set'].includes(previous.verb) ||
      (previous.verb === 'key' && !previous.value.includes('+') && !/^(?:return|enter|escape|esc|tab|space)$/i.test(previous.value)));
    const observationReason = verb === 'read' ? 'explicit-full-read'
      : availableRead ? 'eligible-same-call-read'
      : careful ? 'careful-before-action'
      : quiet && ['key', 'type'].includes(verb) ? 'existing-tree-free-continuation'
      : previous ? 'transition-barrier' : 'existing-guard-admission';
    availableRead = verb === 'read';
    if (verb !== 'read') previous = { verb, value: action[verb] };
    return { index, dependsOn: index ? [index - 1] : [], verb, observationReason, code };
  });
  // Preserve intermediate typing and key events; no paste/setValue substitution.
  return { steps, code: steps.map(step => step.code).join('\n'), finalObservationReason: 'existing-guard-final-read' };
}
