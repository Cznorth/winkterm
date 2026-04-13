"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const WS_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_WS_URL?.replace("/terminal", "/chat") ??
      "ws://localhost:8000/ws/chat")
    : "";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  isConnected: boolean;
  error: string | null;
}

export function useChatWs() {
  const [state, setState] = useState<ChatState>({
    messages: [],
    isStreaming: false,
    isConnected: false,
    error: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const currentMessageRef = useRef<string>("");

  // 连接 WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("[ChatWS] Connected");
      setState((s) => ({ ...s, isConnected: true, error: null }));
    };

    ws.onclose = () => {
      console.log("[ChatWS] Disconnected");
      setState((s) => ({ ...s, isConnected: false }));
    };

    ws.onerror = () => {
      console.error("[ChatWS] Error");
      setState((s) => ({ ...s, error: "连接失败" }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (e) {
        console.error("[ChatWS] Parse error:", e);
      }
    };

    wsRef.current = ws;
  }, []);

  // 处理消息
  const handleMessage = useCallback((data: { type: string; content?: string; message?: string }) => {
    switch (data.type) {
      case "start":
        currentMessageRef.current = "";
        setState((s) => ({ ...s, isStreaming: true }));
        break;

      case "token":
        if (data.content) {
          currentMessageRef.current += data.content;
          // 更新最后一条 assistant 消息
          setState((s) => {
            const messages = [...s.messages];
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === "assistant") {
              messages[messages.length - 1] = {
                ...lastMsg,
                content: currentMessageRef.current,
              };
            } else {
              messages.push({
                id: Date.now().toString(),
                role: "assistant",
                content: currentMessageRef.current,
                timestamp: Date.now(),
              });
            }
            return { ...s, messages };
          });
        }
        break;

      case "end":
        setState((s) => {
          const messages = [...s.messages];
          const lastMsg = messages[messages.length - 1];
          // 确保最终内容完整
          if (lastMsg?.role === "assistant" && data.content) {
            messages[messages.length - 1] = {
              ...lastMsg,
              content: data.content,
            };
          }
          return { ...s, messages, isStreaming: false };
        });
        break;

      case "error":
        setState((s) => ({ ...s, error: data.message || "未知错误", isStreaming: false }));
        break;
    }
  }, []);

  // 发送消息
  const sendMessage = useCallback((content: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: "未连接" }));
      return;
    }

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    setState((s) => ({
      ...s,
      messages: [...s.messages, userMsg],
      error: null,
    }));

    // 发送到服务器
    wsRef.current.send(JSON.stringify({ type: "chat", content }));
  }, []);

  // 清空消息
  const clearMessages = useCallback(() => {
    setState((s) => ({ ...s, messages: [] }));
  }, []);

  // 自动连接
  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  return {
    ...state,
    sendMessage,
    clearMessages,
    reconnect: connect,
  };
}
