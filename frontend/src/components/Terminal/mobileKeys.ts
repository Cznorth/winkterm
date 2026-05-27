/** xterm / VT100 常用控制序列 */
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

/** Ctrl + 单字符（ASCII control code） */
export function ctrlChar(char: string): string {
  const code = char.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) return char;
  return String.fromCharCode(code - 64);
}

/** Alt + 单字符（ESC 前缀） */
export function altChar(char: string): string {
  return `\x1b${char}`;
}
