"use client";

import { useState, useEffect, useRef } from "react";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";
import FileTransferDialog from "@/components/FileTransferDialog";
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

const TransferIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M7 7h10" />
    <path d="M13 3l4 4-4 4" />
    <path d="M17 17H7" />
    <path d="M11 21l-4-4 4-4" />
  </svg>
);

export default function SSHPanel({ onConnect }: SSHPanelProps) {
  const { t } = useI18n();
  const [connections, setConnections] = useState<SSHConnection[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<SSHConnection | null>(null);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
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
  const actionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadConnections();
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setActionMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const loadConnections = async () => {
    try {
      const res = await axios.get("/api/ssh/connections");
      setConnections(res.data.connections || []);
    } catch (e) {
      console.error("Failed to load SSH connections:", e);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleOpenTransfer = (conn: SSHConnection) => {
    setShowForm(false);
    setTransferTarget(conn);
  };

  const handleCloseTransfer = () => {
    setTransferTarget(null);
  };

  const handleImportElecterm = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const bookmarks = data.bookmarks || [data];
      await axios.post("/api/ssh/import/electerm", { bookmarks });
      loadConnections();
    } catch (err) {
      console.error("Import failed:", err);
      alert(t("ssh.importFailed"));
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleEdit = (conn: SSHConnection) => {
    setTransferTarget(null);
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
        // 编辑时密码框默认为空：未填写则不提交，避免覆盖已保存的密码
        const { password, ...rest } = form;
        const payload = password?.trim() ? form : rest;
        await axios.put(`/api/ssh/connections/${editingId}`, payload);
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
      console.error("Save failed:", e);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this connection?")) return;

    try {
      if (transferTarget?.id === id) {
        handleCloseTransfer();
      }
      await axios.delete(`/api/ssh/connections/${id}`);
      loadConnections();
    } catch (e) {
      console.error("Delete failed:", e);
    }
  };

  const handleNewConnection = () => {
    setTransferTarget(null);
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

  const handleQuickTransfer = () => {
    const firstConnection = connections[0];
    if (firstConnection) {
      setTransferTarget(firstConnection);
    } else {
      setActionMenuOpen(false);
      setShowForm(true);
    }
  };

  return (
    <div className="ssh-panel">
      <div className="ssh-header">
        <span className="ssh-header-title">{t("ssh.title")}</span>
        <div className="ssh-header-actions">
          <span className="ssh-header-hint">{t("ssh.subtitle")}</span>
          <div className="ssh-header-menu" ref={actionMenuRef}>
            <button
              className="ssh-btn ssh-btn-secondary"
              onClick={() => setActionMenuOpen((current) => !current)}
              title={t("ssh.more")}
            >
              {t("ssh.more")}
            </button>
            {actionMenuOpen && (
              <div className="ssh-header-dropdown">
                <button className="ssh-header-menu-item" onClick={handleNewConnection}>
                  {t("ssh.newConnection")}
                </button>
                <button className="ssh-header-menu-item" onClick={handleQuickTransfer} disabled={connections.length === 0}>
                  {t("ssh.fileTransfer")}
                </button>
                <button className="ssh-header-menu-item" onClick={handleImportClick}>
                  {t("ssh.importConnections")}
                </button>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImportElecterm}
            style={{ display: "none" }}
          />
        </div>
      </div>

      <div className="ssh-body">
        <div className="ssh-list">
          {connections.length === 0 ? (
            <div className="ssh-empty">
              <p>{t("ssh.noConnections")}</p>
              <p>{t("ssh.noConnectionsHint")}</p>
              <button className="ssh-empty-action" onClick={handleQuickTransfer}>
                {t("ssh.openFileTransfer")}
              </button>
            </div>
          ) : (
            connections.map((conn) => (
              <div
                key={conn.id}
                className={`ssh-item ${editingId === conn.id && showForm ? "selected" : ""}`}
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
                      title={t("ssh.connect")}
                    >
                      {t("ssh.connect")}
                    </button>
                  )}
                  <button
                    className="ssh-item-btn transfer"
                    onClick={() => handleOpenTransfer(conn)}
                    title={t("ssh.fileTransfer")}
                    aria-label={t("ssh.fileTransfer")}
                  >
                    <TransferIcon />
                  </button>
                  <button
                    className="ssh-item-btn"
                    onClick={() => handleEdit(conn)}
                  >
                    {t("ssh.edit")}
                  </button>
                  <button
                    className="ssh-item-btn delete"
                    onClick={() => handleDelete(conn.id)}
                  >
                    {t("ssh.delete")}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {showForm && (
          <div className="ssh-form">
            <div className="ssh-form-header">
              <h3>{editingId ? t("ssh.editConnection") : t("ssh.newConnectionTitle")}</h3>
              <button className="ssh-form-close" onClick={() => setShowForm(false)} title={t("ssh.close")}>
                ✕
              </button>
            </div>

            <div className="ssh-form-body">
              <div className="ssh-form-row">
                <label>{t("ssh.name")}</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder={t("ssh.namePlaceholder")}
                />
              </div>

              <div className="ssh-form-row">
                <label>{t("ssh.host")}</label>
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  placeholder={t("ssh.hostPlaceholder")}
                />
              </div>

              <div className="ssh-form-row">
                <label>{t("ssh.port")}</label>
                <input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 22 })}
                />
              </div>

              <div className="ssh-form-row">
                <label>{t("ssh.username")}</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder={t("ssh.usernamePlaceholder")}
                />
              </div>

              <div className="ssh-form-row">
                <label>{t("ssh.authType")}</label>
                <select
                  value={form.auth_type}
                  onChange={(e) => setForm({ ...form, auth_type: e.target.value as "password" | "key" })}
                >
                  <option value="password">{t("ssh.password")}</option>
                  <option value="key">{t("ssh.key")}</option>
                </select>
              </div>

              {form.auth_type === "password" ? (
                <div className="ssh-form-row">
                  <label>{t("ssh.password")}</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder={editingId ? t("ssh.passwordPlaceholderEdit") : t("ssh.password")}
                  />
                </div>
              ) : (
                <div className="ssh-form-row">
                  <label>{t("ssh.privateKeyPath")}</label>
                  <input
                    type="text"
                    value={form.private_key_path}
                    onChange={(e) => setForm({ ...form, private_key_path: e.target.value })}
                    placeholder={t("ssh.privateKeyPlaceholder")}
                  />
                </div>
              )}

              <div className="ssh-form-row">
                <label>{t("ssh.color")}</label>
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => setForm({ ...form, color: e.target.value })}
                />
              </div>
            </div>

            <div className="ssh-form-footer">
              <button className="ssh-btn primary" onClick={handleSave}>
                {t("ssh.save")}
              </button>
              <button className="ssh-btn" onClick={() => setShowForm(false)}>
                {t("ssh.cancel")}
              </button>
            </div>
          </div>
        )}
        {transferTarget && (
          <FileTransferDialog
            open={true}
            connectionId={transferTarget.id}
            title={transferTarget.title || transferTarget.host}
            onClose={handleCloseTransfer}
            inline
          />
        )}
      </div>
    </div>
  );
}
