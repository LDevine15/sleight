export async function withMT(value, run) {
  const saved = process.env.SLEIGHT_MT;
  if (value === undefined) delete process.env.SLEIGHT_MT;
  else process.env.SLEIGHT_MT = value;
  try { return await run(); }
  finally {
    if (saved === undefined) delete process.env.SLEIGHT_MT;
    else process.env.SLEIGHT_MT = saved;
  }
}
