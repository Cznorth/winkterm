"use client";

import { useState, useEffect } from "react";
import SplitLayout from "@/components/Layout";
import AIPanel from "@/components/AIPanel";
import LanguageSelector from "@/components/LanguageSelector";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";

export default function Home() {
  const { setLocale } = useI18n();
  const [showLangSelector, setShowLangSelector] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("winkterm-language");
    if (saved) {
      setLocale(saved as "zh" | "en");
      setReady(true);
      return;
    }
    // Check backend config
    axios.get("/api/settings").then((res) => {
      const lang = res.data.language;
      if (lang) {
        setLocale(lang as "zh" | "en");
        setReady(true);
      } else {
        setShowLangSelector(true);
        setReady(true);
      }
    }).catch(() => {
      setShowLangSelector(true);
      setReady(true);
    });
  }, [setLocale]);

  const handleLanguageSelect = (language: "zh" | "en") => {
    setLocale(language);
    setShowLangSelector(false);
    // Save to backend config
    axios.post("/api/settings", { language }).catch(() => {});
  };

  if (!ready) return null;

  return (
    <>
      {showLangSelector && <LanguageSelector onSelect={handleLanguageSelect} />}
      <SplitLayout aiPanel={<AIPanel />} />
    </>
  );
}
