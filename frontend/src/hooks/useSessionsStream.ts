"use client";

import { useEffect, useRef } from "react";
import { getApiBaseUrl } from "@/lib/config";
import { getAccessKey } from "@/lib/auth";

export interface SessionInfo {
  id: string;
  type: "local" | "ssh";
  connection_id: string | null;
  title: string;
  name: string;
  host: string | null;
  port: number | null;
  username: string | null;
  user_visible: boolean;
  transient: boolean;
  created_by: string;
  is_user_active: boolean;
}

interface Options {
  onCreated: (s: SessionInfo) => void;
  onClosed: (sessionId: string) => void;
  onSnapshot?: (sessions: SessionInfo[]) => void;
}

/** SSE subscription to backend session lifecycle events with auto-reconnect. */
export function useSessionsStream({ onCreated, onClosed, onSnapshot }: Options): void {
  const handlersRef = useRef({ onCreated, onClosed, onSnapshot });
  handlersRef.current = { onCreated, onClosed, onSnapshot };

  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let reconnectTimer: number | null = null;

    const connect = () => {
      const base = getApiBaseUrl();
      const key = getAccessKey();
      const url = `${base}/api/sessions/stream${key ? `?key=${encodeURIComponent(key)}` : ""}`;
      try {
        es = new EventSource(url);
      } catch (e) {
        console.error("[sessions-stream] open failed:", e);
        scheduleReconnect();
        return;
      }

      es.addEventListener("snapshot", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { sessions: SessionInfo[] };
          handlersRef.current.onSnapshot?.(data.sessions || []);
        } catch (e) {
          console.error("[sessions-stream] snapshot parse:", e);
        }
      });

      es.addEventListener("session_created", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { session: SessionInfo };
          if (data.session) handlersRef.current.onCreated(data.session);
        } catch (e) {
          console.error("[sessions-stream] created parse:", e);
        }
      });

      es.addEventListener("session_closed", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { session_id: string };
          if (data.session_id) handlersRef.current.onClosed(data.session_id);
        } catch (e) {
          console.error("[sessions-stream] closed parse:", e);
        }
      });

      es.addEventListener("heartbeat", () => {});

      es.onerror = () => {
        if (es) {
          es.close();
          es = null;
        }
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      if (reconnectTimer) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es) {
        es.close();
        es = null;
      }
    };
  }, []);
}
