"""Shared terminal utilities: ANSI stripping, control-key mapping, grep, command-echo removal."""

from __future__ import annotations

import base64
import binascii
import re

_ANSI_RE = re.compile(
    r"\x1b\[[\?0-9;]*[A-Za-z]"
    r"|\x1b\].*?(?:\x07|\x1b\\)"
    r"|\x1b[()][AB012]"
    r"|\x1b[78]"
    r"|\x1b[=>]"
)

KEY_MAP: dict[str, str] = {
    "ctrl+a": "\x01", "ctrl+b": "\x02", "ctrl+c": "\x03", "ctrl+d": "\x04",
    "ctrl+e": "\x05", "ctrl+f": "\x06", "ctrl+g": "\x07",
    "ctrl+h": "\x08", "backspace": "\x7f",
    "ctrl+i": "\x09", "tab": "\x09",
    "ctrl+j": "\x0a", "ctrl+k": "\x0b", "ctrl+l": "\x0c",
    "ctrl+m": "\x0d", "enter": "\x0d", "return": "\x0d",
    "ctrl+n": "\x0e", "ctrl+o": "\x0f", "ctrl+p": "\x10",
    "ctrl+q": "\x11", "ctrl+r": "\x12", "ctrl+s": "\x13",
    "ctrl+t": "\x14", "ctrl+u": "\x15", "ctrl+v": "\x16",
    "ctrl+w": "\x17", "ctrl+x": "\x18", "ctrl+y": "\x19",
    "ctrl+z": "\x1a",
    "esc": "\x1b", "escape": "\x1b",
    "ctrl+\\": "\x1c", "ctrl+]": "\x1d", "ctrl+^": "\x1e", "ctrl+_": "\x1f",
    "space": " ", "del": "\x7f",
    "up": "\x1b[A", "down": "\x1b[B", "right": "\x1b[C", "left": "\x1b[D",
    "home": "\x1b[H", "end": "\x1b[F",
    "pageup": "\x1b[5~", "pagedown": "\x1b[6~",
    "insert": "\x1b[2~", "delete": "\x1b[3~",
    "f1": "\x1bOP", "f2": "\x1bOQ", "f3": "\x1bOR", "f4": "\x1bOS",
    "f5": "\x1b[15~", "f6": "\x1b[17~", "f7": "\x1b[18~", "f8": "\x1b[19~",
    "f9": "\x1b[20~", "f10": "\x1b[21~", "f11": "\x1b[23~", "f12": "\x1b[24~",
}


class UnknownKeyError(ValueError):
    """A named key in the request is not recognized by KEY_MAP."""


def resolve_keys(keys: list[str]) -> str:
    """Translate a list of named keys into the actual control-byte sequence."""
    out: list[str] = []
    for raw in keys:
        if not raw:
            continue
        norm = raw.strip().lower().replace(" ", "")
        seq = KEY_MAP.get(norm)
        if seq is None:
            raise UnknownKeyError(f"未知命名键: {raw!r}（支持列表见 KEY_MAP）")
        out.append(seq)
    return "".join(out)


def strip_ansi(text: str) -> str:
    """Remove ANSI escape sequences and normalize \\r\\n / \\r to \\n."""
    text = _ANSI_RE.sub("", text)
    return text.replace("\r\n", "\n").replace("\r", "\n")


def strip_command_echo(output: str, command: str) -> str:
    """Strip the command echo line from PTY output."""
    if not command:
        return output
    first_line = command.splitlines()[0].strip()
    if not first_line:
        return output
    lines = output.split("\n")
    for i, line in enumerate(lines):
        if first_line in line:
            return "\n".join(lines[i + 1:])
    return output


def grep_lines(text: str, pattern: str, context: int = 0, case_insensitive: bool = False) -> dict:
    """Line-level grep on text, optionally returning surrounding context."""
    flags = re.IGNORECASE if case_insensitive else 0
    try:
        regex = re.compile(pattern, flags)
    except re.error as exc:
        raise ValueError(f"非法正则: {exc}") from exc

    lines = text.split("\n")
    matches: list[dict] = []
    matched_idx: set[int] = set()
    for i, line in enumerate(lines):
        if regex.search(line):
            matched_idx.add(i)

    if not matched_idx:
        return {"matches": [], "match_count": 0, "total_lines": len(lines)}

    if context <= 0:
        for i in sorted(matched_idx):
            matches.append({"line_no": i + 1, "line": lines[i]})
    else:
        wanted: set[int] = set()
        for i in matched_idx:
            for j in range(max(0, i - context), min(len(lines), i + context + 1)):
                wanted.add(j)
        for i in sorted(wanted):
            matches.append({
                "line_no": i + 1,
                "line": lines[i],
                "match": i in matched_idx,
            })

    return {
        "matches": matches,
        "match_count": len(matched_idx),
        "total_lines": len(lines),
    }


def decode_b64(value: str) -> str:
    """Decode base64 text with a friendly error on failure."""
    try:
        return base64.b64decode(value, validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise ValueError(f"base64 解码失败: {exc}") from exc


def _looks_like_gbk_mojibake(text: str) -> bool:
    """Heuristic: does a *successful* UTF-8 decode actually look like GBK garbage?

    Some GBK byte sequences are coincidentally valid UTF-8 and decode without
    error into rare Latin Extended / IPA / spacing-modifier / Greek code points
    (e.g. GBK ``模式`` -> ``ģʽ``). Such characters U+0100..U+04FF essentially
    never appear in real terminal/ops output, so their presence is a strong
    mojibake signal worth a GBK re-decode attempt.
    """
    return any(0x0100 <= ord(ch) <= 0x04FF for ch in text)


def _has_cjk(text: str) -> bool:
    return any(0x4E00 <= ord(ch) <= 0x9FFF for ch in text)


def decode_terminal_text(data: bytes) -> str:
    """Decode raw PTY/SSH bytes to text, tolerating non-UTF-8 locales.

    Remote hosts with a GBK/CP936 locale (common on Chinese Windows and some
    CentOS/older installs) emit GBK-encoded bytes; decoding those as UTF-8 yields
    garble -- either replacement chars (``版本`` -> ``�汾``) when the bytes are
    invalid UTF-8, or rare Latin glyphs (``模式`` -> ``ģʽ``) when they happen to
    be valid UTF-8. Strategy:

    1. UTF-8 strict. If it succeeds but the result looks like GBK mojibake
       (rare Latin-Extended range) *and* a GBK re-decode yields real CJK, prefer
       the GBK reading. Otherwise keep the UTF-8 result.
    2. UTF-8 failed -> GBK strict, recovering Chinese GBK output.
    3. Both failed -> lossy UTF-8 for genuinely mixed/binary bytes.

    Pure ASCII and ordinary UTF-8 (including UTF-8 Chinese) are unaffected: they
    never enter the rare-range branch and never fail UTF-8 decoding.
    """
    if not data:
        return ""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        try:
            return data.decode("gbk")
        except UnicodeDecodeError:
            return data.decode("utf-8", errors="replace")

    if _looks_like_gbk_mojibake(text):
        try:
            gbk = data.decode("gbk")
        except UnicodeDecodeError:
            return text
        if _has_cjk(gbk):
            return gbk
    return text
