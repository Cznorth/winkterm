"use client";

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle, useState } from "react";
import { getVncWsBaseUrl } from "@/lib/config";
import { getAccessKey } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import "./VNCViewer.css";

interface VNCViewerProps {
  sessionId: string;
  sshConnectionId: string;
  vncPort: number;
  vncPassword?: string;
  isActive: boolean;
  isCompact?: boolean;
}

export interface VNCViewerRef {
  disconnect: () => void;
  reconnect: () => void;
}

type RFBClass = typeof import("@novnc/novnc").default;

type VncStatus = "idle" | "connecting" | "connected" | "error";

interface RFBEventDetail {
  clean?: boolean;
  reason?: string;
  status?: number;
  types?: string[];
}

let rfbModulePromise: Promise<{ default: RFBClass }> | null = null;

function loadRFB(): Promise<{ default: RFBClass }> {
  if (!rfbModulePromise) {
    rfbModulePromise = import("@novnc/novnc");
  }
  return rfbModulePromise;
}

function waitForContainerSize(container: HTMLElement, timeoutMs = 5000): Promise<boolean> {
  if (container.clientWidth > 0 && container.clientHeight > 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      ro.disconnect();
      resolve(container.clientWidth > 0 && container.clientHeight > 0);
    }, timeoutMs);

    const ro = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) {
        window.clearTimeout(timer);
        ro.disconnect();
        resolve(true);
      }
    });
    ro.observe(container);
  });
}

function applyRfbResize(rfb: InstanceType<RFBClass>, container: HTMLElement) {
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (width <= 0 || height <= 0) return;
  try {
    rfb.requestResize(width, height);
  } catch (e) {}
}

const VNCViewer = forwardRef<VNCViewerRef, VNCViewerProps>(
  function VNCViewer(
    { sessionId, sshConnectionId, vncPort, vncPassword, isActive, isCompact = false },
    ref
  ) {
    const { t } = useI18n();
    const containerRef = useRef<HTMLDivElement>(null);
    const rfbRef = useRef<InstanceType<RFBClass> | null>(null);
    const mountedRef = useRef(true);
    const wasConnectedRef = useRef(false);
    const suppressReconnectRef = useRef(false);
    const connectGenRef = useRef(0);
    const layoutAttemptRef = useRef(0);
    const [status, setStatus] = useState<VncStatus>("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const getVncUrl = useCallback(() => {
      const baseUrl = getVncWsBaseUrl();
      const params = new URLSearchParams();
      params.set("connection_id", sshConnectionId);
      params.set("port", String(vncPort));
      const accessKey = getAccessKey();
      if (accessKey) {
        params.set("key", accessKey);
      }
      return `${baseUrl}/${sessionId}?${params}`;
    }, [sessionId, sshConnectionId, vncPort]);

    const reportError = useCallback((message: string) => {
      suppressReconnectRef.current = true;
      setErrorMessage(message);
      setStatus("error");
    }, []);

    const disconnect = useCallback(() => {
      connectGenRef.current += 1;
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch (e) {}
        rfbRef.current = null;
      }
      wasConnectedRef.current = false;
    }, []);

    const connect = useCallback(async () => {
      const container = containerRef.current;
      if (!container || !isActive || !mountedRef.current) return;
      if (rfbRef.current) return;

      const connectGen = ++connectGenRef.current;
      suppressReconnectRef.current = false;
      wasConnectedRef.current = false;
      setErrorMessage(null);
      setStatus("connecting");

      const sized = await waitForContainerSize(container);
      if (
        !mountedRef.current ||
        !isActive ||
        connectGen !== connectGenRef.current ||
        rfbRef.current
      ) {
        return;
      }

      if (!sized) {
        layoutAttemptRef.current += 1;
        if (layoutAttemptRef.current >= 40) {
          layoutAttemptRef.current = 0;
          reportError(t("vnc.layoutNotReady"));
          return;
        }
        window.setTimeout(() => {
          if (
            mountedRef.current &&
            isActive &&
            connectGen === connectGenRef.current &&
            !rfbRef.current
          ) {
            connect();
          }
        }, 150);
        return;
      }
      layoutAttemptRef.current = 0;

      const url = getVncUrl();

      try {
        const { default: RFB } = await loadRFB();
        if (
          !mountedRef.current ||
          !containerRef.current ||
          rfbRef.current ||
          connectGen !== connectGenRef.current
        ) {
          return;
        }

        const rfb = new RFB(containerRef.current, url, {
          shared: true,
          credentials: vncPassword ? { password: vncPassword } : undefined,
        });

        rfb.scaleViewport = true;
        rfb.clipViewport = isCompact;
        rfb.focusOnClick = true;
        rfb.viewOnly = false;

        rfb.addEventListener("connect", () => {
          wasConnectedRef.current = true;
          setStatus("connected");
          setErrorMessage(null);
          applyRfbResize(rfb, container);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (containerRef.current && rfbRef.current === rfb) {
                applyRfbResize(rfb, containerRef.current);
              }
            });
          });
        });

        rfb.addEventListener("desktopresize", () => {
          if (containerRef.current && rfbRef.current === rfb) {
            applyRfbResize(rfb, containerRef.current);
          }
        });

        rfb.addEventListener("securityfailure", (event) => {
          const detail = (event as CustomEvent<RFBEventDetail>).detail;
          reportError(detail?.reason || t("vnc.authFailed"));
        });

        rfb.addEventListener("credentialsrequired", (event) => {
          const detail = (event as CustomEvent<RFBEventDetail>).detail;
          if (vncPassword && detail?.types?.includes("password")) {
            try {
              rfb.sendCredentials({ password: vncPassword });
            } catch (e) {
              reportError(t("vnc.authFailed"));
            }
            return;
          }
          reportError(t("vnc.passwordRequired"));
          try {
            rfb.disconnect();
          } catch (e) {}
        });

        rfb.addEventListener("disconnect", (event) => {
          rfbRef.current = null;
          if (!mountedRef.current || !isActive || suppressReconnectRef.current) {
            return;
          }

          const detail = (event as CustomEvent<RFBEventDetail>).detail;
          if (wasConnectedRef.current && detail?.clean === false) {
            setStatus("connecting");
            setErrorMessage(null);
            window.setTimeout(() => {
              if (mountedRef.current && isActive && !suppressReconnectRef.current) {
                connect();
              }
            }, 3000);
            return;
          }

          if (!wasConnectedRef.current) {
            reportError(detail?.reason || t("vnc.connectionFailed"));
          } else {
            setStatus("error");
            setErrorMessage(t("vnc.disconnected"));
          }
        });

        rfbRef.current = rfb;
        applyRfbResize(rfb, container);
      } catch (err) {
        console.error("[VNC] Connection failed:", err);
        reportError(t("vnc.connectionFailed"));
      }
    }, [getVncUrl, isActive, vncPassword, isCompact, reportError, t]);

    const reconnect = useCallback(() => {
      disconnect();
      suppressReconnectRef.current = false;
      setStatus("idle");
      setErrorMessage(null);
      connect();
    }, [disconnect, connect]);

    useImperativeHandle(ref, () => ({ disconnect, reconnect }), [disconnect, reconnect]);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
      };
    }, []);

    useEffect(() => {
      if (isActive) {
        connect();
      } else {
        disconnect();
        setStatus("idle");
        setErrorMessage(null);
      }
      return () => {
        disconnect();
      };
    }, [isActive, connect, disconnect]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container || !isActive) return;

      const ro = new ResizeObserver(() => {
        if (rfbRef.current) {
          applyRfbResize(rfbRef.current, container);
        }
      });
      ro.observe(container);
      return () => ro.disconnect();
    }, [isActive]);

    const showOverlay = status === "connecting" || status === "error";

    return (
      <div
        ref={containerRef}
        className={`vnc-container${isCompact ? " vnc-container-mobile" : ""}`}
      >
        {showOverlay && (
          <div className={`vnc-overlay${status === "error" ? " vnc-overlay-error" : ""}`}>
            {status === "connecting" && <p className="vnc-overlay-text">{t("vnc.connecting")}</p>}
            {status === "error" && errorMessage && (
              <>
                <p className="vnc-overlay-text">{errorMessage}</p>
                <button type="button" className="vnc-reconnect-btn" onClick={reconnect}>
                  {t("vnc.reconnect")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }
);

export default VNCViewer;
