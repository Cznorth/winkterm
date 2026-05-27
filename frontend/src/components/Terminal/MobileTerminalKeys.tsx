"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { TERMINAL_SEQUENCES, altChar, ctrlChar } from "./mobileKeys";
import "./MobileTerminalKeys.css";

interface MobileTerminalKeysProps {
  onSend: (data: string) => void;
  visible?: boolean;
}

type Modifier = "ctrl" | "alt" | null;

const EXTENDED_KEYS = ["-", "_", "/", "\\", "|", "`", "~", "#", "$", "&", "*", "(", ")", "'", '"', ";", ":"];

export default function MobileTerminalKeys({ onSend, visible = true }: MobileTerminalKeysProps) {
  const { t } = useI18n();
  useKeyboardInset(visible);
  const [modifier, setModifier] = useState<Modifier>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  const send = useCallback(
    (data: string) => {
      onSend(data);
      setMenuOpen(false);
    },
    [onSend]
  );

  const sendPlain = useCallback(
    (data: string) => {
      send(data);
      setModifier(null);
    },
    [send]
  );

  const sendChar = useCallback(
    (char: string) => {
      if (modifier === "ctrl") {
        send(ctrlChar(char));
      } else if (modifier === "alt") {
        send(altChar(char));
      } else {
        send(char);
      }
      setModifier(null);
    },
    [modifier, send]
  );

  const toggleModifier = useCallback((next: Modifier) => {
    setModifier((current) => (current === next ? null : next));
    setMenuOpen(false);
  }, []);

  if (!visible) return null;

  return (
    <div className="mobile-terminal-keys" role="toolbar" aria-label={t("terminal.mobileKeys")}>
      {menuOpen && (
        <div ref={menuRef} className="mobile-terminal-keys-menu" role="menu">
          {EXTENDED_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className="mobile-terminal-key mobile-terminal-key--menu"
              role="menuitem"
              onClick={() => sendChar(key)}
            >
              {key}
            </button>
          ))}
        </div>
      )}

      <div className="mobile-terminal-keys-row">
        <KeyButton label="Esc" onPress={() => sendPlain(TERMINAL_SEQUENCES.esc)} />
        <KeyButton label="Tab" onPress={() => sendPlain(TERMINAL_SEQUENCES.tab)} />
        <KeyButton label="PgUp" onPress={() => sendPlain(TERMINAL_SEQUENCES.pgUp)} />
        <KeyButton label="Home" onPress={() => sendPlain(TERMINAL_SEQUENCES.home)} />
        <KeyButton label="▲" ariaLabel={t("terminal.keyUp")} onPress={() => sendPlain(TERMINAL_SEQUENCES.up)} />
        <KeyButton label="End" onPress={() => sendPlain(TERMINAL_SEQUENCES.end)} />
        <KeyButton
          label="⋮"
          ariaLabel={t("terminal.moreKeys")}
          active={menuOpen}
          onPress={() => setMenuOpen((open) => !open)}
        />
      </div>

      <div className="mobile-terminal-keys-row">
        <KeyButton
          label="Ctrl"
          active={modifier === "ctrl"}
          onPress={() => toggleModifier("ctrl")}
        />
        <KeyButton
          label="Alt"
          active={modifier === "alt"}
          onPress={() => toggleModifier("alt")}
        />
        <KeyButton label="PgDn" onPress={() => sendPlain(TERMINAL_SEQUENCES.pgDn)} />
        <KeyButton label="◀" ariaLabel={t("terminal.keyLeft")} onPress={() => sendPlain(TERMINAL_SEQUENCES.left)} />
        <KeyButton label="▼" ariaLabel={t("terminal.keyDown")} onPress={() => sendPlain(TERMINAL_SEQUENCES.down)} />
        <KeyButton label="▶" ariaLabel={t("terminal.keyRight")} onPress={() => sendPlain(TERMINAL_SEQUENCES.right)} />
        <KeyButton label="⇄" ariaLabel={t("terminal.keyTabAlt")} onPress={() => sendPlain(TERMINAL_SEQUENCES.tab)} />
      </div>
    </div>
  );
}

function KeyButton({
  label,
  ariaLabel,
  active = false,
  onPress,
}: {
  label: string;
  ariaLabel?: string;
  active?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className={`mobile-terminal-key${active ? " active" : ""}`}
      aria-label={ariaLabel ?? label}
      aria-pressed={active || undefined}
      onPointerDown={(event) => {
        event.preventDefault();
        onPress();
      }}
    >
      {label}
    </button>
  );
}
