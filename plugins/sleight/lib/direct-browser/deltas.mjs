// Original sleight code. Changes compare only the exact acknowledged scoped view.
export function rowChanges(selected, baseline, byRef) {
  const changes = new Map();
  for (const row of selected) {
    const old = baseline.get(row.ref);
    if (!old) changes.set(row.ref, { ...row, kind: 'added' });
    else if (JSON.stringify(old) !== JSON.stringify(row)) changes.set(row.ref, { ...row, kind: 'changed' });
  }
  for (const row of [...changes.values()]) {
    for (let parent = byRef.get(row.parent); parent; parent = byRef.get(parent.parent)) {
      if (!changes.has(parent.ref)) changes.set(parent.ref, { ...parent, kind: 'context' });
    }
  }
  return changes;
}
