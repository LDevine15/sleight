// A small virtual terminal for the claude-cu pty. Claude Code (Ink) redraws differentially, with relative cursor moves and
// absolute columns, so after a key the new bytes only overwrite part of the card (approval-block-cu4.json, 2026-10-17).
// Flattening the byte stream loses what the overwrite left standing; this grid keeps it.
// The size is the one pty-bridge.py sets with TIOCSWINSZ (60 rows, 180 columns), which script(1) passes on to Claude Code.
export const COLUMNS = 180, ROWS = 60;

// Wide cells for CJK and emoji ranges; combining marks and joiners take no cell.
const wide = cp => cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f || cp >= 0xac00 && cp <= 0xd7a3 ||
  cp >= 0xf900 && cp <= 0xfaff || cp >= 0xfe30 && cp <= 0xfe4f || cp >= 0xff00 && cp <= 0xff60 || cp >= 0xffe0 && cp <= 0xffe6 ||
  cp >= 0x1f300 && cp <= 0x1faff || cp >= 0x20000 && cp <= 0x3fffd);
const zeroWidth = ch => /^[\p{M}\u200b-\u200f\u2060\ufe00-\ufe0f]$/u.test(ch);

export class VirtualTerminal {
  constructor({ columns = COLUMNS, rows = ROWS } = {}) {
    Object.assign(this, { columns, rows, pending: '' });
    this.reset();
  }
  reset() {
    this.screen = Array.from({ length: this.rows }, () => this.blank());
    this.x = 0; this.y = 0; this.wrap = false; this.saved = { x: 0, y: 0 };
  }
  blank() { return Array(this.columns).fill(' '); }
  // Lines scrolled off the top are gone, as they are for the redraw: a stale card fragment there must not be parsed.
  lineFeed() {
    if (this.y < this.rows - 1) this.y++;
    else { this.screen.shift(); this.screen.push(this.blank()); }
  }
  put(ch) {
    const row = this.screen[this.y];
    if (zeroWidth(ch)) { const at = Math.max(0, this.x - (this.wrap ? 0 : 1)); row[at] += ch; return; }
    const width = wide(ch.codePointAt(0)) ? 2 : 1;
    if (this.wrap || this.x + width > this.columns) { this.x = 0; this.lineFeed(); this.wrap = false; }
    const cells = this.screen[this.y];
    // Overwriting half of a wide character blanks the other half.
    if (cells[this.x] === '' && this.x > 0) cells[this.x - 1] = ' ';
    if (width === 1 && cells[this.x + 1] === '') cells[this.x + 1] = ' ';
    cells[this.x] = ch; if (width === 2) cells[this.x + 1] = '';
    this.x += width;
    if (this.x >= this.columns) { this.x = this.columns - 1; this.wrap = true; }
  }
  erase(row, from, to) { for (let i = from; i < to; i++) this.screen[row][i] = ' '; }
  csi(params, final) {
    const n = (i, d = 1) => Number(params[i]) || d, clampX = v => Math.max(0, Math.min(this.columns - 1, v)),
      clampY = v => Math.max(0, Math.min(this.rows - 1, v));
    this.wrap = false;
    switch (final) {
      case 'A': this.y = clampY(this.y - n(0)); break;
      case 'B': this.y = clampY(this.y + n(0)); break;
      case 'C': this.x = clampX(this.x + n(0)); break;
      case 'D': this.x = clampX(this.x - n(0)); break;
      case 'E': this.y = clampY(this.y + n(0)); this.x = 0; break;
      case 'F': this.y = clampY(this.y - n(0)); this.x = 0; break;
      case 'G': case '`': this.x = clampX(n(0) - 1); break;
      case 'd': this.y = clampY(n(0) - 1); break;
      case 'H': case 'f': this.y = clampY(n(0) - 1); this.x = clampX(n(1) - 1); break;
      case 'K': {
        const mode = n(0, 0);
        this.erase(this.y, mode === 0 ? this.x : 0, mode === 1 ? this.x + 1 : this.columns); break;
      }
      case 'J': {
        const mode = n(0, 0);
        if (mode === 3) break;
        if (mode === 2) { this.screen = this.screen.map(() => this.blank()); break; }
        for (let r = 0; r < this.rows; r++) {
          if (mode === 0 ? r > this.y : r < this.y) this.erase(r, 0, this.columns);
        }
        this.erase(this.y, mode === 0 ? this.x : 0, mode === 0 ? this.columns : this.x + 1); break;
      }
      case 'X': this.erase(this.y, this.x, Math.min(this.columns, this.x + n(0))); break;
      case 's': if (!params.length) this.saved = { x: this.x, y: this.y }; break;
      case 'u': if (!params.length) ({ x: this.x, y: this.y } = this.saved); break;
      // SGR and everything else draw nothing.
    }
  }
  write(data) {
    const text = this.pending + data; this.pending = '';
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\x1b') {
        const rest = text.slice(i, i + 4096);
        const csi = /^\x1b\[([<=>?]?)([0-9;:]*)([ -/]*)([@-~])/.exec(rest);
        if (csi) {
          if (!csi[1] && !csi[3]) this.csi(csi[2] ? csi[2].split(';') : [], csi[4]);
          i += csi[0].length; continue;
        }
        const string = /^\x1b[\]P_^X][\s\S]*?(?:\x07|\x1b\\)/.exec(rest), other = /^\x1b[ -/]*[0-~]/.exec(rest);
        if (string) { i += string[0].length; continue; }
        // An unfinished sequence waits for the next chunk; a stray or overlong one is dropped.
        if (/^\x1b(?:\[[<=>?]?[0-9;:]*[ -/]*|[\]P_^X][\s\S]*|[ -/]*)$/.test(rest) && rest.length < 4096 && i + rest.length === text.length) {
          this.pending = rest; break;
        }
        if (other && !/^\x1b[\]P_^X\[]/.test(rest)) {
          const final = other[0].at(-1);
          if (other[0].length === 2) {
            if (final === '7') this.saved = { x: this.x, y: this.y };
            else if (final === '8') { ({ x: this.x, y: this.y } = this.saved); this.wrap = false; }
            else if (final === 'c') this.reset();
          }
          i += other[0].length; continue;
        }
        i++; continue;
      }
      // Claude Code writes bare LF expecting the usual output processing, which the raw bridge pty turns off: LF starts a line.
      if (ch === '\n' || ch === '\v' || ch === '\f') { this.x = 0; this.wrap = false; this.lineFeed(); }
      else if (ch === '\r') { this.x = 0; this.wrap = false; }
      else if (ch === '\b') { this.x = Math.max(0, this.x - 1); this.wrap = false; }
      else if (ch === '\t') this.x = Math.min(this.columns - 1, (Math.floor(this.x / 8) + 1) * 8);
      else if (ch >= ' ' && ch !== '\x7f' && !(ch >= '\x80' && ch <= '\x9f')) {
        const cp = text.codePointAt(i), char = String.fromCodePoint(cp);
        this.put(char); i += char.length; continue;
      }
      i++;
    }
  }
  // The visible screen as text, each line's trailing spaces trimmed and blank lines below the content dropped. The text ends
  // in a newline unless the cursor sits just past the last line, which is then still being written.
  render() {
    const lines = this.screen.map(row => row.join('').trimEnd());
    let last = lines.length - 1;
    while (last >= 0 && !lines[last]) last--;
    if (last < 0) return '';
    const row = this.screen[this.y];
    let end = this.columns;
    while (end > 0 && row[end - 1] === ' ') end--;
    const open = this.y === last && (this.wrap || this.x >= end);
    return lines.slice(0, last + 1).join('\n') + (open ? '' : '\n');
  }
}
