// These markers also scope the Vale exception to the measured sentence in SKILL.md.
export const SCREENSHOT_GUIDANCE_START = '<!-- vale ai-tells.NegatedObject = NO -->';
export const SCREENSHOT_GUIDANCE_END = '<!-- vale ai-tells.NegatedObject = YES -->';

// Strip the lint markers from delivered rules. The A/B off side removes the marked block as well.
export function screenshotGuidance(text, enabled = true) {
  const start = text?.indexOf(SCREENSHOT_GUIDANCE_START) ?? -1;
  const end = text?.indexOf(SCREENSHOT_GUIDANCE_END, start) ?? -1;
  if (start >= 0 && end >= 0) {
    const after = end + SCREENSHOT_GUIDANCE_END.length;
    text = !enabled
      ? text.slice(0, start) + text.slice(after).replace(/^\n\n/, '')
      : text.slice(0, start) + text.slice(start + SCREENSHOT_GUIDANCE_START.length, end).trim() + text.slice(after);
  }
  return text;
}
