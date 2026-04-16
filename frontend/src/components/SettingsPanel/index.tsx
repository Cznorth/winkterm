"use client";

import { useState, useEffect } from "react";
import axios from "@/lib/axios";

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
    setLoading(true);
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
        setFetchError("未获取到模型，请检查 Base URL 和 API Key");
        return;
      }
      // 合并去重
      const existingIds = new Set((settings.models || []).map(m => m.id));
      const newModels = fetched.filter(m => !existingIds.has(m.id));
      setSettings(prev => ({
        ...prev,
        models: [...(prev.models || []), ...newModels],
      }));
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } };
      setFetchError(err.response?.data?.detail || "获取模型列表失败");
    } finally {
      setLoading(false);
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

  return (
    <div style={{
      height: "100%",
      display: "flex",
      flexDirection: "column",
      backgroundColor: "#1e1e1e",
      color: "#cccccc",
    }}>
      {/* Header */}
      <div style={{
        padding: "12px 16px",
        borderBottom: "1px solid #3c3c3c",
        fontSize: "14px",
        fontWeight: 500,
      }}>
        设置
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: "16px", overflow: "auto" }}>
        {/* API Format */}
        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", marginBottom: "6px", fontSize: "12px", color: "#999" }}>
            API 格式
          </label>
          <select
            value={settings.api_format}
            onChange={(e) => setSettings({ ...settings, api_format: e.target.value as "openai" | "anthropic" })}
            style={{
              width: "100%",
              padding: "6px 10px",
              backgroundColor: "#3c3c3c",
              border: "1px solid #555",
              borderRadius: "4px",
              color: "#cccccc",
              fontSize: "13px",
            }}
          >
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>

        {/* Base URL */}
        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", marginBottom: "6px", fontSize: "12px", color: "#999" }}>
            Base URL
          </label>
          <input
            type="text"
            value={settings.base_url}
            onChange={(e) => setSettings({ ...settings, base_url: e.target.value })}
            placeholder={settings.api_format === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com"}
            style={{
              width: "100%",
              padding: "6px 10px",
              backgroundColor: "#3c3c3c",
              border: "1px solid #555",
              borderRadius: "4px",
              color: "#cccccc",
              fontSize: "13px",
            }}
          />
        </div>

        {/* API Key */}
        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", marginBottom: "6px", fontSize: "12px", color: "#999" }}>
            API Key
          </label>
          <input
            type="password"
            value={settings.api_key}
            onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
            placeholder="sk-..."
            style={{
              width: "100%",
              padding: "6px 10px",
              backgroundColor: "#3c3c3c",
              border: "1px solid #555",
              borderRadius: "4px",
              color: "#cccccc",
              fontSize: "13px",
            }}
          />
        </div>

        {/* Fetch Models Button */}
        <button
          onClick={handleFetchModels}
          disabled={loading || !settings.base_url || !settings.api_key}
          style={{
            width: "100%",
            padding: "8px",
            backgroundColor: "#2d5a88",
            border: "none",
            borderRadius: "4px",
            color: "#fff",
            fontSize: "13px",
            cursor: loading ? "wait" : "pointer",
            marginBottom: "16px",
            opacity: (!settings.base_url || !settings.api_key) ? 0.5 : 1,
          }}
        >
          {loading ? "获取中..." : "自动获取模型列表"}
        </button>

        {fetchError && (
          <div style={{ color: "#f44", fontSize: "12px", marginBottom: "12px" }}>{fetchError}</div>
        )}

        {/* Current Model */}
        {(settings.models?.length ?? 0) > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <label style={{ display: "block", marginBottom: "6px", fontSize: "12px", color: "#999" }}>
              当前模型
            </label>
            <select
              value={settings.selected_model}
              onChange={(e) => setSettings({ ...settings, selected_model: e.target.value })}
              style={{
                width: "100%",
                padding: "6px 10px",
                backgroundColor: "#3c3c3c",
                border: "1px solid #555",
                borderRadius: "4px",
                color: "#cccccc",
                fontSize: "13px",
              }}
            >
              <option value="">选择模型</option>
              {settings.models?.map((m) => (
                <option key={m.id} value={m.id}>{m.name || m.id}</option>
              ))}
            </select>
          </div>
        )}

        {/* Models List */}
        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", marginBottom: "8px", fontSize: "12px", color: "#999" }}>
            模型列表 {(settings.models?.length ?? 0) > 0 && `(${settings.models.length})`}
          </label>
          <div style={{ maxHeight: "150px", overflow: "auto", marginBottom: "8px" }}>
            {settings.models?.map((m) => (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "6px 8px",
                  backgroundColor: "#2d2d2d",
                  borderRadius: "4px",
                  marginBottom: "4px",
                }}
              >
                <div>
                  <span style={{ fontSize: "13px" }}>{m.id}</span>
                  {m.name && m.name !== m.id && (
                    <span style={{ fontSize: "11px", color: "#666", marginLeft: "8px" }}>{m.name}</span>
                  )}
                </div>
                <button
                  onClick={() => handleRemoveModel(m.id)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#f44",
                    cursor: "pointer",
                    fontSize: "12px",
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          {/* Add Model Manually */}
          <div style={{ display: "flex", gap: "8px" }}>
            <input
              type="text"
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              placeholder="模型 ID"
              style={{
                flex: 1,
                padding: "6px 10px",
                backgroundColor: "#3c3c3c",
                border: "1px solid #555",
                borderRadius: "4px",
                color: "#cccccc",
                fontSize: "13px",
              }}
            />
            <input
              type="text"
              value={newModelName}
              onChange={(e) => setNewModelName(e.target.value)}
              placeholder="名称(可选)"
              style={{
                flex: 1,
                padding: "6px 10px",
                backgroundColor: "#3c3c3c",
                border: "1px solid #555",
                borderRadius: "4px",
                color: "#cccccc",
                fontSize: "13px",
              }}
            />
            <button
              onClick={handleAddModel}
              disabled={!newModelId.trim()}
              style={{
                padding: "6px 12px",
                backgroundColor: "#3c3c3c",
                border: "1px solid #555",
                borderRadius: "4px",
                color: "#ccc",
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              添加
            </button>
          </div>
        </div>

        {/* Save Button */}
        <button
          onClick={handleSave}
          disabled={loading}
          style={{
            width: "100%",
            padding: "8px",
            backgroundColor: "#0e639c",
            border: "none",
            borderRadius: "4px",
            color: "#fff",
            fontSize: "13px",
            cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "保存中..." : saved ? "已保存 ✓" : "保存"}
        </button>
      </div>
    </div>
  );
}
