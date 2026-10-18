const directorySuffix = '/library/application support/sleight';
// grant-seal.key seals the Electron Always records in electron-grants.json; writing it would forge consent.
const suffixes = ['preapproved.json', 'turbo.json', 'turbo-apps.json', 'electron-grants.json', 'grant-seal.key'].map(filename => `${directorySuffix}/${filename}`);
const mutations = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const folded = path => path.normalize('NFC').toLowerCase();
const protectedLiteral = path => {
  const value = folded(normalize(path));
  return suffixes.some(suffix => value.endsWith(suffix)) || value.endsWith(directorySuffix);
};
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
  if (protectedLiteral(path)) return true;
  if (home) path = path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, () => home);
  let resolved = (await stat(path.startsWith('/') ? '/' : '.').catch(() => undefined))?.realPath;
  if (!resolved) return false;
  for (const part of path.split('/').filter(Boolean)) {
    const next = `${resolved.replace(/\/$/, '')}/${part}`;
    const info = await stat(next).catch(() => undefined);
    resolved = info?.realPath ?? normalize(next);
  }
  return protectedLiteral(resolved);
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
    else if (';&|<>()'.includes(c)) {
      flush();
      const pair = c + (command[i + 1] ?? '');
      const operator = ['>>', '>|', '>&', '<<', '&&', '||', '|&'].includes(pair) ? (i++, pair) : c;
      words.push({ text: operator, operator: true });
    }
    else { word += c; active = true; }
  }
  flush();
  return words;
}

const launcher = name => name === 'sleight-mcp' || name === 'launch.mjs';
const turboArgument = value => value.replace(/^['"]+|[;&|)'"]+$/g, '');
// True when the words run the launcher's turbo command with anything but status, as separate words or inside a -c string.
function turboToggle(words) {
  const names = words.map(word => word.split('/').at(-1)), first = names.findIndex(launcher);
  if (first >= 0) {
    const turbo = names.indexOf('turbo', first + 1);
    if (turbo >= 0 && turboArgument(names[turbo + 1] ?? '') !== 'status') return true;
  }
  return words.some(word => {
    if (!/\s/.test(word)) return false;
    const hit = /(?<![\w.-])(?:\S*\/)?(?:sleight-mcp|launch\.mjs)(?=[\s'"]|$)/.exec(word);
    return !!hit && [...word.slice(hit.index).matchAll(/(?<![\w-])turbo(?![\w-])\s*(\S*)/g)].some(match => turboArgument(match[1]) !== 'status');
  });
}

function shellWritePaths(command, initialDirectory, depth = 0) {
  if (depth > 8) return [];
  const paths = [], segments = [{ words: [] }];
  let directory = initialDirectory;
  for (const word of shellWords(command)) {
    const previous = segments.at(-1);
    if (word.operator && [';', '&', '|', '|&', '&&', '||', '(', ')'].includes(word.text)) {
      segments.push({ words: [], piped: word.text === '|' ? previous.words : undefined });
    } else previous.words.push(word);
  }
  const add = (path, literalOnly = false) => {
    if (typeof path !== 'string') return;
    paths.push({ path: directory && !/^(?:\/|~|\$HOME|\$\{HOME\})/.test(path) ? `${directory}/${path}` : path, literalOnly });
  };
  for (const { words: segment, piped } of segments) {
    const texts = [];
    for (let i = 0; i < segment.length; i++) {
      if (segment[i].operator) {
        const operator = segment[i].text;
        const target = segment[++i];
        if (['>', '>>', '>|', '>&'].includes(operator) && target && !target.operator) add(target.text);
      } else texts.push(segment[i].text);
    }
    const allWords = [...texts];
    let xargs = false;
    while (texts.length) {
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(texts[0])) { texts.shift(); continue; }
      const prefix = texts[0].split('/').at(-1);
      if (!['env', 'command', 'sudo', 'time', 'nohup', 'xargs'].includes(prefix)) break;
      xargs ||= prefix === 'xargs'; texts.shift();
      while (texts[0]?.startsWith('-')) {
        const flag = texts.shift();
        if (['-u', '--unset', '-I', '-n', '-P'].includes(flag)) texts.shift();
      }
    }
    const executable = texts.shift()?.split('/').at(-1);
    const operands = texts.filter(text => text && !text.startsWith('-'));
    // `sleight-mcp turbo on|off` writes turbo.json for the user, so a model's shell may not run it. Position-free on purpose:
    // env, nohup, timeout, interpreter flags and sh -c strings all reach it. Only `turbo status` passes. When in doubt, deny.
    if (turboToggle(allWords)) add('~/Library/Application Support/sleight/turbo.json', true);
    if (xargs && piped) operands.push(...piped.filter(word => !word.operator).map(word => word.text));
    if (executable === 'cd') {
      const next = operands[0];
      if (next) directory = /^(?:\/|~|\$HOME|\$\{HOME\})/.test(next) || !directory ? next : `${directory}/${next}`;
    } else if (['bash', 'sh', 'zsh'].includes(executable) && texts.includes('-c')) {
      paths.push(...shellWritePaths(texts[texts.indexOf('-c') + 1] ?? '', directory, depth + 1));
    } else if (['cp', 'install', 'rsync', 'ln'].includes(executable)) {
      const target = texts.findIndex(text => text === '-t' || text === '--target-directory');
      add(target >= 0 ? texts[target + 1] : operands.at(-1));
      const attached = texts.find(text => text.startsWith('--target-directory='));
      if (attached) add(attached.slice('--target-directory='.length));
    } else if (['tee', 'mv', 'rm', 'truncate'].includes(executable) ||
      (['sed', 'perl'].includes(executable) && texts.some(arg => /^-[^-]*i/.test(arg))) ||
      (executable === 'defaults' && ['write', 'delete', 'import'].includes(texts[0]))) operands.forEach(path => add(path));
    else if (executable === 'plutil' && texts.some(arg => ['-replace', '-insert', '-remove', '-convert'].includes(arg))) {
      add(texts.includes('-o') ? texts[texts.indexOf('-o') + 1] : operands.at(-1));
    } else if (executable === 'dd') texts.filter(arg => arg.startsWith('of=')).forEach(arg => add(arg.slice(3)));
    else if (/^python(?:\d+(?:\.\d+)?)?$/.test(executable ?? '') || ['node', 'ruby'].includes(executable)) {
      const flag = texts.findIndex(arg => /^python/.test(executable) ? /^-c/.test(arg) : /^-e|^--eval(?:=|$)/.test(arg));
      if (flag < 0) continue;
      const option = texts[flag], source = ['-c', '-e', '--eval'].includes(option) ? texts[flag + 1] ?? '' : option.replace(/^(?:-[ce]|--eval=)/, '');
      const writes = /\bopen\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][wax][+bt]*['"]|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rename(?:Sync)?|copyFile(?:Sync)?|rm(?:Sync)?|remove|truncate|File\.write)\s*\(/;
      if (!writes.test(source)) continue;
      // Inline code is scanned as text only, never passed to the filesystem resolver.
      for (const match of source.matchAll(/(?:~|\$\{?HOME\}?|\/|\.{1,2}\/)[^'"`;\n()<>|]*?(?:(?:preapproved|turbo|turbo-apps|electron-grants)\.json|grant-seal\.key|\/sleight(?=['"`;,)\s]|$))|\b(?:(?:preapproved|turbo|turbo-apps|electron-grants)\.json|grant-seal\.key)\b/gi)) add(match[0], true);
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
  for (const candidate of paths) {
    const { path, literalOnly } = tool === 'Bash' ? candidate : { path: candidate };
    if (typeof path !== 'string') continue;
    if (tool === 'Bash') {
      if (protectedLiteral(path)) return true;
      if (literalOnly || /\s/.test(path) || path.length >= 512) continue;
    }
    if (await protectedPath(path, options)) return true;
  }
  return false;
}
