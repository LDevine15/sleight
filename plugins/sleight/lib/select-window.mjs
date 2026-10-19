export const SELECT_WINDOW_TOOL = {
  name: 'select_window',
  description: 'Choose one running app window by exact title or file URL through AXRaise/AXMain, without activating the app. ' +
    'If no title matches exactly, a unique ending may match within that app only at the title start or after whitespace. ' +
    'The request must contain at least 12 Unicode code points after trim(), excluding format (Cf) and combining (M) characters from the count. Matching still uses the original request. ' +
    'Then use one standalone js call to acquire the app and verify its full Window/URL header before acting. ' +
    'Use windowNumber to distinguish equal titles. Missing or duplicate matches stop selection. The user approves window selection once per app per session.',
  inputSchema: { type: 'object', properties: {
    app: { type: 'string', description: 'Running app name, bundle ID or path' },
    title: { type: 'string', description: 'Window title, use when no file URL is known' },
    url: { type: 'string', description: 'Exact file URL from AXDocument, preferred over title' },
    windowNumber: { type: 'integer', minimum: 1, description: 'Native window number, to distinguish equal titles' },
  }, required: ['app'], additionalProperties: false },
};
export async function selectWindow(args, { approve, runScript }) {
  const text = (value, isError) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });
  const hasTitle = args.title !== undefined, hasURL = args.url !== undefined;
  if (typeof args.app !== 'string' || !args.app || (hasTitle === hasURL) ||
      (hasTitle && typeof args.title !== 'string') || (hasURL && (typeof args.url !== 'string' || !args.url.startsWith('file://'))) ||
      (args.windowNumber !== undefined && (!Number.isSafeInteger(args.windowNumber) || args.windowNumber <= 0))) {
    return text(/* notice */ 'select_window needs app and one title or file URL. With no exact title, a unique ending may match after whitespace: 12+ code points after trim(), excluding Cf and M characters.', true);
  }
  if (!await approve(['select_window', args.app], `Allow Claude to select a window in ${args.app}? It changes the app's main window without activating the app.`)) {
    return text(`The user didn't allow window selection in ${args.app}. Stop and tell them.`, true);
  }
  const result = await runScript('select-window.js', args);
  return result.ok ? text(JSON.stringify(result)) : text(result.error, true);
}
