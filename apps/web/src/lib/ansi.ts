// Minimal ANSI SGR → styled segments parser (colors, 256-color, truecolor, bold/dim/italic/underline).
// Log panes are always rendered on a dark terminal surface, so the palette targets dark backgrounds.

export interface AnsiSegment {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const BASE = ['#3b4252', '#ff6b6b', '#4ade80', '#facc15', '#60a5fa', '#e879f9', '#22d3ee', '#e5e7eb'];
const BRIGHT = ['#6b7280', '#ff8787', '#86efac', '#fde047', '#93c5fd', '#f0abfc', '#67e8f9', '#ffffff'];

function color256(n: number): string {
  if (n < 8) return BASE[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return `rgb(${steps[Math.floor(i / 36)]},${steps[Math.floor((i % 36) / 6)]},${steps[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

// eslint-disable-next-line no-control-regex
const ESC_RE = /\u001b\[([0-9;]*)([A-Za-z])/g;

export function hasAnsi(s: string): boolean {
  return s.includes('\u001b[');
}

export function stripAnsi(s: string): string {
  return s.replace(ESC_RE, '');
}

export function parseAnsi(input: string): AnsiSegment[] {
  if (!hasAnsi(input)) return [{ text: input }];
  const out: AnsiSegment[] = [];
  let state: Omit<AnsiSegment, 'text'> = {};
  let last = 0;
  ESC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ESC_RE.exec(input))) {
    if (m.index > last) out.push({ ...state, text: input.slice(last, m.index) });
    last = ESC_RE.lastIndex;
    if (m[2] !== 'm') continue; // ignore cursor movement etc.
    const codes = m[1] === '' ? [0] : m[1].split(';').map((c) => Number(c) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) state = {};
      else if (c === 1) state = { ...state, bold: true };
      else if (c === 2) state = { ...state, dim: true };
      else if (c === 3) state = { ...state, italic: true };
      else if (c === 4) state = { ...state, underline: true };
      else if (c === 22) state = { ...state, bold: false, dim: false };
      else if (c === 23) state = { ...state, italic: false };
      else if (c === 24) state = { ...state, underline: false };
      else if (c >= 30 && c <= 37) state = { ...state, fg: BASE[c - 30] };
      else if (c >= 90 && c <= 97) state = { ...state, fg: BRIGHT[c - 90] };
      else if (c >= 40 && c <= 47) state = { ...state, bg: BASE[c - 40] };
      else if (c >= 100 && c <= 107) state = { ...state, bg: BRIGHT[c - 100] };
      else if (c === 39) state = { ...state, fg: undefined };
      else if (c === 49) state = { ...state, bg: undefined };
      else if (c === 38 || c === 48) {
        const key = c === 38 ? 'fg' : 'bg';
        if (codes[i + 1] === 5 && codes[i + 2] != null) {
          state = { ...state, [key]: color256(codes[i + 2]) };
          i += 2;
        } else if (codes[i + 1] === 2 && codes[i + 4] != null) {
          state = { ...state, [key]: `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})` };
          i += 4;
        }
      }
    }
  }
  if (last < input.length) out.push({ ...state, text: input.slice(last) });
  return out;
}
