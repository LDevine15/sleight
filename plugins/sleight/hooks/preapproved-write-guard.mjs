const suffix = '/library/application support/sleight/preapproved.json';
const mutations = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const folded = path => path.normalize('NFC').toLowerCase();
const normalize = path => {
  const parts = [];
  for (const part of path.split('/')) {
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return (path.startsWith('/') ? '/' : '') + parts.join('/');
};

// Resolve before normalizing: a symlink followed by .. walks from its target.
async function protectedPath(path, { stat, home }) {
  if (typeof path !== 'string' || !path || path.length > 4096) return false;
  if (folded(normalize(path)).endsWith(suffix)) return true;
  if (home) path = path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home);
  let resolved = (await stat(path.startsWith('/') ? '/' : '.').catch(() => undefined))?.realPath;
  if (!resolved) return false;
  for (const part of path.split('/').filter(Boolean)) {
    const next = `${resolved.replace(/\/$/, '')}/${part}`;
    const info = await stat(next).catch(() => undefined);
    resolved = info?.realPath ?? normalize(next);
  }
  return folded(normalize(resolved)).endsWith(suffix);
}

// Only literal shell names and operators, never eval or shell expansion. Keep
// operators inside quotes as text, and join quoted/escaped pieces of a word.
function shellWords(command) {
  const words = [];
  let word = '', quote = '', active = false;
  const flush = () => { if (active) words.push({ text: word }); word = ''; active = false; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") {
      const escaped = command[++i] ?? '';
      if (escaped !== '\n') { active = true; word += escaped; }
    }
    else if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') { quote = c; active = true; }
    else if (c === '\n') { flush(); words.push({ text: ';', operator: true }); }
    else if (/\s/.test(c)) flush();
    else if (';&|<>()'.includes(c)) { flush(); words.push({ text: c, operator: true }); }
    else { word += c; active = true; }
  }
  flush();
  return words;
}

function shellWritePaths(command) {
  const paths = [], segments = [[]];
  for (const word of shellWords(command)) {
    if (word.operator && ';&|()'.includes(word.text)) segments.push([]);
    else segments.at(-1).push(word);
  }
  for (const segment of segments) {
    const texts = [];
    for (let i = 0; i < segment.length; i++) {
      if (segment[i].operator) {
        const operator = segment[i].text;
        while (segment[i + 1]?.operator && segment[i + 1].text === operator) i++;
        const target = segment[++i];
        if (operator === '>' && target && !target.operator) paths.push(target.text);
      } else texts.push(segment[i].text);
    }
    while (texts.length && (/^[A-Za-z_][A-Za-z_0-9]*=/.test(texts[0]) || ['env', 'command', 'sudo'].includes(texts[0]))) texts.shift();
    const executable = texts.shift()?.split('/').at(-1);
    const operands = texts.filter(text => text && !text.startsWith('-'));
    if (executable === 'cp') {
      const target = texts.findIndex(text => text === '-t' || text === '--target-directory');
      paths.push(target >= 0 ? texts[target + 1] : operands.at(-1));
      const attached = texts.find(text => text.startsWith('--target-directory='));
      if (attached) paths.push(attached.slice('--target-directory='.length));
    } else if (['tee', 'mv', 'rm'].includes(executable) ||
      (executable === 'sed' && texts.some(arg => /^-i/.test(arg))) ||
      (executable === 'defaults' && ['write', 'delete', 'import'].includes(texts[0]))) paths.push(...operands);
    else if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable ?? '') ||
      (executable === 'node' && texts.some(arg => /^-e|^--eval(?:=|$)/.test(arg)))) {
      paths.push(...operands);
      // Inline source can name a quoted absolute path within a shell word.
      for (const text of texts) for (const match of text.matchAll(/(?:~|\$\{?HOME\}?|\/|\.{1,2}\/)[^'"`;\n()<>|]*?preapproved\.json/gi)) paths.push(match[0]);
    }
  }
  return paths;
}

export async function preapprovedWriteDenied(input, options) {
  const { tool } = input;
  let paths;
  if (mutations.has(tool)) {
    paths = [input.file_path, input.notebook_path, ...(Array.isArray(input.edits) ? input.edits.map(edit => edit?.file_path) : [])];
  } else if (tool === 'Bash' && typeof input.command === 'string') {
    paths = shellWritePaths(input.command);
  } else return false;
  for (const path of paths) if (await protectedPath(path, options)) return true;
  return false;
}
