export async function bounded(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve(work()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DEADLINE_EXCEEDED')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
