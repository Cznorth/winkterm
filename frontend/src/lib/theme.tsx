"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react";

export type ThemeMode = "system" | "dark" | "light";
const STORAGE_KEY = "winkterm-theme";

export function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "dark") return "dark";
  if (mode === "light") return "light";
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(resolved: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", resolved);
}

interface ThemeContextType {
  themeMode: ThemeMode;
  resolvedTheme: "dark" | "light";
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType>({
  themeMode: "system",
  resolvedTheme: "dark",
  setThemeMode: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeModeState] = useState<ThemeMode>("system");
  const [resolvedTheme, setResolvedState] = useState<"dark" | "light">("dark");

  const syncResolved = useCallback((mode: ThemeMode) => {
    const resolved = resolveTheme(mode);
    setResolvedState(resolved);
    applyTheme(resolved);
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    localStorage.setItem(STORAGE_KEY, mode);
    syncResolved(mode);
  }, [syncResolved]);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    const mode = saved && ["system", "dark", "light"].includes(saved) ? saved : "system";
    setThemeModeState(mode);
    syncResolved(mode);
  }, [syncResolved]);

  useEffect(() => {
    if (themeMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const handler = () => syncResolved("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themeMode, syncResolved]);

  return (
    <ThemeContext.Provider value={{ themeMode, resolvedTheme, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export const xtermDarkTheme = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#aeafad",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#1e1e1e",
  brightBlack: "#6e6e6e",
  red: "#f14c4c",
  brightRed: "#f14c4c",
  green: "#23d18b",
  brightGreen: "#3fcf8e",
  yellow: "#e2e084",
  brightYellow: "#e2e084",
  blue: "#3794ff",
  brightBlue: "#3794ff",
  magenta: "#c586c0",
  brightMagenta: "#d679d1",
  cyan: "#4ec9b0",
  brightCyan: "#4ec9b0",
  white: "#d4d4d4",
  brightWhite: "#d4d4d4",
};

export const xtermLightTheme = {
  background: "#ffffff",
  foreground: "#1e1e1e",
  cursor: "#1e1e1e",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  black: "#1e1e1e",
  brightBlack: "#6e6e6e",
  red: "#f14c4c",
  brightRed: "#f14c4c",
  green: "#23d18b",
  brightGreen: "#3fcf8e",
  yellow: "#e2e084",
  brightYellow: "#e2e084",
  blue: "#3794ff",
  brightBlue: "#3794ff",
  magenta: "#c586c0",
  brightMagenta: "#d679d1",
  cyan: "#4ec9b0",
  brightCyan: "#4ec9b0",
  white: "#d4d4d4",
  brightWhite: "#d4d4d4",
};
