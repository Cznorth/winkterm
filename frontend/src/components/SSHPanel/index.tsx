"use client";

import { useState, useEffect, useRef } from "react";
import axios from "@/lib/axios";
import "./SSHPanel.css";

interface SSHConnection {
  id: string;
  title: string;
  host: string;
  port: number;
  username: string;
  auth_type: "password" | "key";
  password?: string;
  private_key_path?: string;
  color?: string;
  group?: string;
}

interface SSHPanelProps {
  onConnect?: (conn: SSHConnection) => void;
}

export default function SSHPanel({ onConnect }: SSHPanelProps) {
  const [connections, setConnections] = useState<SSHConnection[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: "",
    host: "",
    port: 22,
    username: "",
    auth_type: "password" as "password" | "key",
    password: "",
    private_key_path: "",
    color: "#0078d4",
    group: "",
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadConnections();
  }, []);

  const loadConnections = async () => {
    try {
      const res = await axios.get("/api/ssh/connections");
      setConnections(res.data.connections || []);
    } catch (e) {
      console.error("加载 SSH 连接失败:", e);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportElecterm = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // electerm 格式: { bookmarks: [...] }
      const bookmarks = data.bookmarks || [data];

      await axios.post("/api/ssh/import/electerm", { bookmarks });
      loadConnections();
    } catch (err) {
      console.error("导入失败:", err);
      alert("导入失败，请检查文件格式");
    }

    // 清空 input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleEdit = (conn: SSHConnection) => {
    setEditingId(conn.id);
    setForm({
      title: conn.title,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      auth_type: conn.auth_type,
      password: "",
      private_key_path: conn.private_key_path || "",
      color: conn.color || "#0078d4",
      group: conn.group || "",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    try {
      if (editingId) {
        await axios.put(`/api/ssh/connections/${editingId}`, form);
      } else {
        await axios.post("/api/ssh/connections", form);
      }
      setShowForm(false);
      setEditingId(null);
      setForm({
        title: "",
        host: "",
        port: 22,
        username: "",
        auth_type: "password",
        password: "",
        private_key_path: "",
        color: "#0078d4",
        group: "",
      });
      loadConnections();
    } catch (e) {
      console.error("保存失败:", e);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除此连接？")) return;

    try {
      await axios.delete(`/api/ssh/connections/${id}`);
      loadConnections();
    } catch (e) {
      console.error("删除失败:", e);
    }
  };

  const handleNewConnection = () => {
    setEditingId(null);
    setForm({
      title: "",
      host: "",
      port: 22,
      username: "",
      auth_type: "password",
      password: "",
      private_key_path: "",
      color: "#0078d4",
      group: "",
    });
    setShowForm(true);
  };

  return (
    <div className="ssh-panel">
      {/* 标题栏 */}
      <div className="ssh-header">
        <span className="ssh-header-title">SSH 连接</span>
        <div className="ssh-header-actions">
          <button className="ssh-btn" onClick={handleNewConnection}>
            新建
          </button>
          <button className="ssh-btn" onClick={handleImportClick}>
            导入
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportElecterm}
            style={{ display: "none" }}
          />
        </div>
      </div>

      {/* 连接列表 */}
      <div className="ssh-list">
        {connections.length === 0 ? (
          <div className="ssh-empty">
            <p>暂无 SSH 连接</p>
            <p>点击"新建"添加连接，或"导入"electerm 配置</p>
          </div>
        ) : (
          connections.map((conn) => (
            <div
              key={conn.id}
              className="ssh-item"
              style={{ borderLeftColor: conn.color || "#0078d4" }}
            >
              <div className="ssh-item-info">
                <div className="ssh-item-title">{conn.title || conn.host}</div>
                <div className="ssh-item-detail">
                  {conn.username}@{conn.host}:{conn.port}
                </div>
              </div>
              <div className="ssh-item-actions">
                {onConnect && (
                  <button
                    className="ssh-item-btn connect"
                    onClick={() => onConnect(conn)}
                    title="连接"
                  >
                    连接
                  </button>
                )}
                <button
                  className="ssh-item-btn"
                  onClick={() => handleEdit(conn)}
                >
                  编辑
                </button>
                <button
                  className="ssh-item-btn delete"
                  onClick={() => handleDelete(conn.id)}
                >
                  删除
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 编辑表单 */}
      {showForm && (
        <div className="ssh-form-overlay">
          <div className="ssh-form">
            <div className="ssh-form-header">
              <h3>{editingId ? "编辑连接" : "新建连接"}</h3>
            </div>

            <div className="ssh-form-body">
              <div className="ssh-form-row">
                <label>名称</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="服务器名称（可选）"
                />
              </div>

              <div className="ssh-form-row">
                <label>主机 *</label>
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder="IP 或域名"
                />
              </div>

              <div className="ssh-form-row">
                <label>端口</label>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 22 })}
                />
              </div>

              <div className="ssh-form-row">
                <label>用户名 *</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder="用户名"
                />
              </div>

              <div className="ssh-form-row">
                <label>认证方式</label>
                <select
                  value={form.auth_type}
                  onChange={(e) => setForm({ ...form, auth_type: e.target.value as "password" | "key" })}
                >
                  <option value="password">密码</option>
                  <option value="key">密钥</option>
                </select>
              </div>

              {form.auth_type === "password" ? (
                <div className="ssh-form-row">
                  <label>密码</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder={editingId ? "留空保持不变" : "密码"}
                  />
                </div>
              ) : (
                <div className="ssh-form-row">
                  <label>私钥路径</label>
                  <input
                    type="text"
                    value={form.private_key_path}
                    onChange={(e) => setForm({ ...form, private_key_path: e.target.value })}
                    placeholder="例如: ~/.ssh/id_rsa"
                  />
                </div>
              )}

              <div className="ssh-form-row">
                <label>颜色</label>
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                />
              </div>
            </div>

            <div className="ssh-form-footer">
              <button className="ssh-btn primary" onClick={handleSave}>
                保存
              </button>
              <button className="ssh-btn" onClick={() => setShowForm(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
