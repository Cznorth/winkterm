"use client";

import { useState, useEffect } from "react";
import SplitLayout from "@/components/Layout";
import AIPanel from "@/components/AIPanel";
import LanguageSelector from "@/components/LanguageSelector";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";

export default function Home() {
  const { setLocale } = useI18n();
  const { setThemeMode } = useTheme();
  const [showLangSelector, setShowLangSelector] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const savedLang = localStorage.getItem("winkterm-language");
    const savedTheme = localStorage.getItem("winkterm-theme");

    if (savedLang) {
      setLocale(savedLang as "zh" | "en");
    }

    if (savedLang && savedTheme) {
      setReady(true);
      return;
    }

    axios.get("/api/settings").then((res) => {
      if (!savedLang) {
        const lang = res.data.language;
        if (lang) {
          setLocale(lang as "zh" | "en");
        } else {
          setShowLangSelector(true);
        }
      }
      if (!savedTheme && res.data.theme) {
        setThemeMode(res.data.theme as "system" | "dark" | "light");
      }
      setReady(true);
    }).catch(() => {
      if (!savedLang) setShowLangSelector(true);
      setReady(true);
    });
  }, [setLocale, setThemeMode]);

  const handleLanguageSelect = (language: "zh" | "en") => {
    setLocale(language);
    setShowLangSelector(false);
    // Save to backend config
    axios.post("/api/settings", { language }).catch(() => {});
  };

  if (!ready) {
    return <div style={{ width: "100%", height: "var(--app-height, 100vh)", background: "var(--bg-primary)" }} aria-busy="true" />;
  }

  return (
    <>
      {showLangSelector && <LanguageSelector onSelect={handleLanguageSelect} />}
      <SplitLayout aiPanel={<AIPanel />} />
    </>
  );
}
