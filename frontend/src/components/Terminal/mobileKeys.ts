/** Common xterm / VT100 control sequences */
export const TERMINAL_SEQUENCES = {
  esc: "\x1b",
  tab: "\t",
  enter: "\r",
  backspace: "\x7f",
  pgUp: "\x1b[5~",
  pgDn: "\x1b[6~",
  home: "\x1b[H",
  end: "\x1b[F",
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
} as const;

/** Ctrl + single character (ASCII control code) */
export function ctrlChar(char: string): string {
  const code = char.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) return char;
  return String.fromCharCode(code - 64);
}

/** Alt + single character (ESC prefix) */
export function altChar(char: string): string {
  return `\x1b${char}`;
}
