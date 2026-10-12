import fs from 'node:fs';
import { chromeDeviceHook } from './chrome.mjs';

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!process.argv[2] || !process.argv[3]) throw new Error('Missing Chrome device gate arguments');
  console.log(JSON.stringify(chromeDeviceHook(input, process.argv[2], process.argv[3])));
} catch (error) { console.log(JSON.stringify({ continue: false, stopReason: `Chrome device gate failed: ${error.message}` })); }
