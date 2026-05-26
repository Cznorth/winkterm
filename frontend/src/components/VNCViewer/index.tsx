"use client";

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { getVncWsBaseUrl } from "@/lib/config";
import { getAccessKey } from "@/lib/auth";
import { useBreakpoint } from "@/hooks/useBreakpoint";
import "./VNCViewer.css";

interface VNCViewerProps {
  sessionId: string;
  sshConnectionId: string;
  vncPort: number;
  vncPassword?: string;
  isActive: boolean;
}

export interface VNCViewerRef {
  disconnect: () => void;
  reconnect: () => void;
}

type RFBClass = typeof import("@novnc/novnc").default;

let rfbModulePromise: Promise<{ default: RFBClass }> | null = null;

function loadRFB(): Promise<{ default: RFBClass }> {
  if (!rfbModulePromise) {
    rfbModulePromise = import("@novnc/novnc");
  }
  return rfbModulePromise;
}

const VNCViewer = forwardRef<VNCViewerRef, VNCViewerProps>(
  function VNCViewer({ sessionId, sshConnectionId, vncPort, vncPassword, isActive }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const rfbRef = useRef<InstanceType<RFBClass> | null>(null);
    const mountedRef = useRef(true);
    const breakpoint = useBreakpoint();
    const isMobile = breakpoint !== "desktop";

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

    const connect = useCallback(() => {
      if (!containerRef.current || !isActive || !mountedRef.current) return;
      if (rfbRef.current) return;

      const url = getVncUrl();

      loadRFB().then(({ default: RFB }) => {
        if (!mountedRef.current || !containerRef.current || rfbRef.current) return;

        try {
          const rfb = new RFB(containerRef.current, url, {
            shared: true,
            credentials: vncPassword ? { password: vncPassword } : undefined,
          });

          rfb.scaleViewport = true;
          rfb.clipViewport = isMobile;
          rfb.focusOnClick = true;
          rfb.viewOnly = false;

          rfb.addEventListener("disconnect", () => {
            rfbRef.current = null;
            if (mountedRef.current && isActive) {
              setTimeout(() => connect(), 3000);
            }
          });

          rfbRef.current = rfb;
        } catch (err) {
          console.error("[VNC] Connection failed:", err);
          if (mountedRef.current && isActive) {
            setTimeout(() => connect(), 3000);
          }
        }
      }).catch((err) => {
        console.error("[VNC] Failed to load noVNC:", err);
      });
    }, [getVncUrl, isActive, vncPassword, isMobile]);

    const disconnect = useCallback(() => {
      if (rfbRef.current) {
        try {
          rfbRef.current.disconnect();
        } catch (e) {}
        rfbRef.current = null;
      }
    }, []);

    const reconnect = useCallback(() => {
      disconnect();
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
          try {
            rfbRef.current.requestResize(container.clientWidth, container.clientHeight);
          } catch (e) {}
        }
      });
      ro.observe(container);
      return () => ro.disconnect();
    }, [isActive]);

    return <div ref={containerRef} className={`vnc-container${isMobile ? " vnc-container-mobile" : ""}`} />;
  }
);

export default VNCViewer;
