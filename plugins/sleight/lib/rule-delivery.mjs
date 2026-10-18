// Only relay-created items can establish delivery. A matching page string or an internal
// preparation must never spend the first delivery of safety rules. Symbols survive the
// relay's content clones but do not cross the JSON boundary.
const TRUSTED = Symbol('sleight rules');
const REFERENCE = 'sleight: rules already sent in this session still apply.';

export function ruleDelivery() {
  const delivered = new Set();
  return {
    item: text => ({ type: 'text', text, [TRUSTED]: text }),
    apply(content) {
      return content.map(item => {
        if (item.type !== 'text' || typeof item.text !== 'string') return item;
        const trusted = item[TRUSTED];
        if (trusted && item.text === trusted && !delivered.has(trusted)) {
          delivered.add(trusted);
          return item;
        }
        let text = item.text;
        for (const block of [...delivered].sort((a, b) => b.length - a.length)) {
          // The compactor can echo a rule block after a tree, either verbatim or as added lines.
          for (const copy of ['+ ' + block.replaceAll('\n', '\n+ '), block]) {
            let at = 0;
            while ((at = text.indexOf(copy, at)) >= 0) {
              const end = at + copy.length;
              if ((at === 0 || text[at - 1] === '\n') && (end === text.length || text[end] === '\n')) {
                text = text.slice(0, at) + REFERENCE + text.slice(end);
                at += REFERENCE.length;
              } else at = end;
            }
          }
        }
        return text === item.text ? item : { ...item, text };
      });
    },
  };
}
