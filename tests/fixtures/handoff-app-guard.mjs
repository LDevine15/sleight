import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

let queries = 0;
const present = new Set(['TextEdit', 'Preview']), controls = [];
childProcess.spawnSync = (command, args) => {
  if (command === '/usr/bin/pgrep' && args[0] === '-x' && ['TextEdit', 'Preview'].includes(args[1])) {
    const before = queries++ < 2;
    return { status: before || !present.has(args[1]) ? 1 : 0, stdout: '', stderr: '' };
  }
  if (command === '/usr/bin/osascript' && args[0] === '-e') {
    assertQuit(args[1]); controls.push({ command, args });
    present.delete(args[1].includes('TextEdit') ? 'TextEdit' : 'Preview');
    return { status: 0, stdout: '', stderr: '' };
  }
  throw Error('unsupported fake subprocess: ' + command);
};
function assertQuit(source) {
  if (!/^tell application "(?:TextEdit|Preview)" to quit saving no$/.test(source))
    throw Error('unsupported fake app operation');
}
syncBuiltinESMExports();
process.on('exit', () => writeFileSync(join(process.env.SLEIGHT_GUARD_RECORDS, process.pid + '.json'), JSON.stringify({ queries, controls })));
