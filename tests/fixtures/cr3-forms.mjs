// Original local forms for CR3's size census. No external site or vendor fixture.
export function censusFixture(kind) {
  const title = { travel: 'Journey planner', settings: 'Workspace preferences', checkout: 'Delivery review' }[kind];
  const prefix = { travel: 'Traveller detail', settings: 'Preference detail', checkout: 'Delivery detail' }[kind];
  const fields = Array.from({ length: 28 }, (_, i) => `<label>${prefix} ${i + 1}<input value="Fixture value ${i + 1}"></label>`).join('');
  const selects = Array.from({ length: 6 }, (_, i) => `<label>Choice ${i + 1}<select><option>Standard</option><option>Alternate</option></select></label>`).join('');
  const checks = Array.from({ length: 6 }, (_, i) => `<label><input type="checkbox">Include option ${i + 1}</label>`).join('');
  const list = Array.from({ length: 60 }, (_, i) => `<li>Fixture ${kind} entry ${String(i + 1).padStart(2, '0')}</li>`).join('');
  const extra = kind === 'settings' ? '<button type="button" role="switch" aria-checked="true">Secure mode</button>'
    : kind === 'checkout' ? '<iframe title="Payment details" src="/payment"></iframe>' : '';
  return {
    html: `<main><h1>${title}</h1><form>${fields}${selects}${checks}${extra}<button type="button">Save draft</button></form><h2>Available entries</h2><ul>${list}</ul></main>`,
    routes: { '/payment': '<label>Number<input autocomplete="cc-number" value="4111 1111 1111 1111"></label>'
      + '<label>Expiry<input autocomplete="cc-exp" value="08/30"></label><label>Security code<input autocomplete="cc-csc" value="123"></label>' },
  };
}
