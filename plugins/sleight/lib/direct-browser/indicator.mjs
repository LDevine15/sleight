import { escapeLabel } from './consent-ui.mjs';

// Presentation only. No DOM, cursor motion, sleep or authority is supplied here.
export function createIndicator({ now = Date.now } = {}) {
  const sessions = new Set();
  let connected = false, paused = false, since = 0, name = '';
  return {
    connected(browserName) { connected = true; paused = false; since = now(); name = escapeLabel(browserName); },
    disconnected() { connected = false; paused = false; sessions.clear(); },
    pause(value) { paused = value; },
    addSession(id) { sessions.add(id); },
    removeSession(id) { sessions.delete(id); },
    view() {
      const animating = connected && !paused && now() - since < 1000;
      const status = sessions.size ? `${sessions.size} session${sessions.size === 1 ? '' : 's'}` : 'idle';
      return { connected, paused, sessions: sessions.size, animating, mark: animating ? 'sleight' : null,
        text: !connected ? `${name || 'Browser'} disconnected` : paused ? `${name} connected · paused`
          : animating ? `sleight is connected to ${name}.` : `${name} connected · ${status}`,
        buttons: connected ? [paused ? 'Resume' : 'Pause', 'Disconnect'] : [] };
    },
  };
}
