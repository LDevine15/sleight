// RS2 changes only this sentence. RS off restores the 4fc88abc text, including its line break.
const SUBMIT = "Submit in that call when requested and the engine's confirmation policy permits it. Otherwise stop before the final click.";
const ORIGINAL = "Submit in that call only when the user asked for that submit and the engine's confirmation policy\ndoesn't require confirming it. Otherwise stop before the final click.";
const ORIGINAL_LEAN = "Submit in that call only when the user asked and the engine's confirmation policy doesn't require confirming it. Otherwise stop before the final click.";

export function requestedSignupsEnabled(value) {
  return value === undefined || value === '1';
}

export function requestedSubmitRules(text, env = process.env) {
  return !requestedSignupsEnabled(env.SLEIGHT_RS) || env.SLEIGHT_CONFIRM_PAYMENTS === 'always'
    ? text?.replace(SUBMIT, env.SLEIGHT_PROMPT === 'lean' ? ORIGINAL_LEAN : ORIGINAL) : text;
}
