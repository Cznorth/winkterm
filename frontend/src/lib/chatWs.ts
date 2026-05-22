"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getWsBaseUrl } from "./config";

// 获取 chat WebSocket URL（基于 terminal WS URL 替换路径）
const getChatWSUrl = () => getWsBaseUrl().replace("/terminal", "/chat");
const WS_URL = typeof window !== "undefined" ? getChatWSUrl() : "";

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: "running" | "done";
  result?: string;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool"; toolCall: ToolCall };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  contentBlocks?: ContentBlock[];
  thinking?: string;  // AI 思考过程
}

export type ChatMode = "chat" | "craft";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  inputTokens: number;
  outputTokens: number;
}

export interface ChatState {
  conversations: Conversation[];
  activeConvId: string;
  messages: ChatMessage[];      // derived: active conversation messages
  isStreaming: boolean;
  isConnected: boolean;
  error: string | null;
  mode: ChatMode;
  model: string;
  inputTokens: number;          // derived: active conversation tokens
  outputTokens: number;         // derived: active conversation tokens
  maxContext: number;
}

function makeConversation(id?: string): Conversation {
  return {
    id: id || Date.now().toString(),
    title: "",
    messages: [],
    inputTokens: 0,
    outputTokens: 0,
  };
}

// Helper: update active conversation and sync derived fields
function updateActiveConv(s: ChatState, updater: (conv: Conversation) => Conversation): ChatState {
  const conversations = s.conversations.map((c) =>
    c.id === s.activeConvId ? updater(c) : c
  );
  const activeConv = conversations.find((c) => c.id === s.activeConvId)!;
  return {
    ...s,
    conversations,
    messages: activeConv.messages,
    inputTokens: activeConv.inputTokens,
    outputTokens: activeConv.outputTokens,
  };
}

const initialConv = makeConversation("1");

export function useChatWs() {
  const [state, setState] = useState<ChatState>({
    conversations: [initialConv],
    activeConvId: initialConv.id,
    messages: [],
    isStreaming: false,
    isConnected: false,
    error: null,
    mode: "craft",
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    maxContext: 200000,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const currentMessageRef = useRef<string>("");
  const currentThinkingRef = useRef<string>("");
  const toolCallsRef = useRef<ToolCall[]>([]);
  const currentBlocksRef = useRef<ContentBlock[]>([]);
  const currentSegmentRef = useRef<string>("");

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
      const lang = localStorage.getItem("winkterm-language");
      setState((s) => ({ ...s, error: lang === "zh" ? "连接失败" : "Connection failed" }));
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
  const handleMessage = useCallback((data: {
    type: string;
    content?: string;
    message?: string;
    mode?: string;
    model?: string;
    tool?: string;
    args?: Record<string, unknown>;
    result?: string;
    input_tokens?: number;
    output_tokens?: number;
    max_context?: number;
  }) => {
    switch (data.type) {
      case "start":
        currentMessageRef.current = "";
        currentThinkingRef.current = "";
        toolCallsRef.current = [];
        currentBlocksRef.current = [];
        currentSegmentRef.current = "";
        setState((s) => ({ ...s, isStreaming: true }));
        break;

      case "thinking":
        if (data.content) {
          currentThinkingRef.current += data.content;
          setState((s) =>
            updateActiveConv(s, (conv) => {
              const messages = [...conv.messages];
              const lastMsg = messages[messages.length - 1];
              if (lastMsg?.role === "assistant") {
                messages[messages.length - 1] = {
                  ...lastMsg,
                  content: currentMessageRef.current,
                  thinking: currentThinkingRef.current,
                  toolCalls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
                };
              } else {
                messages.push({
                  id: Date.now().toString(),
                  role: "assistant",
                  content: currentMessageRef.current,
                  thinking: currentThinkingRef.current,
                  timestamp: Date.now(),
                  toolCalls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
                });
              }
              return { ...conv, messages };
            })
          );
        }
        break;

      case "token":
        if (data.content) {
          currentMessageRef.current += data.content;
          currentSegmentRef.current += data.content;
          const tokenBlocks: ContentBlock[] = [
            ...currentBlocksRef.current,
            { type: "text", text: currentSegmentRef.current },
          ];
          setState((s) =>
            updateActiveConv(s, (conv) => {
              const messages = [...conv.messages];
              const lastMsg = messages[messages.length - 1];
              if (lastMsg?.role === "assistant") {
                messages[messages.length - 1] = {
                  ...lastMsg,
                  content: currentMessageRef.current,
                  thinking: currentThinkingRef.current || undefined,
                  contentBlocks: tokenBlocks,
                  toolCalls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
                };
              } else {
                messages.push({
                  id: Date.now().toString(),
                  role: "assistant",
                  content: currentMessageRef.current,
                  thinking: currentThinkingRef.current || undefined,
                  timestamp: Date.now(),
                  contentBlocks: tokenBlocks,
                  toolCalls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
                });
              }
              return { ...conv, messages };
            })
          );
        }
        break;

      case "tool_start":
        if (data.tool) {
          // Finalize current text segment before tool
          if (currentSegmentRef.current) {
            currentBlocksRef.current = [
              ...currentBlocksRef.current,
              { type: "text", text: currentSegmentRef.current },
            ];
            currentSegmentRef.current = "";
          }
          const newToolCall: ToolCall = {
            id: `${Date.now()}-${data.tool}`,
            tool: data.tool,
            args: data.args || {},
            status: "running",
          };
          toolCallsRef.current = [...toolCallsRef.current, newToolCall];
          currentBlocksRef.current = [
            ...currentBlocksRef.current,
            { type: "tool", toolCall: newToolCall },
          ];
          const toolStartBlocks: ContentBlock[] = [...currentBlocksRef.current];
          setState((s) =>
            updateActiveConv(s, (conv) => {
              const messages = [...conv.messages];
              const lastMsg = messages[messages.length - 1];
              if (lastMsg?.role === "assistant") {
                messages[messages.length - 1] = {
                  ...lastMsg,
                  content: currentMessageRef.current,
                  contentBlocks: toolStartBlocks,
                  toolCalls: [...toolCallsRef.current],
                };
              }
              return { ...conv, messages };
            })
          );
        }
        break;

      case "tool_end":
        if (data.tool) {
          toolCallsRef.current = toolCallsRef.current.map((tc) =>
            tc.tool === data.tool
              ? { ...tc, status: "done" as const, result: data.result }
              : tc
          );
          let toolEndUpdated = false;
          currentBlocksRef.current = currentBlocksRef.current.map((block) => {
            if (!toolEndUpdated && block.type === "tool" && block.toolCall.tool === data.tool && block.toolCall.status === "running") {
              toolEndUpdated = true;
              return { type: "tool" as const, toolCall: { ...block.toolCall, status: "done" as const, result: data.result } };
            }
            return block;
          });
          const toolEndBlocks: ContentBlock[] = [...currentBlocksRef.current];
          setState((s) =>
            updateActiveConv(s, (conv) => {
              const messages = [...conv.messages];
              const lastMsg = messages[messages.length - 1];
              if (lastMsg?.role === "assistant") {
                messages[messages.length - 1] = {
                  ...lastMsg,
                  contentBlocks: toolEndBlocks,
                  toolCalls: [...toolCallsRef.current],
                };
              }
              return { ...conv, messages };
            })
          );
        }
        break;

      case "end":
        setState((s) => {
          const updated = updateActiveConv(s, (conv) => {
            const messages = [...conv.messages];
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === "assistant" && data.content) {
              messages[messages.length - 1] = { ...lastMsg, content: data.content };
            }
            return { ...conv, messages };
          });
          return { ...updated, isStreaming: false };
        });
        break;

      case "error":
        setState((s) => ({ ...s, error: data.message || "未知错误", isStreaming: false }));
        break;

      case "stopped":
        setState((s) => ({ ...s, isStreaming: false }));
        break;

      case "mode_changed":
        if (data.mode === "chat" || data.mode === "craft") {
          setState((s) => ({ ...s, mode: data.mode as ChatMode }));
        }
        break;

      case "model_changed":
        if (data.model) {
          setState((s) => ({ ...s, model: data.model as string }));
        }
        break;

      case "usage":
        if (typeof data.input_tokens === "number" && typeof data.output_tokens === "number") {
          setState((s) => {
            const updated = updateActiveConv(s, (conv) => ({
              ...conv,
              inputTokens: data.input_tokens as number,
              outputTokens: data.output_tokens as number,
            }));
            return {
              ...updated,
              maxContext: (data.max_context as number) || s.maxContext,
            };
          });
        }
        break;
    }
  }, []);

  // 发送消息
  const sendMessage = useCallback((content: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: "未连接" }));
      return;
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content,
      timestamp: Date.now(),
    };

    setState((s) =>
      updateActiveConv(s, (conv) => ({
        ...conv,
        messages: [...conv.messages, userMsg],
      }))
    );
    setState((s) => ({ ...s, error: null }));

    wsRef.current.send(JSON.stringify({ type: "chat", content }));
  }, []);

  // 清空当前对话消息
  const clearMessages = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "clear" }));
    }
    setState((s) =>
      updateActiveConv(s, (conv) => ({
        ...conv,
        messages: [],
        inputTokens: 0,
        outputTokens: 0,
        title: "",
      }))
    );
  }, []);

  // 新建对话
  const newConversation = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "clear" }));
    }
    const conv = makeConversation();
    setState((s) => ({
      ...s,
      conversations: [...s.conversations, conv],
      activeConvId: conv.id,
      messages: [],
      inputTokens: 0,
      outputTokens: 0,
      isStreaming: false,
      error: null,
    }));
  }, []);

  // 切换对话
  const switchConversation = useCallback((id: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "clear" }));
    }
    setState((s) => {
      const conv = s.conversations.find((c) => c.id === id);
      if (!conv || conv.id === s.activeConvId) return s;
      return {
        ...s,
        activeConvId: id,
        messages: conv.messages,
        inputTokens: conv.inputTokens,
        outputTokens: conv.outputTokens,
        isStreaming: false,
        error: null,
      };
    });
  }, []);

  // 删除对话
  const deleteConversation = useCallback((id: string) => {
    setState((s) => {
      if (s.conversations.length <= 1) return s;
      const conversations = s.conversations.filter((c) => c.id !== id);
      let activeConvId = s.activeConvId;
      if (activeConvId === id) {
        // Switch to the previous conversation
        const deletedIndex = s.conversations.findIndex((c) => c.id === id);
        const newIndex = Math.max(0, deletedIndex - 1);
        activeConvId = conversations[newIndex].id;
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "clear" }));
        }
      }
      const activeConv = conversations.find((c) => c.id === activeConvId)!;
      return {
        ...s,
        conversations,
        activeConvId,
        messages: activeConv.messages,
        inputTokens: activeConv.inputTokens,
        outputTokens: activeConv.outputTokens,
        isStreaming: s.activeConvId === id ? false : s.isStreaming,
      };
    });
  }, []);

  // 切换模式
  const switchMode = useCallback((mode: ChatMode) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: "未连接" }));
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "switch_mode", mode }));
  }, []);

  // 切换模型
  const switchModel = useCallback((model: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: "未连接" }));
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "switch_model", model }));
    setState((s) => ({ ...s, model }));
  }, []);

  // 更新对话标题
  const updateConvTitle = useCallback((id: string, title: string) => {
    console.log("[chatWs] updateConvTitle", id, title);
    setState((s) => {
      console.log("[chatWs] updateConvTitle setState, convs:", s.conversations.map(c => c.id), "target:", id);
      const conversations = s.conversations.map((c) =>
        c.id === id ? { ...c, title } : c
      );
      const activeConv = conversations.find((c) => c.id === s.activeConvId)!;
      return {
        ...s,
        conversations,
        messages: activeConv.messages,
        inputTokens: activeConv.inputTokens,
        outputTokens: activeConv.outputTokens,
      };
    });
  }, []);

  // 停止生成
  const stopGeneration = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
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
    stopGeneration,
    clearMessages,
    newConversation,
    switchConversation,
    deleteConversation,
    updateConvTitle,
    switchMode,
    switchModel,
    reconnect: connect,
  };
}
