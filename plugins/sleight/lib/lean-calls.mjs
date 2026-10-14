// Opt-in native call guidance. Default prompt sources stay byte-identical.
export function leanCallRules(text) {
  return text?.replace('Keep the handle and `await` every action.', 'Keep the app handle across calls; `await` every action.')
    .replace('Each result shows what changed since the last full tree you saw. A full read is',
      'End on the action; results show headers and changed lines. Request a full tree with');
}

export function leanCallDescription(description) {
  return description + '\nNative calls: keep the app handle across calls. End on the action; sleight returns the window header and changed lines. Read again when the result requires it; getAXState({ disableDiffing: true }) requests a full tree.';
}
