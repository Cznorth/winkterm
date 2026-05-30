"use client";

import { useState, useEffect, useRef } from "react";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";
import { useTheme } from "@/lib/theme";
import { getApiBaseUrl } from "@/lib/config";
import { getAccessKey } from "@/lib/auth";
import "./SettingsPanel.css";

interface ModelInfo {
  id: string;
  name: string;
}

interface Settings {
  api_format: "openai" | "anthropic";
  base_url: string;
  api_key: string;
  models: ModelInfo[];
  selected_model: string;
  agent_api_token: string;
  web_access_key: string;
  theme: string;
}

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

export default function SettingsPanel() {
  const { t, locale, setLocale } = useI18n();
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
  });
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [streamTesting, setStreamTesting] = useState(false);
  const [streamOutput, setStreamOutput] = useState("");
  const [streamError, setStreamError] = useState("");
  const [streamSuccess, setStreamSuccess] = useState(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const [agentsMd, setAgentsMd] = useState("");
  const [memoryMd, setMemoryMd] = useState("");
  const [agentsMdSaved, setAgentsMdSaved] = useState(false);
  const [memoryMdSaved, setMemoryMdSaved] = useState(false);
  const [savingAgentsMd, setSavingAgentsMd] = useState(false);
  const [savingMemoryMd, setSavingMemoryMd] = useState(false);

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
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 1500);
  };

  const installGuideUrl = `${getApiBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "")}/api/agent/install.md`;
  const installPrompt = `${t("settings.agentAccessPrompt")}${installGuideUrl}`;

  const handleGenerateToken = () => {
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
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      /* Ignore when clipboard is unavailable */
    }
  };

  useEffect(() => {
    axios.get("/api/settings").then((res) => {
      const data = res.data;
      setSettings({
        api_format: data.api_format || "openai",
        base_url: data.base_url || "",
        api_key: data.api_key || "",
        models: data.models || [],
        selected_model: data.selected_model || "",
        agent_api_token: data.agent_api_token || "",
        web_access_key: data.web_access_key || "",
        theme: data.theme || "system",
      });
      if (data.theme) {
        setThemeMode(data.theme as "system" | "dark" | "light");
      }
    });
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

  const testModel = settings.selected_model || settings.models?.[0]?.id || "";

  const handleStreamTest = async () => {
    if (!settings.base_url || !settings.api_key) return;
    if (!testModel) {
      setStreamError(t("settings.streamTestNeedModel"));
      setStreamSuccess(false);
      setStreamOutput("");
      return;
    }

    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;

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
    if (!settings.base_url || !settings.api_key) return;
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
      const existingIds = new Set((settings.models || []).map(m => m.id));
      const newModels = fetched.filter(m => !existingIds.has(m.id));
      setSettings(prev => ({
        ...prev,
        models: [...(prev.models || []), ...newModels],
      }));
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } };
      setFetchError(err.response?.data?.detail || t("settings.fetchFailed"));
    } finally {
      setFetching(false);
    }
  };

  const handleAddModel = () => {
    if (!newModelId.trim()) return;
    setSettings(prev => ({
      ...prev,
      models: [...(prev.models || []), { id: newModelId.trim(), name: newModelName.trim() || newModelId.trim() }],
    }));
    setNewModelId("");
    setNewModelName("");
  };

  const handleRemoveModel = (id: string) => {
    setSettings(prev => ({
      ...prev,
      models: (prev.models || []).filter(m => m.id !== id),
    }));
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      await axios.post("/api/settings", settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAgentsMd = async () => {
    setSavingAgentsMd(true);
    try {
      await axios.put("/api/settings/agents-md", { content: agentsMd });
      setAgentsMdSaved(true);
      setTimeout(() => setAgentsMdSaved(false), 2000);
    } finally {
      setSavingAgentsMd(false);
    }
  };

  const handleSaveMemoryMd = async () => {
    setSavingMemoryMd(true);
    try {
      await axios.put("/api/settings/memory-md", { content: memoryMd });
      setMemoryMdSaved(true);
      setTimeout(() => setMemoryMdSaved(false), 2000);
    } finally {
      setSavingMemoryMd(false);
    }
  };

  const hasModels = (settings.models?.length ?? 0) > 0;

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span className="settings-header-icon"><SettingsIcon /></span>
        <span className="settings-header-title">{t("settings.title")}</span>
      </div>

      <div className="settings-content">
        <div className="settings-group">
          <div className="settings-group-title">
            <ApiIcon />
            {t("settings.apiConfig")}
          </div>

          <div className="settings-field">
            <label className="settings-label">{t("settings.apiFormat")}</label>
            <select
              className="settings-select"
              value={settings.api_format}
              onChange={(e) => setSettings({ ...settings, api_format: e.target.value as "openai" | "anthropic" })}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>

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
              {settings.api_format === "openai"
                ? t("settings.openaiHelp")
                : t("settings.anthropicHelp")}
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

          <div className="settings-inline-actions">
            <button
              className="settings-btn settings-btn-secondary settings-btn-full"
              onClick={handleFetchModels}
              disabled={fetching || !settings.base_url || !settings.api_key}
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
              disabled={streamTesting || !settings.base_url || !settings.api_key || !testModel}
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

          {streamTesting && (
            <button
              className="settings-btn settings-btn-secondary settings-btn-full"
              onClick={handleStopStreamTest}
              style={{ marginTop: "8px" }}
            >
              {t("settings.streamTestStop")}
            </button>
          )}

          {(streamOutput || streamError || streamSuccess) && (
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
                  {streamOutput && (
                    <pre className="settings-stream-output">{streamOutput}</pre>
                  )}
                </>
              )}
            </div>
          )}

          {fetchError && (
            <div className="settings-error" style={{ marginTop: "12px" }}>
              <span className="settings-error-icon"><ErrorIcon /></span>
              {fetchError}
            </div>
          )}
        </div>

        <div className="settings-group">
          <div className="settings-group-title">
            <ModelIcon />
            {t("settings.modelConfig")}
          </div>

          {hasModels && (
            <div className="settings-field">
              <label className="settings-label">{t("settings.activeModel")}</label>
              <select
                className="settings-select"
                value={settings.selected_model}
                onChange={(e) => setSettings({ ...settings, selected_model: e.target.value })}
              >
                <option value="">{t("settings.selectModel")}</option>
                {settings.models?.map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
              </select>
            </div>
          )}

          <div className="settings-field">
            <label className="settings-label">
              {t("settings.configuredModels")}
              {hasModels && <span className="settings-label-hint">({settings.models.length})</span>}
            </label>

            {hasModels ? (
              <div className="settings-models-list">
                {settings.models?.map((m) => (
                  <div key={m.id} className="settings-model-item">
                    <div className="settings-model-info">
                      <span className="settings-model-id">{m.id}</span>
                      {m.name && m.name !== m.id && (
                        <span className="settings-model-name">{m.name}</span>
                      )}
                    </div>
                    <button
                      className="settings-model-remove"
                      onClick={() => handleRemoveModel(m.id)}
                      title={t("settings.removeModel")}
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

        <div className="settings-group">
          <div className="settings-group-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="16" y2="17" />
            </svg>
            {t("settings.agentDocs")}
          </div>

          <div className="settings-field">
            <label className="settings-label">{t("settings.agentsMd")}</label>
            <textarea
              className="settings-textarea"
              value={agentsMd}
              onChange={(e) => setAgentsMd(e.target.value)}
            />
            <div className="settings-help">{t("settings.agentsMdHelp")}</div>
            <button
              className="settings-btn settings-btn-secondary settings-btn-full"
              onClick={handleSaveAgentsMd}
              disabled={savingAgentsMd}
            >
              {agentsMdSaved ? t("settings.docSaved") : t("settings.saveDoc")}
            </button>
          </div>

          <div className="settings-field">
            <label className="settings-label">{t("settings.memoryMd")}</label>
            <textarea
              className="settings-textarea"
              value={memoryMd}
              onChange={(e) => setMemoryMd(e.target.value)}
            />
            <div className="settings-help">{t("settings.memoryMdHelp")}</div>
            <button
              className="settings-btn settings-btn-secondary settings-btn-full"
              onClick={handleSaveMemoryMd}
              disabled={savingMemoryMd}
            >
              {memoryMdSaved ? t("settings.docSaved") : t("settings.saveDoc")}
            </button>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            {t("settings.language")}
          </div>
          <div className="settings-field">
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
        </div>

        <div className="settings-group">
          <div className="settings-group-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 2a10 10 0 0 1 0 20 10 10 0 0 1 0-20z" />
              <path d="M12 2v20" />
            </svg>
            {t("settings.appearance")}
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

        <div className="settings-group">
          <div className="settings-group-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            {t("settings.agentAccess")}
          </div>
          <div className="settings-field">
            <label className="settings-label">{t("settings.agentApiToken")}</label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                className="settings-input"
                value={settings.agent_api_token}
                onChange={(e) => setSettings({ ...settings, agent_api_token: e.target.value })}
                placeholder="token..."
                style={{ flex: 1 }}
              />
              <button
                className="settings-btn settings-btn-secondary"
                onClick={handleCopyToken}
                type="button"
                disabled={!settings.agent_api_token}
              >
                {tokenCopied ? t("settings.copied") : t("settings.copy")}
              </button>
              <button
                className="settings-btn settings-btn-secondary"
                onClick={handleGenerateToken}
                type="button"
              >
                {t("settings.agentApiTokenGenerate")}
              </button>
            </div>
            <div className="settings-help">{t("settings.agentApiTokenHelp")}</div>
          </div>

          <div className="settings-field">
            <div className="settings-help" style={{ marginBottom: "8px" }}>
              {t("settings.agentAccessDesc")}
            </div>
            <textarea
              className="settings-input"
              value={installPrompt}
              readOnly
              rows={2}
              onFocus={(e) => e.target.select()}
              style={{ resize: "none", fontFamily: "monospace" }}
            />
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
              <button
                className="settings-btn settings-btn-primary"
                onClick={handleCopyInstallPrompt}
                style={{ flex: 1 }}
              >
                {linkCopied ? t("settings.agentAccessCopied") : t("settings.agentAccessCopy")}
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
        </div>

        <div className="settings-group">
          <div className="settings-group-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            {t("settings.webAccess")}
          </div>
          <div className="settings-field">
            <label className="settings-label">{t("settings.webAccessKey")}</label>
            <div style={{ display: "flex", gap: "8px" }}>
              <input
                type="text"
                className="settings-input"
                value={settings.web_access_key}
                onChange={(e) => setSettings({ ...settings, web_access_key: e.target.value })}
                placeholder="key..."
                style={{ flex: 1 }}
              />
              <button
                className="settings-btn settings-btn-secondary"
                onClick={handleGenerateWebKey}
                type="button"
              >
                {t("settings.agentApiTokenGenerate")}
              </button>
            </div>
            <div className="settings-help">{t("settings.webAccessKeyHelp")}</div>
          </div>
        </div>

        <div className="settings-group">
          {saved && (
            <div className="settings-success" style={{ marginBottom: "12px" }}>
              <CheckIcon />
              {t("settings.saved")}
            </div>
          )}
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
          <div style={{ marginTop: "12px" }}>
            <a
              className="settings-btn settings-btn-secondary settings-btn-full"
              href={`${getApiBaseUrl() || (typeof window !== "undefined" ? window.location.origin : "")}/api/settings/export`}
              download="winkterm-config.json"
              style={{ textDecoration: "none", textAlign: "center", display: "block" }}
            >
              {t("settings.exportConfig")}
            </a>
            <div className="settings-help" style={{ marginTop: "6px" }}>
              {t("settings.exportConfigHelp")}
            </div>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-group-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            {t("settings.about")}
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
          <div className="settings-help" style={{ marginTop: "6px" }}>
            {t("settings.githubProjectHelp")}
          </div>
        </div>
      </div>
    </div>
  );
}
