// Shared by the native driver and offline evidence collectors. Successful tool content is not a refusal.
export function hasPermissionRefusal(event) {
  if (!Array.isArray(event?.message?.content)) return false;
  return event.message.content.some(item => {
    if (item.type !== 'tool_result' || item.is_error !== true) return false;
    const text = typeof item.content === 'string' ? item.content :
      (Array.isArray(item.content) ? item.content.map(block => block.text ?? '').join('\n') : '');
    const browserRefusal = text.includes('Browser Use could not complete this action') && /permission request[^\n]*(dismissed|denied)/i.test(text);
    return browserRefusal || /Computer Use is not allowed to use the app '[^']+' for safety reasons/.test(text) ||
      /Computer Use was not approved to use [^\n]+/.test(text) ||
      /The user (?:didn't allow|did not allow|did not approve)\b/.test(text) ||
      /^\s*(?:approval declined|permission denied|not approved)\s*$/i.test(text);
  });
}
