// Keep the original safety passage, including its line break, even for callers with the old RS2 text.
const SUBMIT = "Submit in that call when requested and the engine's confirmation policy permits it. Otherwise stop before the final click.";
const ORIGINAL = "Submit in that call only when the user asked for that submit and the engine's confirmation policy\ndoesn't require confirming it. Otherwise stop before the final click.";
const ORIGINAL_LEAN = "Submit in that call only when the user asked and the engine's confirmation policy doesn't require confirming it. Otherwise stop before the final click.";

export function requestedSignupsEnabled(value) {
  return value === undefined || value === '1';
}

export function requestedSubmitRules(text, env = process.env) {
  return text?.replace(SUBMIT, env.SLEIGHT_PROMPT === 'lean' ? ORIGINAL_LEAN : ORIGINAL);
}
