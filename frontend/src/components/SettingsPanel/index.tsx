"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/lib/toast";
import { useTheme } from "@/lib/theme";
import { getApiBaseUrl } from "@/lib/config";
import { getAccessKey } from "@/lib/auth";
import "./SettingsPanel.css";

interface ModelInfo {
  id: string;
  name: string;
  provider?: string;
}

type CandidateStatus = "unknown" | "testing" | "ok" | "failed";

interface CandidateModel extends ModelInfo {
  selected: boolean;
  status: CandidateStatus;
  error?: string;
}

interface Settings {
  api_format: "openai" | "anthropic" | "codex";
  base_url: string;
  api_key: string;
  models: ModelInfo[];
  selected_model: string;
  agent_api_token: string;
  web_access_key: string;
  theme: string;
  codex_client_version: string;
}

interface CodexClientVersionInfo {
  effective: string;
  source: string;
  default: string;
  config: string;
  codex_cli: string;
}

interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_url: string;
  release_notes: string;
  asset_name: string;
  asset_size: number;
  platform_supported: boolean;
  error?: string;
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

interface CodexStatus {
  installed: boolean;
  logged_in: boolean;
  cli_logged_in?: boolean;
  message: string;
  client_version?: CodexClientVersionInfo;
  oauth?: {
    active: boolean;
    state: string;
    message: string;
    auth_url?: string;
  };
}

const summarizeReleaseNotes = (notes: string) => (
  notes
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 6)
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

const SettingsIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const ApiIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
    <polyline points="22,6 12,13 2,6" />
  </svg>
);

const ModelIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
    <rect x="9" y="9" width="6" height="6" />
    <line x1="9" y1="1" x2="9" y2="4" />
    <line x1="15" y1="1" x2="15" y2="4" />
    <line x1="9" y1="20" x2="9" y2="23" />
    <line x1="15" y1="20" x2="15" y2="23" />
    <line x1="20" y1="9" x2="23" y2="9" />
    <line x1="20" y1="14" x2="23" y2="14" />
    <line x1="1" y1="9" x2="4" y2="9" />
    <line x1="1" y1="14" x2="4" y2="14" />
  </svg>
);

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </svg>
);

const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const PlusIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const ErrorIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const GITHUB_REPO_URL = "https://github.com/Cznorth/winkterm";

const CODEX_MODEL_PRESETS: ModelInfo[] = [
  { id: "gpt-5.4-mini", name: "GPT-5.4 mini (Codex)", provider: "codex" },
  { id: "gpt-5.5", name: "GPT-5.5 (Codex)", provider: "codex" },
];

const isCodexModelId = (id: string) => CODEX_MODEL_PRESETS.some((m) => m.id === id);

function sanitizeSettingsFromApi(data: Record<string, unknown>): Settings {
  const apiFormat = (data.api_format as Settings["api_format"]) || "openai";
  let models = (data.models as ModelInfo[]) || [];
  let selectedModel = (data.selected_model as string) || "";
  if (apiFormat === "codex") {
    const codexModels = models.filter((m) => isCodexModelId(m.id));
    models = codexModels.length ? codexModels : [...CODEX_MODEL_PRESETS];
    if (!isCodexModelId(selectedModel)) {
      selectedModel = "gpt-5.4-mini";
    }
  }
  return {
    api_format: apiFormat,
    base_url: (data.base_url as string) || "",
    api_key: (data.api_key as string) || "",
    models,
    selected_model: selectedModel,
    agent_api_token: (data.agent_api_token as string) || "",
    web_access_key: (data.web_access_key as string) || "",
    theme: (data.theme as string) || "system",
    codex_client_version: (data.codex_client_version as string) || "",
  };
}

type SettingsSectionId =
  | "ai-setup"
  | "models"
  | "agent-behavior"
  | "security"
  | "appearance"
  | "about";

type DocEditorId = "agents" | "memory" | null;

type AiSetupStatus = "not-configured" | "needs-auth" | "testing" | "ready" | "error";

const SECTION_IDS: SettingsSectionId[] = [
  "ai-setup",
  "models",
  "agent-behavior",
  "security",
  "appearance",
  "about",
];

export default function SettingsPanel() {
  const { t, locale, setLocale } = useI18n();
  const toast = useToast();
  const { themeMode, setThemeMode } = useTheme();
  const [settings, setSettings] = useState<Settings>({
    api_format: "openai",
    base_url: "",
    api_key: "",
    models: [],
    selected_model: "",
    agent_api_token: "",
    web_access_key: "",
    theme: "system",
    codex_client_version: "",
  });
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [candidateModels, setCandidateModels] = useState<CandidateModel[]>([]);
  const [fetchError, setFetchError] = useState("");
  const [streamTesting, setStreamTesting] = useState(false);
  const [streamOutput, setStreamOutput] = useState("");
  const [streamError, setStreamError] = useState("");
  const [streamSuccess, setStreamSuccess] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamTestFingerprintRef = useRef<string>("");
  const [tokenEditing, setTokenEditing] = useState(false);
  const [agentsMd, setAgentsMd] = useState("");
  const [memoryMd, setMemoryMd] = useState("");
  const [savingAgentsMd, setSavingAgentsMd] = useState(false);
  const [savingMemoryMd, setSavingMemoryMd] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null);
  const [codexLoggingIn, setCodexLoggingIn] = useState(false);
  const [codexLoggingOut, setCodexLoggingOut] = useState(false);
  const [codexAuthUrl, setCodexAuthUrl] = useState("");
  const [codexCallbackUrl, setCodexCallbackUrl] = useState("");
  const [codexCallbackError, setCodexCallbackError] = useState("");
  const [codexCallbackSubmitting, setCodexCallbackSubmitting] = useState(false);
  const [codexOAuthError, setCodexOAuthError] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSectionId>("ai-setup");
  const [editingDoc, setEditingDoc] = useState<DocEditorId>(null);
  const [modelsAdvancedOpen, setModelsAdvancedOpen] = useState(false);

  const copyToClipboard = (text: string) => {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
    return Promise.resolve();
  };

  const handleCopyToken = async () => {
    if (!settings.agent_api_token) return;
    let tokenToCopy = settings.agent_api_token;
    try {
      const baseUrl = getApiBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "");
      const headers: Record<string, string> = {};
      const accessKey = getAccessKey();
      if (accessKey) headers["X-Access-Key"] = accessKey;
      const r = await fetch(`${baseUrl}/api/settings/token/reveal`, { headers });
      if (r.ok) {
        const d = await r.json();
        tokenToCopy = d.token;
      }
    } catch { /* fallback to masked value */ }
    await copyToClipboard(tokenToCopy);
    toast.success(t("toast.copied"));
  };

  const installGuideUrl = `${getApiBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "")}/api/agent/install.md`;
  const installPrompt = `${t("settings.agentAccessPrompt")}${installGuideUrl}`;

  const handleGenerateToken = () => {
    if (settings.agent_api_token && !window.confirm(t("settings.regenerateTokenConfirm"))) {
      return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    setSettings((prev) => ({ ...prev, agent_api_token: token }));
  };

  const handleGenerateWebKey = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const key = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    setSettings((prev) => ({ ...prev, web_access_key: key }));
  };

  const handleCopyInstallPrompt = async () => {
    try {
      await navigator.clipboard.writeText(installPrompt);
      toast.success(t("toast.copied"));
    } catch {
      /* Ignore when clipboard is unavailable */
    }
  };

  useEffect(() => {
    axios.get("/api/settings").then((res) => {
      const data = res.data;
      setSettings(sanitizeSettingsFromApi(data));
      if (data.theme) {
        setThemeMode(data.theme as "system" | "dark" | "light");
      }
    });
  }, []);

  const refreshCodexStatus = async () => {
    const res = await axios.get("/api/codex/status");
    const next = res.data as CodexStatus;
    setCodexStatus(next);
  };

  const openCodexAuthInBrowser = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    const pyApi = window.pywebview?.api as { open_external_url?: (u: string) => boolean } | undefined;
    if (pyApi?.open_external_url) {
      pyApi.open_external_url(trimmed);
      return;
    }
    window.open(trimmed, "_blank", "noopener,noreferrer");
  };

  const handleCopyCodexAuthUrl = async (url: string) => {
    if (!url.trim()) return;
    await copyToClipboard(url.trim());
    toast.success(t("toast.copied"));
  };

  useEffect(() => {
    refreshCodexStatus().catch(() => {});
  }, []);

  useEffect(() => {
    axios.get("/api/settings/agents-md").then((res) => setAgentsMd(res.data.content || "")).catch(() => {});
    axios.get("/api/settings/memory-md").then((res) => setMemoryMd(res.data.content || "")).catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    setIsDesktop(isDesktopRuntime());
    const timer = window.setTimeout(() => setIsDesktop(isDesktopRuntime()), 300);
    return () => window.clearTimeout(timer);
  }, []);

  const isCodexMode = settings.api_format === "codex";
  const testModel = (() => {
    if (isCodexMode) {
      if (isCodexModelId(settings.selected_model)) return settings.selected_model;
      const fromList = (settings.models || []).map((m) => m.id).find(isCodexModelId);
      return fromList || "gpt-5.4-mini";
    }
    return settings.selected_model || settings.models?.[0]?.id || "";
  })();

  useEffect(() => {
    if (!isCodexMode || codexStatus?.logged_in) return;
    const shouldPoll = codexLoggingIn
      || !!codexAuthUrl.trim()
      || codexStatus?.oauth?.state === "pending"
      || codexStatus?.oauth?.active;
    if (!shouldPoll) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await axios.get("/api/codex/status");
        const next = res.data as CodexStatus;
        setCodexStatus(next);
        if (next.logged_in) {
          setCodexLoggingIn(false);
          setCodexAuthUrl("");
          setCodexCallbackUrl("");
          setCodexCallbackError("");
        } else if (next.oauth?.state === "error") {
          setCodexLoggingIn(false);
        }
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [
    isCodexMode,
    codexLoggingIn,
    codexAuthUrl,
    codexStatus?.logged_in,
    codexStatus?.oauth?.state,
    codexStatus?.oauth?.active,
  ]);

  const buildStreamTestFingerprint = useCallback(() => (
    [
      settings.api_format,
      settings.base_url.trim(),
      settings.api_key,
      settings.selected_model,
      codexStatus?.logged_in ? "1" : "0",
    ].join("")
  ), [settings.api_format, settings.base_url, settings.api_key, settings.selected_model, codexStatus?.logged_in]);

  useEffect(() => {
    const fp = buildStreamTestFingerprint();
    if (streamTestFingerprintRef.current && streamTestFingerprintRef.current !== fp) {
      streamAbortRef.current?.abort();
      setStreamTesting(false);
      setStreamOutput("");
      setStreamError("");
      setStreamSuccess(false);
      streamTestFingerprintRef.current = "";
    }
  }, [buildStreamTestFingerprint]);

  const streamResultMatchesConfig = streamTestFingerprintRef.current === buildStreamTestFingerprint();
  const providerLabel = settings.api_format === "codex" ? "codex" : settings.api_format;
  const candidateStatusLabel = (status: CandidateStatus) => {
    if (status === "testing") return t("settings.modelStatusTesting");
    if (status === "ok") return t("settings.modelStatusOk");
    if (status === "failed") return t("settings.modelStatusFailed");
    return t("settings.modelStatusUnknown");
  };

  const testModelAvailability = async (modelId: string) => {
    const baseUrl = getApiBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const accessKey = getAccessKey();
    if (accessKey) headers["X-Access-Key"] = accessKey;

    const resp = await fetch(`${baseUrl}/api/models/stream-test`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        base_url: settings.base_url,
        api_key: settings.api_key,
        api_format: settings.api_format,
        model: modelId,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let error = "";
    let done = false;

    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6)) as { type: string; message?: string };
          if (data.type === "error") error = data.message || t("settings.streamTestFailed");
          if (data.type === "done") done = true;
        } catch {
          /* ignore malformed SSE lines */
        }
      }
    }

    if (error) throw new Error(error);
    if (!done) throw new Error(t("settings.streamTestFailed"));
  };

  const handleStreamTest = async () => {
    if (!isCodexMode && (!settings.base_url || !settings.api_key)) return;
    if (!testModel) {
      setStreamError(t("settings.streamTestNeedModel"));
      setStreamSuccess(false);
      setStreamOutput("");
      return;
    }

    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;
    streamTestFingerprintRef.current = buildStreamTestFingerprint();

    setStreamTesting(true);
    setStreamOutput("");
    setStreamError("");
    setStreamSuccess(false);

    try {
      const baseUrl = getApiBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const accessKey = getAccessKey();
      if (accessKey) headers["X-Access-Key"] = accessKey;

      const resp = await fetch(`${baseUrl}/api/models/stream-test`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          base_url: settings.base_url,
          api_key: settings.api_key,
          api_format: settings.api_format,
          model: testModel,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${resp.status}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as {
              type: string;
              content?: string;
              message?: string;
            };
            if (data.type === "token" && data.content) {
              setStreamOutput((prev) => prev + data.content);
            } else if (data.type === "error") {
              setStreamError(data.message || t("settings.streamTestFailed"));
            } else if (data.type === "done") {
              setStreamSuccess(true);
            }
          } catch {
            /* ignore malformed SSE lines */
          }
        }
      }
    } catch (e: unknown) {
      if ((e as Error).name !== "AbortError") {
        setStreamError((e as Error).message || t("settings.streamTestFailed"));
      }
    } finally {
      setStreamTesting(false);
      if (streamAbortRef.current === controller) {
        streamAbortRef.current = null;
      }
    }
  };

  const handleStopStreamTest = () => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setStreamTesting(false);
  };

  const handleFetchModels = async () => {
    if (!isCodexMode && (!settings.base_url || !settings.api_key)) return;
    setFetching(true);
    setFetchError("");
    try {
      const res = await axios.post("/api/models/fetch", {
        base_url: settings.base_url,
        api_key: settings.api_key,
        api_format: settings.api_format,
      });
      if (res.data.error) {
        setFetchError(res.data.error);
        return;
      }
      const fetched: ModelInfo[] = res.data.models || [];
      if (fetched.length === 0) {
        setFetchError(t("settings.noModelsReturned"));
        return;
      }
      if (isCodexMode) {
        const selected = isCodexModelId(settings.selected_model)
          ? settings.selected_model
          : (fetched[0]?.id || "gpt-5.4-mini");
        setSettings((prev) => ({
          ...prev,
          models: fetched,
          selected_model: selected,
        }));
      }
      const existingIds = new Set((settings.models || []).map(m => m.id));
      setCandidateModels(fetched.map((m) => ({
        ...m,
        provider: m.provider || providerLabel,
        selected: !existingIds.has(m.id),
        status: "unknown",
      })));
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } };
      setFetchError(err.response?.data?.detail || t("settings.fetchFailed"));
    } finally {
      setFetching(false);
    }
  };

  const handleCodexLogin = async () => {
    setCodexLoggingIn(true);
    setCodexCallbackUrl("");
    setCodexCallbackError("");
    setCodexOAuthError("");
    try {
      const res = await axios.post("/api/codex/oauth/start", { open_browser: false });
      let authUrl = (res.data?.auth_url as string) || "";
      if (!authUrl) {
        const st = await axios.get("/api/codex/status");
        authUrl = (st.data?.oauth?.auth_url as string) || "";
      }
      if (!authUrl) {
        setCodexOAuthError(t("settings.codexGenerateLinkFailed"));
        setCodexAuthUrl("");
        return;
      }
      setCodexAuthUrl(authUrl);
      const st = await axios.get("/api/codex/status");
      setCodexStatus(st.data as CodexStatus);
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setCodexOAuthError(typeof detail === "string" ? detail : t("settings.codexGenerateLinkFailed"));
      setCodexAuthUrl("");
    } finally {
      setCodexLoggingIn(false);
    }
  };

  const handleCodexCallbackSubmit = async () => {
    const callbackUrl = codexCallbackUrl.trim();
    if (!callbackUrl) return;
    setCodexCallbackSubmitting(true);
    setCodexCallbackError("");
    try {
      const res = await axios.post("/api/codex/oauth/callback", { callback_url: callbackUrl });
      if (res.data?.already_logged_in) {
        setCodexCallbackError("");
      }
      setCodexCallbackUrl("");
      setCodexAuthUrl("");
      setCodexLoggingIn(false);
      await refreshCodexStatus();
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setCodexCallbackError(typeof detail === "string" ? detail : (e as Error).message || t("settings.codexCallbackFailed"));
    } finally {
      setCodexCallbackSubmitting(false);
    }
  };

  const handleCodexLogout = async () => {
    if (!window.confirm(t("settings.codexLogoutConfirm"))) return;
    setCodexLoggingOut(true);
    setCodexOAuthError("");
    try {
      await axios.post("/api/codex/logout");
      setCodexAuthUrl("");
      setCodexCallbackUrl("");
      setCodexCallbackError("");
      await refreshCodexStatus();
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setCodexOAuthError(typeof detail === "string" ? detail : t("settings.codexLogoutFailed"));
    } finally {
      setCodexLoggingOut(false);
    }
  };

  const codexStatusText = () => {
    if (!codexStatus) return t("settings.fetching");
    if (codexStatus.logged_in) return t("settings.codexLoggedIn");
    if (codexStaleRemotePending) return t("settings.codexStaleOAuth");
    if (displayedCodexAuthUrl) return t("settings.codexLinkReady");
    if (codexLoggingIn) return t("settings.codexLoggingIn");
    if (codexStatus.oauth?.state === "error") {
      return codexStatus.oauth?.message || t("settings.codexCallbackFailed");
    }
    if (codexStatus.oauth?.state === "pending") {
      return t("settings.codexWaitingAuthorization");
    }
    if (codexStatus.cli_logged_in) {
      return t("settings.codexCliLoggedInWinkTermNotAuthorized");
    }
    return t("settings.codexNotLoggedIn");
  };

  const displayedCodexAuthUrl = codexAuthUrl.trim();
  const codexStaleRemotePending = Boolean(
    !displayedCodexAuthUrl
    && !codexLoggingIn
    && codexStatus?.oauth?.state === "pending"
    && codexStatus?.oauth?.active,
  );
  const showCodexAuthUrlPanel = isCodexMode && (!codexStatus?.logged_in || !!displayedCodexAuthUrl);
  const showCodexCallbackForm = isCodexMode && !codexStatus?.logged_in;

  const handleAddModel = () => {
    if (!newModelId.trim()) return;
    setSettings(prev => ({
      ...prev,
      models: [...(prev.models || []), {
        id: newModelId.trim(),
        name: newModelName.trim() || newModelId.trim(),
        provider: providerLabel,
      }],
    }));
    setNewModelId("");
    setNewModelName("");
  };

  const handleRemoveModel = (id: string) => {
    setSettings(prev => ({
      ...prev,
      models: (prev.models || []).filter(m => m.id !== id),
      selected_model: prev.selected_model === id ? "" : prev.selected_model,
    }));
  };

  const handleClearModels = () => {
    setSettings(prev => ({ ...prev, models: [], selected_model: "" }));
  };

  const mergeModels = (models: ModelInfo[]) => {
    setSettings(prev => {
      const existing = new Set((prev.models || []).map(m => m.id));
      const additions = models.filter(m => !existing.has(m.id));
      return { ...prev, models: [...(prev.models || []), ...additions] };
    });
  };

  const handleToggleCandidate = (id: string) => {
    setCandidateModels(prev => prev.map(m => (
      m.id === id ? { ...m, selected: !m.selected } : m
    )));
  };

  const handleSelectAllCandidates = () => {
    const allSelected = candidateModels.every(m => m.selected);
    setCandidateModels(prev => prev.map(m => ({ ...m, selected: !allSelected })));
  };

  const handleTestCandidate = async (id: string) => {
    setCandidateModels(prev => prev.map(m => (
      m.id === id ? { ...m, status: "testing", error: "" } : m
    )));
    try {
      await testModelAvailability(id);
      setCandidateModels(prev => prev.map(m => (
        m.id === id ? { ...m, status: "ok", error: "" } : m
      )));
    } catch (e: unknown) {
      setCandidateModels(prev => prev.map(m => (
        m.id === id ? { ...m, status: "failed", error: (e as Error).message } : m
      )));
    }
  };

  const handleTestCandidates = async () => {
    for (const model of candidateModels.filter(m => m.selected)) {
      await handleTestCandidate(model.id);
    }
  };

  const handleAddSelectedCandidates = () => {
    mergeModels(candidateModels.filter(m => m.selected).map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
    })));
  };

  const handleAddAvailableCandidates = () => {
    mergeModels(candidateModels.filter(m => m.status === "ok").map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
    })));
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      await axios.post("/api/settings", settings);
      toast.success(t("toast.settingsSaved"));
    } catch (e) {
      console.error("Save settings failed:", e);
      toast.error(t("toast.settingsSaveFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAgentsMd = async () => {
    setSavingAgentsMd(true);
    try {
      await axios.put("/api/settings/agents-md", { content: agentsMd });
      toast.success(t("toast.agentsMdSaved"));
    } catch (e) {
      console.error("Save agents.md failed:", e);
      toast.error(t("toast.settingsSaveFailed"));
    } finally {
      setSavingAgentsMd(false);
    }
  };

  const handleSaveMemoryMd = async () => {
    setSavingMemoryMd(true);
    try {
      await axios.put("/api/settings/memory-md", { content: memoryMd });
      toast.success(t("toast.memoryMdSaved"));
    } catch (e) {
      console.error("Save memory.md failed:", e);
      toast.error(t("toast.settingsSaveFailed"));
    } finally {
      setSavingMemoryMd(false);
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const res = await axios.get("/api/app/update/check");
      setUpdateInfo(res.data);
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateInfo) return;
    if (!updateInfo.platform_supported) {
      window.open(updateInfo.release_url, "_blank", "noopener,noreferrer");
      return;
    }
    setInstallingUpdate(true);
    setUpdateJob(null);
    try {
      const res = await axios.post("/api/app/update/install");
      const jobId = res.data?.job_id;
      if (!jobId) {
        setInstallingUpdate(false);
        return;
      }
      const timer = window.setInterval(async () => {
        const jobRes = await axios.get(`/api/app/update/install/${jobId}`);
        const job = jobRes.data as UpdateJob;
        setUpdateJob(job);
        if (job.done) {
          window.clearInterval(timer);
          setInstallingUpdate(false);
        }
      }, 500);
    } catch {
      setInstallingUpdate(false);
    }
  };

  const handleSkipUpdate = () => {
    if (updateInfo?.latest_version) {
      localStorage.setItem("winkterm-skip-update-version", updateInfo.latest_version);
    }
    setUpdateInfo(null);
  };

  const hasModels = (settings.models?.length ?? 0) > 0;

  const aiSetupStatus: AiSetupStatus = (() => {
    if (streamTesting) return "testing";
    if (streamResultMatchesConfig && streamError) return "error";
    if (isCodexMode) {
      if (!codexStatus?.logged_in) return "needs-auth";
      if (!testModel) return "needs-auth";
      if (streamResultMatchesConfig && streamSuccess) return "ready";
      return "needs-auth";
    }
    if (!settings.base_url?.trim() && !settings.api_key?.trim()) return "not-configured";
    if (!settings.base_url?.trim() || !settings.api_key?.trim()) return "needs-auth";
    if (streamResultMatchesConfig && streamSuccess) return "ready";
    return "needs-auth";
  })();

  const aiStatusMessage = () => {
    if (aiSetupStatus === "testing") return t("settings.aiStatusTesting");
    if (aiSetupStatus === "ready") return t("settings.aiStatusReady");
    if (aiSetupStatus === "error") return streamError || t("settings.aiStatusError");
    if (aiSetupStatus === "not-configured") return t("settings.aiStatusNotConfigured");
    if (isCodexMode && codexStatus?.logged_in && !testModel) {
      return t("settings.aiSetupNeedModelHint");
    }
    return isCodexMode
      ? (codexStatus?.oauth?.message || codexStatus?.message || t("settings.aiStatusNeedsAuth"))
      : t("settings.aiStatusNeedsAuth");
  };

  const canFetchModelsInSetup = isCodexMode
    ? !!codexStatus?.logged_in
    : !!(settings.base_url?.trim() && settings.api_key?.trim());

  const handleFetchModelsFromSetup = async () => {
    await handleFetchModels();
    setActiveSection("models");
  };

  const sectionTitle = (id: SettingsSectionId) => {
    const map: Record<SettingsSectionId, string> = {
      "ai-setup": t("settings.navAiSetup"),
      models: t("settings.navModels"),
      "agent-behavior": t("settings.navAgentBehavior"),
      security: t("settings.navSecurity"),
      appearance: t("settings.navAppearance"),
      about: t("settings.navAbout"),
    };
    return map[id];
  };

  const setProviderFormat = (format: Settings["api_format"]) => {
    setSettings((prev) => {
      if (format !== "codex") {
        return { ...prev, api_format: format };
      }
      const selected = isCodexModelId(prev.selected_model) ? prev.selected_model : "gpt-5.4-mini";
      const models = (prev.models || []).filter((m) => isCodexModelId(m.id));
      return {
        ...prev,
        api_format: format,
        models: models.length ? models : [...CODEX_MODEL_PRESETS],
        selected_model: selected,
      };
    });
  };

  const maskToken = (token: string) => {
    if (!token) return "";
    if (token.length <= 8) return "••••••••";
    return `${token.slice(0, 4)}••••••••${token.slice(-4)}`;
  };

  const renderSaveBar = () => (
    <button
      className="settings-btn settings-btn-primary settings-btn-full"
      onClick={handleSave}
      disabled={loading}
    >
      {loading ? (
        <>
          <span className="settings-spinner" />
          {t("settings.saving")}
        </>
      ) : (
        t("settings.save")
      )}
    </button>
  );

  const renderAiSetupSection = () => (
    <div className="settings-section-body">
      <div className={`settings-status-banner ${
        aiSetupStatus === "ready" ? "ready" : aiSetupStatus === "error" ? "error" : "warn"
      }`}>
        <span className="settings-status-dot-lg" />
        <div>
          <div style={{ fontWeight: 600, marginBottom: "4px" }}>{t("settings.aiStatusTitle")}</div>
          <div style={{ color: "var(--fg-secondary)", fontSize: "12px" }}>{aiStatusMessage()}</div>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label">{t("settings.apiFormat")}</label>
        <div className="settings-provider-cards">
          {([
            { id: "codex" as const, title: t("settings.providerCodex"), badge: "recommended" as const },
            { id: "openai" as const, title: t("settings.providerOpenAI"), badge: "advanced" as const },
            { id: "anthropic" as const, title: t("settings.providerAnthropic"), badge: "advanced" as const },
          ]).map((p) => (
            <label
              key={p.id}
              className={`settings-provider-card ${settings.api_format === p.id ? "selected" : ""}`}
            >
              <input
                type="radio"
                name="api_format"
                checked={settings.api_format === p.id}
                onChange={() => setProviderFormat(p.id)}
              />
              <div className="settings-provider-card-main">
                <span className="settings-provider-card-title">
                  {p.title}
                  <span className={`settings-provider-card-badge ${p.badge === "advanced" ? "muted" : ""}`}>
                    {p.badge === "recommended" ? t("settings.providerRecommended") : t("settings.providerAdvanced")}
                  </span>
                </span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {isCodexMode ? (
        <div className="settings-field">
          <label className="settings-label">{t("settings.codexLogin")}</label>
          <div className={codexStatus?.logged_in ? "settings-success" : "settings-help"}>
            {codexStatusText()}
          </div>
          {codexOAuthError && (
            <div className="settings-error" style={{ marginTop: "8px" }}>{codexOAuthError}</div>
          )}
          <div className="settings-inline-actions" style={{ marginTop: "8px" }}>
            <button className="settings-btn settings-btn-secondary settings-btn-full" onClick={refreshCodexStatus}>
              <RefreshIcon />
              {t("settings.codexCheckStatus")}
            </button>
            <button
              className="settings-btn settings-btn-primary settings-btn-full"
              onClick={handleCodexLogin}
              disabled={codexLoggingIn || !!codexStatus?.logged_in}
            >
              {codexLoggingIn ? (
                <>
                  <span className="settings-spinner" />
                  {t("settings.codexLoggingIn")}
                </>
              ) : (
                t("settings.codexLoginButton")
              )}
            </button>
            {codexStatus?.logged_in && (
              <button
                className="settings-btn settings-btn-secondary settings-btn-full"
                onClick={handleCodexLogout}
                disabled={codexLoggingOut}
              >
                {codexLoggingOut ? (
                  <>
                    <span className="settings-spinner" />
                    {t("settings.codexLoggingOut")}
                  </>
                ) : (
                  t("settings.codexLogoutButton")
                )}
              </button>
            )}
          </div>
          {showCodexAuthUrlPanel && (
            <div className="settings-codex-auth-panel">
              <label className="settings-label">{t("settings.codexAuthUrlLabel")}</label>
              <div className="settings-help">
                {displayedCodexAuthUrl
                  ? t("settings.codexLinkReady")
                  : t("settings.codexAuthUrlHelpPending")}
              </div>
              <input
                type="text"
                className="settings-input settings-codex-auth-url"
                value={displayedCodexAuthUrl}
                readOnly
                placeholder={t("settings.codexAuthUrlHelpPending")}
                onFocus={(e) => e.target.select()}
                style={{ marginTop: "6px", fontSize: "12px" }}
              />
              <div className="settings-codex-auth-actions">
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary"
                  onClick={() => handleCopyCodexAuthUrl(displayedCodexAuthUrl)}
                  disabled={!displayedCodexAuthUrl.trim()}
                >
                  {t("settings.codexCopyAuthUrl")}
                </button>
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary"
                  onClick={() => openCodexAuthInBrowser(displayedCodexAuthUrl)}
                  disabled={!displayedCodexAuthUrl.trim()}
                >
                  {t("settings.codexOpenInBrowser")}
                </button>
              </div>
            </div>
          )}
          {showCodexCallbackForm && (
            <div className="settings-field" style={{ marginTop: "12px" }}>
              <label className="settings-label">{t("settings.codexCallbackLabel")}</label>
              <textarea
                className="settings-input settings-textarea"
                value={codexCallbackUrl}
                onChange={(e) => setCodexCallbackUrl(e.target.value)}
                placeholder={t("settings.codexCallbackPlaceholder")}
                rows={3}
              />
              <div className="settings-help">{t("settings.codexCallbackHelp")}</div>
              {codexCallbackError && (
                <div className="settings-error" style={{ marginTop: "8px" }}>{codexCallbackError}</div>
              )}
              <button
                className="settings-btn settings-btn-primary settings-btn-full"
                style={{ marginTop: "8px" }}
                onClick={handleCodexCallbackSubmit}
                disabled={codexCallbackSubmitting || !codexCallbackUrl.trim()}
              >
                {codexCallbackSubmitting ? (
                  <>
                    <span className="settings-spinner" />
                    {t("settings.codexCallbackSubmitting")}
                  </>
                ) : (
                  t("settings.codexCallbackSubmit")
                )}
              </button>
            </div>
          )}
          <div className="settings-field" style={{ marginTop: "12px" }}>
            <label className="settings-label">{t("settings.codexClientVersion")}</label>
            <input
              type="text"
              className="settings-input"
              value={settings.codex_client_version}
              onChange={(e) => setSettings({ ...settings, codex_client_version: e.target.value })}
              placeholder={codexStatus?.client_version?.default || "0.142.5"}
            />
            <div className="settings-help">{t("settings.codexClientVersionHelp")}</div>
            {codexStatus?.client_version?.effective && (
              <div className="settings-help" style={{ marginTop: "4px" }}>
                {t("settings.codexClientVersionEffective")
                  .replace("{version}", codexStatus.client_version.effective)
                  .replace("{source}", codexStatus.client_version.source)}
              </div>
            )}
          </div>
          <div className="settings-help" style={{ marginTop: "8px" }}>{t("settings.codexHelp")}</div>
        </div>
      ) : (
        <>
          <div className="settings-field">
            <label className="settings-label">{t("settings.baseUrl")}</label>
            <input
              type="text"
              className="settings-input"
              value={settings.base_url}
              onChange={(e) => setSettings({ ...settings, base_url: e.target.value })}
              placeholder={settings.api_format === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"}
            />
            <div className="settings-help">
              {settings.api_format === "openai" ? t("settings.openaiHelp") : t("settings.anthropicHelp")}
            </div>
          </div>
          <div className="settings-field">
            <label className="settings-label">{t("settings.apiKey")}</label>
            <input
              type="password"
              className="settings-input"
              value={settings.api_key}
              onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
              placeholder="sk-..."
            />
          </div>
        </>
      )}

      <div className="settings-inline-actions">
        {!testModel ? (
          <>
            <button
              className="settings-btn settings-btn-primary settings-btn-full"
              onClick={handleFetchModelsFromSetup}
              disabled={fetching || !canFetchModelsInSetup}
            >
              {fetching ? (
                <>
                  <span className="settings-spinner" />
                  {t("settings.fetching")}
                </>
              ) : (
                <>
                  <RefreshIcon />
                  {t("settings.fetchModelsGoModels")}
                </>
              )}
            </button>
            <button
              type="button"
              className="settings-btn settings-btn-secondary settings-btn-full"
              onClick={() => setActiveSection("models")}
            >
              {t("settings.goToModelsSection")}
            </button>
          </>
        ) : (
          <button
            className="settings-btn settings-btn-secondary settings-btn-full"
            onClick={handleStreamTest}
            disabled={streamTesting || (!isCodexMode && (!settings.base_url || !settings.api_key))}
          >
            {streamTesting ? (
              <>
                <span className="settings-spinner" />
                {t("settings.aiStatusTesting")}
              </>
            ) : (
              t("settings.testConnection")
            )}
          </button>
        )}
      </div>

      {!testModel && (
        <div className="settings-help" style={{ marginTop: "8px" }}>
          {canFetchModelsInSetup ? t("settings.aiSetupNeedModelHint") : t("settings.aiSetupCompleteAuthFirst")}
        </div>
      )}

      {streamTesting && (
        <button
          className="settings-btn settings-btn-secondary settings-btn-full"
          onClick={handleStopStreamTest}
          style={{ marginTop: "8px" }}
        >
          {t("settings.streamTestStop")}
        </button>
      )}

      {(streamResultMatchesConfig && (streamOutput || streamError || streamSuccess)) && (
        <div className="settings-stream-result" style={{ marginTop: "12px" }}>
          {streamError ? (
            <div className="settings-error">
              <span className="settings-error-icon"><ErrorIcon /></span>
              {streamError}
            </div>
          ) : (
            <>
              {streamSuccess && (
                <div className="settings-success">
                  <CheckIcon />
                  {t("settings.streamTestSuccess")}
                </div>
              )}
              {streamOutput && <pre className="settings-stream-output">{streamOutput}</pre>}
            </>
          )}
        </div>
      )}

      <div style={{ marginTop: "20px" }}>{renderSaveBar()}</div>
    </div>
  );

  const renderModelsSection = () => (
    <div className="settings-section-body">
      <p className="settings-section-desc" style={{ padding: 0, marginBottom: "16px" }}>
        {t("settings.modelsIntro")}
      </p>

      <div className="settings-inline-actions">
        <button
          className="settings-btn settings-btn-secondary settings-btn-full"
          onClick={handleFetchModels}
          disabled={fetching || (!isCodexMode && (!settings.base_url || !settings.api_key))}
        >
          {fetching ? (
            <>
              <span className="settings-spinner" />
              {t("settings.fetching")}
            </>
          ) : (
            <>
              <RefreshIcon />
              {t("settings.autoFetch")}
            </>
          )}
        </button>
        <button
          className="settings-btn settings-btn-secondary settings-btn-full"
          onClick={handleStreamTest}
          disabled={streamTesting || (!isCodexMode && (!settings.base_url || !settings.api_key)) || !testModel}
        >
          {streamTesting ? (
            <>
              <span className="settings-spinner" />
              {t("settings.streamTesting")}
            </>
          ) : (
            t("settings.streamTest")
          )}
        </button>
      </div>

      {fetchError && (
        <div className="settings-error" style={{ marginTop: "12px" }}>
          <span className="settings-error-icon"><ErrorIcon /></span>
          {fetchError}
        </div>
      )}

      {candidateModels.length > 0 && (
        <div className="settings-field" style={{ marginTop: "16px" }}>
          <label className="settings-label">
            {t("settings.candidateModels")}
            <span className="settings-label-hint">({candidateModels.length})</span>
          </label>
          <div className="settings-candidate-actions">
            <button className="settings-btn settings-btn-secondary" onClick={handleSelectAllCandidates}>
              {candidateModels.every(m => m.selected) ? t("settings.unselectAllModels") : t("settings.selectAllModels")}
            </button>
            <button
              className="settings-btn settings-btn-secondary"
              onClick={handleTestCandidates}
              disabled={candidateModels.some(m => m.status === "testing") || !candidateModels.some(m => m.selected)}
            >
              {t("settings.testSelectedModels")}
            </button>
            <button
              className="settings-btn settings-btn-secondary"
              onClick={handleAddAvailableCandidates}
              disabled={!candidateModels.some(m => m.status === "ok")}
            >
              {t("settings.addAvailableModels")}
            </button>
            <button
              className="settings-btn settings-btn-primary"
              onClick={handleAddSelectedCandidates}
              disabled={!candidateModels.some(m => m.selected)}
            >
              {t("settings.addSelectedModels")}
            </button>
          </div>
          <div className="settings-candidate-list">
            {candidateModels.map((m) => (
              <div key={m.id} className="settings-candidate-item">
                <label className="settings-candidate-check">
                  <input type="checkbox" checked={m.selected} onChange={() => handleToggleCandidate(m.id)} />
                </label>
                <div className="settings-model-info">
                  <span className="settings-model-id">{m.id}</span>
                  <span className="settings-model-name">
                    {m.provider || providerLabel}
                    {m.name && m.name !== m.id ? ` · ${m.name}` : ""}
                  </span>
                  {m.error && <span className="settings-model-error">{m.error}</span>}
                </div>
                <span className={`settings-model-status settings-model-status-${m.status}`}>
                  {candidateStatusLabel(m.status)}
                </span>
                <button
                  className="settings-model-remove"
                  onClick={() => handleTestCandidate(m.id)}
                  disabled={m.status === "testing"}
                >
                  {t("settings.testModel")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasModels && (
        <div className="settings-field" style={{ marginTop: "16px" }}>
          <label className="settings-label">{t("settings.activeModel")}</label>
          <select
            className="settings-select"
            value={settings.selected_model}
            onChange={(e) => setSettings({ ...settings, selected_model: e.target.value })}
          >
            <option value="">{t("settings.selectModel")}</option>
            {settings.models?.map((m) => (
              <option key={`${m.provider || "unknown"}:${m.id}`} value={m.id}>
                {m.name || m.id} ({m.provider || "unknown"})
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="settings-field" style={{ marginTop: "16px" }}>
        <label className="settings-label">
          {t("settings.configuredModels")}
          {hasModels && <span className="settings-label-hint">({settings.models.length})</span>}
        </label>
        {hasModels && (
          <button
            className="settings-btn settings-btn-secondary settings-btn-full"
            onClick={handleClearModels}
            style={{ marginBottom: "8px" }}
          >
            {t("settings.clearModels")}
          </button>
        )}
        {hasModels ? (
          <div className="settings-models-list">
            {settings.models?.map((m) => (
              <div key={`${m.provider || "unknown"}:${m.id}`} className="settings-model-item">
                <div className="settings-model-info">
                  <span className="settings-model-id">{m.id}</span>
                  {m.name && m.name !== m.id && <span className="settings-model-name">{m.name}</span>}
                  <span className="settings-model-provider">{m.provider || "unknown"}</span>
                </div>
                <button
                  className="settings-model-remove settings-model-delete"
                  onClick={() => handleRemoveModel(m.id)}
                  title={t("settings.removeModel")}
                  aria-label={t("settings.removeModel")}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-empty">
            <div className="settings-empty-icon"><ModelIcon /></div>
            <div>{t("settings.noModels")}</div>
            <div style={{ fontSize: "11px", marginTop: "4px" }}>{t("settings.noModelsHint")}</div>
          </div>
        )}
      </div>

      <button
        type="button"
        className="settings-advanced-toggle"
        onClick={() => setModelsAdvancedOpen((o) => !o)}
      >
        {t("settings.advanced")}
        <span>{modelsAdvancedOpen ? "−" : "+"}</span>
      </button>
      {modelsAdvancedOpen && (
        <div className="settings-advanced-body">
          <div className="settings-field">
            <label className="settings-label">{t("settings.addManually")}</label>
            <div className="settings-add-model">
              <input
                type="text"
                className="settings-input"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                placeholder={t("settings.modelId")}
                onKeyDown={(e) => e.key === "Enter" && handleAddModel()}
              />
              <input
                type="text"
                className="settings-input"
                value={newModelName}
                onChange={(e) => setNewModelName(e.target.value)}
                placeholder={t("settings.displayName")}
                onKeyDown={(e) => e.key === "Enter" && handleAddModel()}
              />
              <button
                className="settings-btn settings-btn-secondary"
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                title={t("settings.addModel")}
              >
                <PlusIcon />
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: "20px" }}>{renderSaveBar()}</div>
    </div>
  );

  const renderAgentBehaviorSection = () => (
    <div className="settings-section-body">
      {!editingDoc ? (
        <>
          <p className="settings-section-desc" style={{ padding: 0, marginBottom: "12px" }}>
            {t("settings.docListIntro")}
          </p>
          <div className="settings-doc-list">
            <div className="settings-doc-row">
              <div>
                <div className="settings-doc-row-title">{t("settings.agentsMd")}</div>
                <div className="settings-doc-row-meta">agents.md</div>
              </div>
              <button className="settings-btn settings-btn-secondary" onClick={() => setEditingDoc("agents")}>
                {t("settings.editDoc")}
              </button>
            </div>
            <div className="settings-doc-row">
              <div>
                <div className="settings-doc-row-title">{t("settings.memoryMd")}</div>
                <div className="settings-doc-row-meta">memory.md</div>
              </div>
              <button className="settings-btn settings-btn-secondary" onClick={() => setEditingDoc("memory")}>
                {t("settings.editDoc")}
              </button>
            </div>
          </div>
        </>
      ) : editingDoc === "agents" ? (
        <div className="settings-field">
          <button className="settings-btn settings-btn-secondary" style={{ marginBottom: "12px" }} onClick={() => setEditingDoc(null)}>
            {t("settings.closeEditor")}
          </button>
          <label className="settings-label">{t("settings.agentsMd")}</label>
          <textarea className="settings-textarea" value={agentsMd} onChange={(e) => setAgentsMd(e.target.value)} />
          <div className="settings-help">{t("settings.agentsMdHelp")}</div>
          <button className="settings-btn settings-btn-primary settings-btn-full" onClick={handleSaveAgentsMd} disabled={savingAgentsMd}>
            {savingAgentsMd ? t("settings.saving") : t("settings.saveDoc")}
          </button>
        </div>
      ) : (
        <div className="settings-field">
          <button className="settings-btn settings-btn-secondary" style={{ marginBottom: "12px" }} onClick={() => setEditingDoc(null)}>
            {t("settings.closeEditor")}
          </button>
          <label className="settings-label">{t("settings.memoryMd")}</label>
          <textarea className="settings-textarea" value={memoryMd} onChange={(e) => setMemoryMd(e.target.value)} />
          <div className="settings-help">{t("settings.memoryMdHelp")}</div>
          <button className="settings-btn settings-btn-primary settings-btn-full" onClick={handleSaveMemoryMd} disabled={savingMemoryMd}>
            {savingMemoryMd ? t("settings.saving") : t("settings.saveDoc")}
          </button>
        </div>
      )}
    </div>
  );

  const renderSecuritySection = () => (
    <div className="settings-section-body">
      <div className="settings-field">
        <label className="settings-label">{t("settings.agentApiToken")}</label>
        <div className="settings-help" style={{ marginBottom: "8px" }}>{t("settings.agentApiTokenHelp")}</div>
        <input
          type="text"
          className="settings-input"
          value={tokenEditing ? settings.agent_api_token : (settings.agent_api_token ? maskToken(settings.agent_api_token) : "")}
          readOnly={!tokenEditing}
          onChange={(e) => setSettings({ ...settings, agent_api_token: e.target.value })}
          placeholder="token..."
        />
        <div style={{ display: "flex", gap: "8px", marginTop: "8px", flexWrap: "wrap" }}>
          <button
            className="settings-btn settings-btn-secondary"
            onClick={() => setTokenEditing((v) => !v)}
            type="button"
          >
            {tokenEditing ? t("settings.doneEditingToken") : t("settings.editToken")}
          </button>
          <button className="settings-btn settings-btn-secondary" onClick={handleCopyToken} type="button" disabled={!settings.agent_api_token}>
            {t("settings.revealToken")}
          </button>
          <button className="settings-btn settings-btn-secondary" onClick={handleGenerateToken} type="button">
            {t("settings.agentApiTokenGenerate")}
          </button>
        </div>
        {tokenEditing && (
          <div className="settings-help" style={{ marginTop: "6px" }}>{t("settings.tokenManualEditHelp")}</div>
        )}
      </div>

      <div className="settings-field">
        <label className="settings-label">{t("settings.agentAccess")}</label>
        <div className="settings-help" style={{ marginBottom: "8px" }}>{t("settings.agentAccessDesc")}</div>
        <textarea
          className="settings-input"
          value={installPrompt}
          readOnly
          rows={2}
          onFocus={(e) => e.target.select()}
          style={{ resize: "none", fontFamily: "monospace" }}
        />
        <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
          <button className="settings-btn settings-btn-primary" onClick={handleCopyInstallPrompt} style={{ flex: 1 }}>
            {t("settings.agentAccessCopy")}
          </button>
          <a
            className="settings-btn settings-btn-secondary"
            href={installGuideUrl}
            target="_blank"
            rel="noreferrer"
            style={{ flex: 1, textDecoration: "none", textAlign: "center" }}
          >
            {t("settings.agentAccessOpen")}
          </a>
        </div>
      </div>

      <div className="settings-field">
        <label className="settings-label">{t("settings.webAccessKey")}</label>
        <div className="settings-help" style={{ marginBottom: "8px" }}>{t("settings.webAccessKeyHelp")}</div>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            className="settings-input"
            value={settings.web_access_key}
            onChange={(e) => setSettings({ ...settings, web_access_key: e.target.value })}
            placeholder="key..."
            style={{ flex: 1 }}
          />
          <button className="settings-btn settings-btn-secondary" onClick={handleGenerateWebKey} type="button">
            {t("settings.agentApiTokenGenerate")}
          </button>
        </div>
      </div>

      <a
        className="settings-btn settings-btn-secondary settings-btn-full"
        href={`${getApiBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "")}/api/settings/export`}
        download="winkterm-config.json"
        style={{ textDecoration: "none", textAlign: "center", display: "block", marginTop: "8px" }}
      >
        {t("settings.exportConfig")}
      </a>
      <div className="settings-help" style={{ marginTop: "6px" }}>{t("settings.exportConfigHelp")}</div>

      <div style={{ marginTop: "20px" }}>{renderSaveBar()}</div>
    </div>
  );

  const renderAppearanceSection = () => (
    <div className="settings-section-body">
      <div className="settings-field">
        <label className="settings-label">{t("settings.language")}</label>
        <select
          className="settings-select"
          value={locale}
          onChange={(e) => {
            const lang = e.target.value as "zh" | "en";
            setLocale(lang);
            axios.post("/api/settings", { language: lang }).catch(() => {});
          }}
        >
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </div>
      <div className="settings-field">
        <label className="settings-label">{t("settings.theme")}</label>
        <select
          className="settings-select"
          value={themeMode}
          onChange={(e) => {
            const mode = e.target.value as "system" | "dark" | "light";
            setThemeMode(mode);
            setSettings((prev) => ({ ...prev, theme: mode }));
            axios.post("/api/settings", { theme: mode }).catch(() => {});
          }}
        >
          <option value="system">{t("settings.themeSystem")}</option>
          <option value="dark">{t("settings.themeDark")}</option>
          <option value="light">{t("settings.themeLight")}</option>
        </select>
      </div>
    </div>
  );

  const renderAboutSection = () => (
    <div className="settings-section-body">
      <div className="settings-field">
        <label className="settings-label">{t("settings.version")}</label>
        <div className="settings-update-row">
          <span className="settings-version">{updateInfo?.current_version || "0.3.0"}</span>
          <button className="settings-btn settings-btn-secondary" onClick={handleCheckUpdate} disabled={checkingUpdate}>
            {checkingUpdate ? (
              <>
                <span className="settings-spinner" />
                {t("settings.checkingUpdate")}
              </>
            ) : (
              <>
                <RefreshIcon />
                {t("settings.checkUpdate")}
              </>
            )}
          </button>
        </div>
        {updateInfo && (
          <div className={updateInfo.update_available ? "settings-update-available" : "settings-help"}>
            {updateInfo.error ? (
              updateInfo.error
            ) : updateInfo.update_available ? (
              <>
                {t("settings.updateAvailable")} {updateInfo.latest_version}
                <ul className="settings-update-notes">
                  {summarizeReleaseNotes(updateInfo.release_notes).map((line) => (
                    <li key={line}>{line.replace(/^- /, "")}</li>
                  ))}
                </ul>
                {installingUpdate && (
                  <div className="settings-update-progress">
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
                {updateJob?.error && (
                  <div className="settings-error" style={{ marginTop: "8px" }}>
                    <span className="settings-error-icon"><ErrorIcon /></span>
                    {updateJob.error}
                  </div>
                )}
                {isDesktop ? (
                  <button
                    className="settings-btn settings-btn-primary settings-btn-full"
                    onClick={handleInstallUpdate}
                    disabled={installingUpdate}
                    style={{ marginTop: "8px" }}
                  >
                    {installingUpdate ? (
                      <>
                        <span className="settings-spinner" />
                        {t("settings.downloadingUpdate")}
                      </>
                    ) : (
                      t("settings.installUpdate")
                    )}
                  </button>
                ) : (
                  <button
                    className="settings-btn settings-btn-primary settings-btn-full"
                    onClick={() => window.open(updateInfo.release_url, "_blank", "noopener,noreferrer")}
                    style={{ marginTop: "8px" }}
                  >
                    {t("settings.viewRelease")}
                  </button>
                )}
                <button
                  className="settings-btn settings-btn-secondary settings-btn-full"
                  onClick={handleSkipUpdate}
                  style={{ marginTop: "8px" }}
                >
                  {t("settings.skipUpdateVersion")}
                </button>
              </>
            ) : (
              t("settings.noUpdate")
            )}
          </div>
        )}
      </div>
      <a
        className="settings-btn settings-btn-secondary settings-btn-full"
        href={GITHUB_REPO_URL}
        target="_blank"
        rel="noreferrer"
        style={{ textDecoration: "none", textAlign: "center", display: "block" }}
      >
        {t("settings.githubProject")}
      </a>
      <div className="settings-help" style={{ marginTop: "6px" }}>{t("settings.githubProjectHelp")}</div>
    </div>
  );

  const renderActiveSection = () => {
    switch (activeSection) {
      case "ai-setup": return renderAiSetupSection();
      case "models": return renderModelsSection();
      case "agent-behavior": return renderAgentBehaviorSection();
      case "security": return renderSecuritySection();
      case "appearance": return renderAppearanceSection();
      case "about": return renderAboutSection();
      default: return null;
    }
  };

  const NavIcon = ({ section }: { section: SettingsSectionId }) => {
    if (section === "ai-setup") return <ApiIcon />;
    if (section === "models") return <ModelIcon />;
    return <SettingsIcon />;
  };

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span className="settings-header-icon"><SettingsIcon /></span>
        <span className="settings-header-title">{t("settings.title")}</span>
      </div>

      <div className="settings-mobile-tabs">
        {SECTION_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`settings-mobile-tab ${activeSection === id ? "active" : ""}`}
            onClick={() => setActiveSection(id)}
          >
            {sectionTitle(id)}
          </button>
        ))}
      </div>

      <div className="settings-shell">
        <nav className="settings-nav" aria-label={t("settings.title")}>
          {SECTION_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`settings-nav-item ${activeSection === id ? "active" : ""}`}
              onClick={() => setActiveSection(id)}
            >
              <NavIcon section={id} />
              {sectionTitle(id)}
            </button>
          ))}
        </nav>

        <div className="settings-section-panel">
          <h2 className="settings-section-title">{sectionTitle(activeSection)}</h2>
          {renderActiveSection()}
        </div>
      </div>
    </div>
  );
}
