// Planning for reordering a list of rows when some endpoints are covered or a delivery method has not worked.
// Pure functions: the caller observes the list and performs each drop. Models lists whose drop inserts the
// dragged row at the target's original index (FowlBrowser's settings fixture); the caller verifies that
// behavior by observing the order after every drop, so a list that works differently stops the plan.
// Measured in the 2026-10-17 Firefox forms runs: 22 covered-endpoint refusals, 13 engine retries with no
// reorder, and a page that allows two drops where the runs used three.

export const moved = (order, from, to) => {
  const next = [...order];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
};
const same = (a, b) => a.length === b.length && a.every((name, i) => name === b[i]);

// The fewest drops that turn `order` into `target`, by breadth-first search. `allowed(order, from, to)`
// says whether a drop between those rows can be made (both endpoints exposed); a fully blocked route
// returns null and never permits bypassing a coverage check. Rows must be unique labels, at most seven.
export function shortestPlan(order, target, allowed = () => true) {
  if (!Array.isArray(order) || !Array.isArray(target) || order.length > 7 || new Set(order).size !== order.length ||
      order.length !== target.length || [...order].sort().join('\0') !== [...target].sort().join('\0')) {
    throw new Error('reorder planning needs unique row labels, at most seven, in both orders');
  }
  const key = a => JSON.stringify(a), goal = key(target), seen = new Set([key(order)]);
  const queue = [{ order, moves: [] }];
  for (let q = 0; q < queue.length; q++) {
    const state = queue[q];
    if (key(state.order) === goal) return state.moves;
    for (let from = 0; from < order.length; from++) for (let to = 0; to < order.length; to++) {
      if (from === to || !allowed(state.order, from, to)) continue;
      const next = moved(state.order, from, to), k = key(next);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ order: next, moves: [...state.moves, { from, to, item: state.order[from], target: state.order[to] }] });
    }
  }
  return null;
}

// Carry a plan out one drop at a time, planning again from the observed order after each drop:
//   observe()                 -> the rows' labels in their current order (a fresh read)
//   drop(method, step, order) -> performs one drop with that delivery method
//   allowed(order, from, to)  -> whether both endpoints can be reached now (exposed, inside the same elements)
//   methods                   -> delivery methods in preference order, e.g. ['background', 'engine']
// A drop must produce the expected order before the next one starts. A method whose drop left the order
// unchanged is ineffective and is never used again in this run, for any step; when none is left the run
// stops with a refusal that says so, rather than repeating it. Any other order stops the run too.
export async function runReorder({ target, observe, drop, allowed = () => true, methods = ['background'], maxDrops }) {
  let order = await observe();
  const ineffective = new Set(), log = [];
  const limit = maxDrops ?? Math.max(2, order.length * 2);
  const verifiedDrops = () => log.filter(entry => entry.verified).length;
  const stop = reason => ({ verified: same(order, target), order, drops: verifiedDrops(), log, reason });
  for (let attempts = 0; attempts < limit; attempts++) {
    if (same(order, target)) return { verified: true, order, drops: verifiedDrops(), log };
    const plan = shortestPlan(order, target, allowed);
    if (!plan) return stop('no route: every plan needs an endpoint that is covered');
    const method = methods.find(m => !ineffective.has(m));
    if (!method) return stop(`no effective method left (${[...ineffective].join(', ')} left the order unchanged); stopping instead of repeating it`);
    const step = plan[0], expected = moved(order, step.from, step.to), before = order;
    await drop(method, step, before);
    order = await observe();
    if (same(order, expected)) { log.push({ method, step, verified: true }); continue; }
    log.push({ method, step, verified: false, after: order });
    if (!same(order, before)) return stop('the order after the drop was not the expected one; stopping before the next drop');
    ineffective.add(method);
  }
  return stop('drop limit reached');
}
