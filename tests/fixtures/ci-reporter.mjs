import { relative } from 'node:path';

export default async function* report(events) {
  const files = new Map();
  for await (const { type, data } of events) {
    if (type === 'test:pass' || type === 'test:fail') {
      const file = data.file ? relative(process.cwd(), data.file) : 'unknown';
      const counts = files.get(file) ?? { pass: 0, fail: 0, skip: 0 };
      counts[data.skip ? 'skip' : type === 'test:fail' ? 'fail' : 'pass']++;
      files.set(file, counts);
      if (data.skip || type === 'test:fail') yield JSON.stringify({ type, file, name: data.name,
        ...(data.skip && { skip: data.skip }), ...(data.details?.error && { error: String(data.details.error.stack ?? data.details.error) }) }) + '\n';
    }
    if (type === 'test:stderr') yield JSON.stringify({ file: data.file, stderr: data.message }) + '\n';
    if (type === 'test:diagnostic' && /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(data.message)) {
      yield JSON.stringify({ summary: data.message }) + '\n';
    }
  }
  for (const [file, counts] of files) yield JSON.stringify({ file, ...counts }) + '\n';
}
