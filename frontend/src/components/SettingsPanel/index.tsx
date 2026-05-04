"use client";

import { useState, useEffect } from "react";
import axios from "@/lib/axios";
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

export default function SettingsPanel() {
  const [settings, setSettings] = useState<Settings>({
    api_format: "openai",
    base_url: "",
    api_key: "",
    models: [],
    selected_model: "",
  });
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fetchError, setFetchError] = useState("");

  useEffect(() => {
    axios.get("/api/settings").then((res) => {
      const data = res.data;
      setSettings({
        api_format: data.api_format || "openai",
        base_url: data.base_url || "",
        api_key: data.api_key || "",
        models: data.models || [],
        selected_model: data.selected_model || "",
      });
    });
  }, []);

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
        setFetchError("No models returned. Check your Base URL and API Key.");
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
      setFetchError(err.response?.data?.detail || "Failed to fetch model list");
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

  const hasModels = (settings.models?.length ?? 0) > 0;

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span className="settings-header-icon"><SettingsIcon /></span>
        <span className="settings-header-title">Settings</span>
      </div>

      <div className="settings-content">
        <div className="settings-group">
          <div className="settings-group-title">
            <ApiIcon />
            API Configuration
          </div>

          <div className="settings-field">
            <label className="settings-label">API Format</label>
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
            <label className="settings-label">Base URL</label>
            <input
              type="text"
              className="settings-input"
              value={settings.base_url}
              onChange={(e) => setSettings({ ...settings, base_url: e.target.value })}
              placeholder={settings.api_format === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"}
            />
            <div className="settings-help">
              {settings.api_format === "openai"
                ? "OpenAI-compatible API base URL (Ollama, Groq, OpenRouter, etc.)"
                : "Anthropic API base URL (usually no change needed)"}
            </div>
          </div>

          <div className="settings-field">
            <label className="settings-label">API Key</label>
            <input
              type="password"
              className="settings-input"
              value={settings.api_key}
              onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
              placeholder="sk-..."
            />
          </div>

          <button
            className="settings-btn settings-btn-secondary settings-btn-full"
            onClick={handleFetchModels}
            disabled={fetching || !settings.base_url || !settings.api_key}
          >
            {fetching ? (
              <>
                <span className="settings-spinner" />
                Fetching...
              </>
            ) : (
              <>
                <RefreshIcon />
                Auto-fetch models
              </>
            )}
          </button>

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
            Model Configuration
          </div>

          {hasModels && (
            <div className="settings-field">
              <label className="settings-label">Active Model</label>
              <select
                className="settings-select"
                value={settings.selected_model}
                onChange={(e) => setSettings({ ...settings, selected_model: e.target.value })}
              >
                <option value="">Select a model</option>
                {settings.models?.map((m) => (
                  <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
              </select>
            </div>
          )}

          <div className="settings-field">
            <label className="settings-label">
              Configured Models
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
                      title="Remove model"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-empty">
                <div className="settings-empty-icon"><ModelIcon /></div>
                <div>No models configured</div>
                <div style={{ fontSize: "11px", marginTop: "4px" }}>Click "Auto-fetch models" above or add one manually</div>
              </div>
            )}
          </div>

          <div className="settings-field">
            <label className="settings-label">Add Model Manually</label>
            <div className="settings-add-model">
              <input
                type="text"
                className="settings-input"
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                placeholder="Model ID"
                onKeyDown={(e) => e.key === "Enter" && handleAddModel()}
              />
              <input
                type="text"
                className="settings-input"
                value={newModelName}
                onChange={(e) => setNewModelName(e.target.value)}
                placeholder="Display name (optional)"
                onKeyDown={(e) => e.key === "Enter" && handleAddModel()}
              />
              <button
                className="settings-btn settings-btn-secondary"
                onClick={handleAddModel}
                disabled={!newModelId.trim()}
                title="Add model"
              >
                <PlusIcon />
              </button>
            </div>
          </div>
        </div>

        <div className="settings-group">
          {saved && (
            <div className="settings-success" style={{ marginBottom: "12px" }}>
              <CheckIcon />
              Settings saved
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
                Saving...
              </>
            ) : (
              "Save Settings"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
