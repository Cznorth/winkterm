"use client";

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import axios from "@/lib/axios";
import { useI18n } from "@/lib/i18n";
import FileTransferDialog from "@/components/FileTransferDialog";
import { useBreakpoint } from "@/hooks/useBreakpoint";
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
  vnc_port?: number;
  vnc_password?: string;
  color?: string;
  group?: string;
  has_runbook?: boolean;
}

interface SSHPanelProps {
  onConnect?: (conn: SSHConnection) => void;
  onVNCConnect?: (conn: SSHConnection, vncPort: number, vncPassword?: string) => void;
}

const VNCIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

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

const RunbookIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    <line x1="8" y1="7" x2="16" y2="7" />
    <line x1="8" y1="11" x2="14" y2="11" />
  </svg>
);

export default function SSHPanel({ onConnect, onVNCConnect }: SSHPanelProps) {
  const { t } = useI18n();
  const breakpoint = useBreakpoint();
  const useInlineTransfer = breakpoint === "desktop";
  const useMobileVncDialog = breakpoint !== "desktop";
  const [portalReady, setPortalReady] = useState(false);
  const [connections, setConnections] = useState<SSHConnection[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<SSHConnection | null>(null);
  const [vncTarget, setVncTarget] = useState<SSHConnection | null>(null);
  const [vncPort, setVncPort] = useState(5901);
  const [vncPassword, setVncPassword] = useState("");
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [runbookTarget, setRunbookTarget] = useState<SSHConnection | null>(null);
  const [runbookText, setRunbookText] = useState("");
  const [runbookLoading, setRunbookLoading] = useState(false);
  const [runbookStatus, setRunbookStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [form, setForm] = useState({
    title: "",
    host: "",
    port: 22,
    username: "",
    auth_type: "password" as "password" | "key",
    password: "",
    private_key_path: "",
    vnc_port: 5901,
    vnc_password: "",
    color: "#0078d4",
    group: "",
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPortalReady(true);
  }, []);

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

  const hasSavedVncPassword = (conn: SSHConnection) =>
    !!conn.vnc_password && conn.vnc_password.includes("*");

  const saveVncSettings = async (connId: string, port: number, password: string) => {
    const payload: { vnc_port: number; vnc_password?: string } = { vnc_port: port };
    if (password.trim()) {
      payload.vnc_password = password.trim();
    }
    await axios.put(`/api/ssh/connections/${connId}`, payload);
    await loadConnections();
  };

  const resolveVncPassword = async (connId: string, entered: string): Promise<string | undefined> => {
    if (entered.trim()) return entered.trim();
    const res = await axios.get<{ connection: SSHConnection }>(
      `/api/ssh/connections/${connId}`,
      { params: { secrets: true } }
    );
    return res.data.connection.vnc_password || undefined;
  };

  const handleVNCSave = async () => {
    if (!vncTarget) return;
    try {
      await saveVncSettings(vncTarget.id, vncPort, vncPassword);
      setVncTarget(null);
      setVncPassword("");
    } catch (e) {
      console.error("VNC save failed:", e);
    }
  };

  const handleVNCConnect = async () => {
    if (!vncTarget) return;
    try {
      if (vncPassword.trim()) {
        await saveVncSettings(vncTarget.id, vncPort, vncPassword);
      } else {
        await axios.put(`/api/ssh/connections/${vncTarget.id}`, { vnc_port: vncPort });
      }
      const password = await resolveVncPassword(vncTarget.id, vncPassword);
      onVNCConnect?.(vncTarget, vncPort, password);
      setVncTarget(null);
      setVncPort(5901);
      setVncPassword("");
    } catch (e) {
      console.error("VNC connect failed:", e);
    }
  };

  const handleOpenVNC = (conn: SSHConnection) => {
    setShowForm(false);
    setTransferTarget(null);
    setVncTarget(conn);
    setVncPort(conn.vnc_port ?? 5901);
    setVncPassword("");
  };

  const handleCloseVNC = () => {
    setVncTarget(null);
  };

  const handleOpenRunbook = async (conn: SSHConnection) => {
    setShowForm(false);
    setTransferTarget(null);
    setVncTarget(null);
    setRunbookTarget(conn);
    setRunbookText("");
    setRunbookStatus("idle");
    setRunbookLoading(true);
    try {
      const res = await axios.get<{ runbook: string }>(
        `/api/ssh/connections/${conn.id}/runbook`
      );
      setRunbookText(res.data.runbook || "");
    } catch (e) {
      console.error("Failed to load runbook:", e);
    } finally {
      setRunbookLoading(false);
    }
  };

  const handleCloseRunbook = () => {
    setRunbookTarget(null);
    setRunbookText("");
    setRunbookStatus("idle");
  };

  const handleSaveRunbook = async () => {
    if (!runbookTarget) return;
    setRunbookStatus("saving");
    try {
      await axios.put(`/api/ssh/connections/${runbookTarget.id}/runbook`, {
        runbook: runbookText,
      });
      setRunbookStatus("saved");
      loadConnections();
    } catch (e) {
      console.error("Save runbook failed:", e);
      setRunbookStatus("error");
    }
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

  const togglePasswordVisible = async () => {
    // Revealing while editing: the stored password was never sent to the
    // frontend (masked), so fetch the plaintext on demand.
    if (!showPassword && editingId && !form.password) {
      try {
        const res = await axios.get<{ connection: SSHConnection }>(
          `/api/ssh/connections/${editingId}`,
          { params: { secrets: true } },
        );
        const secret = res.data.connection.password;
        if (secret) setForm((f) => ({ ...f, password: secret }));
      } catch (e) {
        console.error("Reveal password failed:", e);
      }
    }
    setShowPassword((v) => !v);
  };

  const handleEdit = (conn: SSHConnection) => {
    setTransferTarget(null);
    setShowPassword(false);
    setEditingId(conn.id);
    setForm({
      title: conn.title,
      host: conn.host,
      port: conn.port,
      username: conn.username,
      auth_type: conn.auth_type,
      password: "",
      private_key_path: conn.private_key_path || "",
      vnc_port: conn.vnc_port ?? 5901,
      vnc_password: "",
      color: conn.color || "#0078d4",
      group: conn.group || "",
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    try {
      if (editingId) {
        const { password, vnc_password, ...rest } = form;
        const payload: typeof form = { ...rest, password, vnc_password };
        if (!password?.trim()) delete (payload as { password?: string }).password;
        if (!vnc_password?.trim()) delete (payload as { vnc_password?: string }).vnc_password;
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
        vnc_port: 5901,
        vnc_password: "",
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
    setShowPassword(false);
    setEditingId(null);
    setForm({
      title: "",
      host: "",
      port: 22,
      username: "",
      auth_type: "password",
      password: "",
      private_key_path: "",
      vnc_port: 5901,
      vnc_password: "",
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

  const handleCloseForm = () => {
    setShowForm(false);
    setShowPassword(false);
    setEditingId(null);
  };

  const connectionForm = showForm ? (
    <div className="ssh-form">
      <div className="ssh-form-header">
        <h3>{editingId ? t("ssh.editConnection") : t("ssh.newConnectionTitle")}</h3>
        <button className="ssh-form-close" onClick={handleCloseForm} title={t("ssh.close")}>
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
            <div className="ssh-password-field">
              <input
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={editingId ? t("ssh.passwordPlaceholderEdit") : t("ssh.password")}
              />
              <button
                type="button"
                className="ssh-password-toggle"
                onClick={togglePasswordVisible}
                title={showPassword ? t("ssh.hidePassword") : t("ssh.showPassword")}
              >
                {showPassword ? "🙈" : "👁"}
              </button>
            </div>
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

        <div className="ssh-form-section">{t("vnc.settings")}</div>

        <div className="ssh-form-row">
          <label>{t("vnc.port")}</label>
          <input
            type="number"
            value={form.vnc_port}
            onChange={(e) => setForm({ ...form, vnc_port: parseInt(e.target.value) || 5901 })}
            min={1}
            max={65535}
          />
        </div>

        <div className="ssh-form-row">
          <label>{t("vnc.password")}</label>
          <input
            type="password"
            value={form.vnc_password}
            onChange={(e) => setForm({ ...form, vnc_password: e.target.value })}
            placeholder={editingId ? t("vnc.passwordPlaceholderEdit") : t("vnc.passwordPlaceholderNew")}
          />
        </div>
      </div>

      <div className="ssh-form-footer">
        <button className="ssh-btn primary" onClick={handleSave}>
          {t("ssh.save")}
        </button>
        <button className="ssh-btn" onClick={handleCloseForm}>
          {t("ssh.cancel")}
        </button>
      </div>
    </div>
  ) : null;

  const vncDialog = vncTarget ? (
    <div className="ssh-form vnc-dialog">
      <div className="ssh-form-header">
        <h3>{t("vnc.connectTo")}{vncTarget.title || vncTarget.host}</h3>
        <button className="ssh-form-close" onClick={handleCloseVNC} title={t("ssh.close")}>
          ✕
        </button>
      </div>
      <div className="ssh-form-body">
        <div className="ssh-form-row">
          <label>{t("vnc.port")}</label>
          <input
            type="number"
            value={vncPort}
            onChange={(e) => setVncPort(parseInt(e.target.value) || 5901)}
            min={1}
            max={65535}
          />
        </div>
        <div className="ssh-form-row">
          <label>{t("vnc.password")}</label>
          <input
            type="password"
            value={vncPassword}
            onChange={(e) => setVncPassword(e.target.value)}
            placeholder={
              hasSavedVncPassword(vncTarget)
                ? t("vnc.passwordPlaceholder")
                : t("vnc.passwordPlaceholderNew")
            }
          />
        </div>
      </div>
      <div className="ssh-form-footer">
        <button className="ssh-btn primary" onClick={handleVNCConnect}>
          {t("vnc.connect")}
        </button>
        <button className="ssh-btn" onClick={handleVNCSave}>
          {t("vnc.save")}
        </button>
        <button className="ssh-btn" onClick={handleCloseVNC}>
          {t("ssh.cancel")}
        </button>
      </div>
    </div>
  ) : null;

  const runbookDialog = runbookTarget ? (
    <div className="ssh-form runbook-dialog">
      <div className="ssh-form-header">
        <h3>{t("ssh.runbookTitle")} · {runbookTarget.title || runbookTarget.host}</h3>
        <button className="ssh-form-close" onClick={handleCloseRunbook} title={t("ssh.close")}>
          ✕
        </button>
      </div>
      <div className="ssh-form-body">
        <textarea
          className="ssh-runbook-textarea"
          value={runbookText}
          onChange={(e) => {
            setRunbookText(e.target.value);
            if (runbookStatus !== "idle") setRunbookStatus("idle");
          }}
          placeholder={runbookLoading ? "…" : t("ssh.runbookPlaceholder")}
          disabled={runbookLoading}
          rows={18}
          spellCheck={false}
        />
      </div>
      <div className="ssh-form-footer">
        <button className="ssh-btn primary" onClick={handleSaveRunbook} disabled={runbookLoading || runbookStatus === "saving"}>
          {t("ssh.save")}
        </button>
        {runbookStatus === "saved" && <span className="ssh-runbook-status ok">{t("ssh.runbookSaved")}</span>}
        {runbookStatus === "error" && <span className="ssh-runbook-status err">{t("ssh.runbookSaveFailed")}</span>}
        <button className="ssh-btn" onClick={handleCloseRunbook}>
          {t("ssh.cancel")}
        </button>
      </div>
    </div>
  ) : null;

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
                    className="ssh-item-btn vnc"
                    onClick={() => handleOpenVNC(conn)}
                    title={t("vnc.connect")}
                    aria-label={t("vnc.connect")}
                  >
                    <VNCIcon />
                  </button>
                  <button
                    className="ssh-item-btn transfer"
                    onClick={() => handleOpenTransfer(conn)}
                    title={t("ssh.fileTransfer")}
                    aria-label={t("ssh.fileTransfer")}
                  >
                    <TransferIcon />
                  </button>
                  <button
                    className={`ssh-item-btn runbook${conn.has_runbook ? " has-runbook" : ""}`}
                    onClick={() => handleOpenRunbook(conn)}
                    title={t("ssh.runbook")}
                    aria-label={t("ssh.runbook")}
                  >
                    <RunbookIcon />
                  </button>
                  <button
                    type="button"
                    className="ssh-item-btn edit"
                    onClick={() => handleEdit(conn)}
                    title={t("ssh.edit")}
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

        {showForm && !useMobileVncDialog && connectionForm}
        {vncTarget && !useMobileVncDialog && vncDialog}
        {runbookTarget && !useMobileVncDialog && runbookDialog}
        {transferTarget && (
          <FileTransferDialog
            open={true}
            connectionId={transferTarget.id}
            title={transferTarget.title || transferTarget.host}
            onClose={handleCloseTransfer}
            inline={useInlineTransfer}
          />
        )}
      </div>

      {portalReady && useMobileVncDialog && vncTarget && createPortal(
        <div
          className="vnc-dialog-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseVNC();
          }}
        >
          <div onClick={(e) => e.stopPropagation()}>{vncDialog}</div>
        </div>,
        document.body
      )}

      {portalReady && useMobileVncDialog && showForm && createPortal(
        <div
          className="vnc-dialog-overlay ssh-form-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseForm();
          }}
        >
          <div onClick={(e) => e.stopPropagation()}>{connectionForm}</div>
        </div>,
        document.body
      )}

      {portalReady && useMobileVncDialog && runbookTarget && createPortal(
        <div
          className="vnc-dialog-overlay ssh-form-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) handleCloseRunbook();
          }}
        >
          <div onClick={(e) => e.stopPropagation()}>{runbookDialog}</div>
        </div>,
        document.body
      )}
    </div>
  );
}
