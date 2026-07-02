"use client";

import { useState, useEffect } from "react";
import SplitLayout from "@/components/Layout";
import AIPanel from "@/components/AIPanel";
import LanguageSelector from "@/components/LanguageSelector";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";

interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_url: string;
  release_notes: string;
  asset_name: string;
  asset_size: number;
  platform_supported: boolean;
}

interface UpdateJob {
  job_id: string;
  status: string;
  done: boolean;
  downloaded: number;
  total: number;
  speed: number;
  progress: number;
  error?: string;
}

const summarizeReleaseNotes = (notes: string) => (
  notes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 5)
);

const isDesktopRuntime = () => (
  typeof window !== "undefined" && !!window.pywebview?.api
);

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
};

export default function Home() {
  const { t, setLocale } = useI18n();
  const { setThemeMode } = useTheme();
  const [showLangSelector, setShowLangSelector] = useState(false);
  const [ready, setReady] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);

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

  useEffect(() => {
    setIsDesktop(isDesktopRuntime());
    axios.get("/api/app/update/check").then((res) => {
      const latest = res.data?.latest_version;
      const skipped = latest && localStorage.getItem("winkterm-skip-update-version") === latest;
      if (res.data?.update_available && !skipped) {
        setUpdateInfo(res.data);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsDesktop(isDesktopRuntime()), 300);
    return () => window.clearTimeout(timer);
  }, []);

  const handleLanguageSelect = (language: "zh" | "en") => {
    setLocale(language);
    setShowLangSelector(false);
    // Save to backend config
    axios.post("/api/settings", { language }).catch(() => {});
  };

  const handleInstallUpdate = async () => {
    if (!updateInfo) return;
    if (!updateInfo.platform_supported) {
      window.open(updateInfo.release_url, "_blank", "noopener,noreferrer");
      return;
    }
    setUpdating(true);
    setUpdateJob(null);
    try {
      const res = await axios.post("/api/app/update/install");
      const jobId = res.data?.job_id;
      if (!jobId) {
        setUpdating(false);
        return;
      }
      const timer = window.setInterval(async () => {
        const jobRes = await axios.get(`/api/app/update/install/${jobId}`);
        const job = jobRes.data as UpdateJob;
        setUpdateJob(job);
        if (job.done) {
          window.clearInterval(timer);
          setUpdating(false);
          if (!job.error) setUpdateInfo(null);
        }
      }, 500);
    } catch {
      setUpdating(false);
    }
  };

  const handleSkipUpdate = () => {
    if (updateInfo?.latest_version) {
      localStorage.setItem("winkterm-skip-update-version", updateInfo.latest_version);
    }
    setUpdateInfo(null);
  };

  if (!ready) {
    return <div style={{ width: "100%", height: "var(--app-height, 100vh)", background: "var(--bg-primary)" }} aria-busy="true" />;
  }

  return (
    <>
      {showLangSelector && <LanguageSelector onSelect={handleLanguageSelect} />}
      {updateInfo && (
        <div className="update-banner" role="status">
          <div className="update-banner-main">
            <strong>{t("update.available")}</strong>
            <span>{updateInfo.current_version} → {updateInfo.latest_version}</span>
            <ul>
              {summarizeReleaseNotes(updateInfo.release_notes).map((line) => (
                <li key={line}>{line.replace(/^- /, "")}</li>
              ))}
            </ul>
            {updating && (
              <div className="update-progress">
                <div>
                  <span>{updateJob?.progress || 0}%</span>
                  <span>{updateJob?.status || "downloading"}</span>
                </div>
                <progress max={100} value={updateJob?.progress || 0} />
                <div>
                  <span>
                    {formatBytes(updateJob?.downloaded || 0)} / {formatBytes(updateJob?.total || updateInfo.asset_size || 0)}
                  </span>
                  <span>{formatBytes(updateJob?.speed || 0)}/s</span>
                </div>
              </div>
            )}
            {updateJob?.error && <span className="update-error">{updateJob.error}</span>}
          </div>
          {isDesktop ? (
            <button className="update-primary" onClick={handleInstallUpdate} disabled={updating}>
              {updating ? t("update.downloading") : t("update.install")}
            </button>
          ) : (
            <button className="update-primary" onClick={() => window.open(updateInfo.release_url, "_blank", "noopener,noreferrer")}>
              {t("update.viewRelease")}
            </button>
          )}
          <button onClick={handleSkipUpdate}>
            {t("update.skipVersion")}
          </button>
          <button onClick={() => setUpdateInfo(null)} aria-label={t("update.dismiss")}>
            ×
          </button>
        </div>
      )}
      <SplitLayout aiPanel={<AIPanel />} />
    </>
  );
}
