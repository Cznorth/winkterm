"use client";

import { useState, useEffect, useCallback, ReactNode } from "react";
import axios from "@/lib/axios";
import { setAccessKey } from "@/lib/auth";
import { isNativeApp, getBackendUrl, setBackendUrl } from "@/lib/backend";
import { useI18n } from "@/lib/i18n";

type Phase = "loading" | "ok" | "setup" | "login" | "neterror" | "server";

interface AuthStatus {
  local: boolean;
  configured: boolean;
  authenticated: boolean;
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("loading");
  const [key, setKey] = useState("");
  const [confirm, setConfirm] = useState("");
  const [server, setServer] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const checkStatus = useCallback(async () => {
    // Native app with no backend chosen yet: ask for the server first.
    if (isNativeApp() && !getBackendUrl()) {
      setPhase("server");
      return;
    }
    setPhase("loading");
    try {
      const res = await axios.get<AuthStatus>("/api/auth/status");
      const { local, configured, authenticated } = res.data;
      if (local || authenticated) {
        setPhase("ok");
      } else if (!configured) {
        setPhase("setup");
      } else {
        setPhase("login");
      }
    } catch {
      setPhase("neterror");
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleSaveServer = () => {
    setError("");
    const raw = server.trim();
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
    } catch {
      setError(t("auth.errBadUrl"));
      return;
    }
    setBackendUrl(raw);
    // Reload so axios baseURL / WS clients re-init against the new backend.
    window.location.reload();
  };

  const handleSubmit = async () => {
    setError("");
    const trimmed = key.trim();
    if (phase === "setup") {
      if (trimmed.length < 4) {
        setError(t("auth.errKeyShort"));
        return;
      }
      if (trimmed !== confirm.trim()) {
        setError(t("auth.errMismatch"));
        return;
      }
    } else if (!trimmed) {
      setError(t("auth.errWrongKey"));
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = phase === "setup" ? "/api/auth/setup" : "/api/auth/login";
      await axios.post(endpoint, { key: trimmed });
      setAccessKey(trimmed);
      // Reload so HTTP/WebSocket clients re-init with the access key
      window.location.reload();
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { detail?: string } } };
      const detail = err.response?.data?.detail;
      if (phase === "login") {
        setError(t("auth.errWrongKey"));
      } else {
        setError(detail || t("auth.errNetwork"));
      }
      setSubmitting(false);
    }
  };

  if (phase === "ok") return <>{children}</>;
  if (phase === "loading") {
    return <div style={overlayStyle} aria-busy="true" />;
  }

  if (phase === "server") {
    return (
      <Overlay>
        <div style={titleStyle}>{t("auth.serverTitle")}</div>
        <div style={descStyle}>{t("auth.serverDesc")}</div>
        <label style={labelStyle}>{t("auth.serverLabel")}</label>
        <input
          type="url"
          inputMode="url"
          autoFocus
          style={inputStyle}
          value={server}
          placeholder={t("auth.serverPlaceholder")}
          onChange={(e) => setServer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSaveServer();
          }}
        />
        {error && <div style={errorStyle}>{error}</div>}
        <button style={btnStyle} onClick={handleSaveServer}>
          {t("auth.submitServer")}
        </button>
      </Overlay>
    );
  }

  if (phase === "neterror") {
    return (
      <Overlay>
        <div style={titleStyle}>{t("auth.errNetwork")}</div>
        <button style={btnStyle} onClick={checkStatus}>
          {t("auth.retry")}
        </button>
        {isNativeApp() && (
          <button style={linkBtnStyle} onClick={() => setPhase("server")}>
            {t("auth.changeServer")}
          </button>
        )}
      </Overlay>
    );
  }

  const isSetup = phase === "setup";

  return (
    <Overlay>
      <div style={titleStyle}>{isSetup ? t("auth.setupTitle") : t("auth.loginTitle")}</div>
      <div style={descStyle}>{isSetup ? t("auth.setupDesc") : t("auth.loginDesc")}</div>

      <label style={labelStyle}>{t("auth.keyLabel")}</label>
      <input
        type="password"
        autoFocus
        style={inputStyle}
        value={key}
        placeholder={t("auth.keyPlaceholder")}
        onChange={(e) => setKey(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isSetup) handleSubmit();
        }}
      />

      {isSetup && (
        <>
          <label style={labelStyle}>{t("auth.confirmLabel")}</label>
          <input
            type="password"
            style={inputStyle}
            value={confirm}
            placeholder={t("auth.confirmPlaceholder")}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
          />
        </>
      )}

      {error && <div style={errorStyle}>{error}</div>}

      <button style={btnStyle} onClick={handleSubmit} disabled={submitting}>
        {submitting ? "..." : isSetup ? t("auth.submitSetup") : t("auth.submitLogin")}
      </button>

      {isNativeApp() && (
        <button style={linkBtnStyle} onClick={() => setPhase("server")}>
          {t("auth.changeServer")}
        </button>
      )}
    </Overlay>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div style={overlayStyle}>
      <div style={cardStyle}>{children}</div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--bg-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 9999,
};

const cardStyle: React.CSSProperties = {
  width: 360,
  maxWidth: "90vw",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border-default)",
  borderRadius: 10,
  padding: "28px 28px 24px",
  display: "flex",
  flexDirection: "column",
  boxShadow: "var(--shadow-lg)",
};

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: "var(--fg-primary)",
  marginBottom: 8,
};

const descStyle: React.CSSProperties = {
  fontSize: 13,
  color: "var(--fg-secondary)",
  marginBottom: 20,
  lineHeight: 1.5,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--fg-secondary)",
  marginBottom: 6,
};

const inputStyle: React.CSSProperties = {
  background: "var(--bg-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: 6,
  color: "var(--fg-primary)",
  fontSize: 14,
  padding: "9px 12px",
  marginBottom: 14,
  outline: "none",
};

const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--error)",
  marginBottom: 12,
};

const btnStyle: React.CSSProperties = {
  background: "var(--accent-primary)",
  border: "none",
  borderRadius: 6,
  color: "#ffffff",
  fontSize: 14,
  fontWeight: 500,
  padding: "10px 16px",
  cursor: "pointer",
  marginTop: 4,
};

const linkBtnStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--fg-secondary)",
  fontSize: 12,
  padding: "10px 0 0",
  cursor: "pointer",
  textDecoration: "underline",
};
