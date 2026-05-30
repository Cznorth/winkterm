"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getWsBaseUrl } from "./config";
import { getAccessKey } from "./auth";
import axios from "./axios";

// Get chat WebSocket URL (replace path segment in terminal WS URL)
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
  thinking?: string;  // AI reasoning trace
}

export type ChatMode = "chat" | "craft" | "ask";

export interface ToolApproval {
  approvalId: string;
  tool: string;
  args: Record<string, unknown>;
}

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
  messageQueue: string[];       // pending messages queued during streaming
  pendingApproval: ToolApproval | null;  // ask mode: tool call awaiting user approval
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

// Helper: update a specific conversation by id and sync derived fields
function updateConv(s: ChatState, convId: string, updater: (conv: Conversation) => Conversation): ChatState {
  const conversations = s.conversations.map((c) =>
    c.id === convId ? updater(c) : c
  );
  const activeConv = conversations.find((c) => c.id === s.activeConvId);
  if (!activeConv) return { ...s, conversations };
  return {
    ...s,
    conversations,
    messages: activeConv.messages,
    inputTokens: activeConv.inputTokens,
    outputTokens: activeConv.outputTokens,
  };
}

// Helper: update active conversation and sync derived fields
function updateActiveConv(s: ChatState, updater: (conv: Conversation) => Conversation): ChatState {
  return updateConv(s, s.activeConvId, updater);
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
    messageQueue: [],
    pendingApproval: null,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const currentMessageRef = useRef<string>("");
  const currentThinkingRef = useRef<string>("");
  const toolCallsRef = useRef<ToolCall[]>([]);
  const currentBlocksRef = useRef<ContentBlock[]>([]);
  const currentSegmentRef = useRef<string>("");
  const isStreamingRef = useRef(false);
  const messageQueueRef = useRef<string[]>([]);
  const activeConvIdRef = useRef<string>(initialConv.id);
  const streamingConvIdRef = useRef<string>("");

  // Connect WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const accessKey = getAccessKey();
    const wsUrl = accessKey ? `${WS_URL}?key=${encodeURIComponent(accessKey)}` : WS_URL;
    const ws = new WebSocket(wsUrl);

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

  // Handle incoming messages
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
    conv_id?: string;
    approval_id?: string;
  }) => {
    switch (data.type) {
      case "start":
        currentMessageRef.current = "";
        currentThinkingRef.current = "";
        toolCallsRef.current = [];
        currentBlocksRef.current = [];
        currentSegmentRef.current = "";
        isStreamingRef.current = true;
        // Resume: this WS never sent chat but server pushes start (in-flight stream takeover).
        // Use conv_id from start so subsequent tokens land on the correct conversation.
        if (data.conv_id) {
          streamingConvIdRef.current = data.conv_id;
        }
        setState((s) => ({ ...s, isStreaming: true }));
        break;

      case "thinking":
        if (data.content) {
          currentThinkingRef.current += data.content;
          setState((s) =>
            updateConv(s, streamingConvIdRef.current, (conv) => {
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
            updateConv(s, streamingConvIdRef.current, (conv) => {
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
            id: `${Date.now()}-${data.tool}-${Math.random().toString(36).slice(2, 10)}`,
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
            updateConv(s, streamingConvIdRef.current, (conv) => {
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
            updateConv(s, streamingConvIdRef.current, (conv) => {
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

      case "tool_approval":
        // ask mode: backend paused before executing a tool, waiting for the user
        if (data.approval_id && data.tool) {
          const approval: ToolApproval = {
            approvalId: data.approval_id,
            tool: data.tool,
            args: data.args || {},
          };
          setState((s) => ({ ...s, pendingApproval: approval }));
        }
        break;

      case "end":
        isStreamingRef.current = false;
        setState((s) => {
          const updated = updateConv(s, streamingConvIdRef.current, (conv) => {
            const messages = [...conv.messages];
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === "assistant" && data.content) {
              messages[messages.length - 1] = { ...lastMsg, content: data.content };
            }
            return { ...conv, messages };
          });
          return { ...updated, isStreaming: false, pendingApproval: null };
        });
        break;

      case "error":
        isStreamingRef.current = false;
        setState((s) => ({ ...s, error: data.message || "Unknown error", isStreaming: false, pendingApproval: null }));
        break;

      case "stopped":
        isStreamingRef.current = false;
        setState((s) => ({ ...s, isStreaming: false, pendingApproval: null }));
        break;

      case "mode_changed":
        if (data.mode === "chat" || data.mode === "craft" || data.mode === "ask") {
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
          const targetId = data.conv_id || streamingConvIdRef.current;
          setState((s) => {
            const updated = targetId
              ? updateConv(s, targetId, (conv) => ({
                  ...conv,
                  inputTokens: data.input_tokens as number,
                  outputTokens: data.output_tokens as number,
                }))
              : s;
            return {
              ...updated,
              maxContext: (data.max_context as number) || s.maxContext,
            };
          });
        }
        break;
    }
  }, []);

  // Send immediately (does not check streaming state)
  const rawSend = useCallback((content: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // Bind this stream to the initiating conversation to avoid cross-talk after new/switch
    streamingConvIdRef.current = activeConvIdRef.current;

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

    wsRef.current.send(JSON.stringify({ type: "chat", content, conv_id: activeConvIdRef.current }));
  }, []);

  // Send message: queue if streaming, otherwise send directly
  const sendMessage = useCallback((content: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: "未连接" }));
      return;
    }

    if (isStreamingRef.current) {
      const next = [...messageQueueRef.current, content];
      messageQueueRef.current = next;
      setState((s) => ({ ...s, messageQueue: next }));
      return;
    }

    rawSend(content);
  }, [rawSend]);

  // Auto-send first queued message when streaming ends
  useEffect(() => {
    if (!state.isStreaming && messageQueueRef.current.length > 0) {
      const [next, ...rest] = messageQueueRef.current;
      messageQueueRef.current = rest;
      setState((s) => ({ ...s, messageQueue: rest }));
      rawSend(next);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isStreaming]);

  // Interrupt generation and send the given message (it takes priority over other queued items)
  const interruptAndSend = useCallback((content: string) => {
    messageQueueRef.current = [content];
    setState((s) => ({ ...s, messageQueue: [content] }));
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
  }, []);

  // Remove message at the given queue index
  const removeFromQueue = useCallback((index: number) => {
    const next = messageQueueRef.current.filter((_, i) => i !== index);
    messageQueueRef.current = next;
    setState((s) => ({ ...s, messageQueue: next }));
  }, []);

  // Create a new conversation
  const newConversation = useCallback(() => {
    messageQueueRef.current = [];
    isStreamingRef.current = false;
    const conv = makeConversation();
    setState((s) => ({
      ...s,
      conversations: [...s.conversations, conv],
      activeConvId: conv.id,
      messages: [],
      inputTokens: 0,
      outputTokens: 0,
      isStreaming: false,
      messageQueue: [],
      error: null,
    }));
  }, []);

  // Switch active conversation
  const switchConversation = useCallback((id: string) => {
    messageQueueRef.current = [];
    setState((s) => {
      const conv = s.conversations.find((c) => c.id === id);
      if (!conv || conv.id === s.activeConvId) return s;
      return {
        ...s,
        activeConvId: id,
        messages: conv.messages,
        inputTokens: conv.inputTokens,
        outputTokens: conv.outputTokens,
        messageQueue: [],
        error: null,
      };
    });
  }, []);

  // Delete conversation
  const deleteConversation = useCallback((id: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "delete_conv", conv_id: id }));
    }
    setState((s) => {
      if (s.conversations.length <= 1) return s;
      const conversations = s.conversations.filter((c) => c.id !== id);
      let activeConvId = s.activeConvId;
      if (activeConvId === id) {
        const deletedIndex = s.conversations.findIndex((c) => c.id === id);
        const newIndex = Math.max(0, deletedIndex - 1);
        activeConvId = conversations[newIndex].id;
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

  // Switch mode
  const switchMode = useCallback((mode: ChatMode) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: "未连接" }));
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "switch_mode", mode }));
  }, []);

  // Switch model
  const switchModel = useCallback((model: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setState((s) => ({ ...s, error: "未连接" }));
      return;
    }
    wsRef.current.send(JSON.stringify({ type: "switch_model", model }));
    setState((s) => ({ ...s, model }));
  }, []);

  // Update conversation title
  const updateConvTitle = useCallback((id: string, title: string) => {
    setState((s) => {
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
    // Persist to backend
    axios.post(`/api/chat/conversations/${encodeURIComponent(id)}/title`, { title })
      .catch(() => {});
  }, []);

  // Stop generation
  const stopGeneration = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "stop" }));
    }
  }, []);

  // ask mode: approve or deny the pending tool call
  const sendToolDecision = useCallback((approvalId: string, approved: boolean) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "tool_decision", approval_id: approvalId, approved }));
    }
    setState((s) => ({ ...s, pendingApproval: null }));
  }, []);

  // Sync active conversation id to ref
  useEffect(() => {
    activeConvIdRef.current = state.activeConvId;
  }, [state.activeConvId]);

  // Auto-connect on mount
  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  // On mount, load conversation history from backend chat_store (restore after page refresh)
  useEffect(() => {
    let cancelled = false;
    axios.get("/api/chat/conversations")
      .then((res) => {
        if (cancelled) return;
        const list = res.data?.conversations as Array<{
          id: string;
          title: string;
          messages: Array<{ role: "user" | "assistant"; content: string; thinking?: string; timestamp?: number }>;
          input_tokens: number;
          output_tokens: number;
        }> | undefined;
        if (!list || list.length === 0) return;
        const convs: Conversation[] = list.map((c) => ({
          id: c.id,
          title: c.title,
          messages: (c.messages || []).map((m, i) => ({
            id: `${c.id}-${i}`,
            role: m.role,
            content: m.content,
            thinking: m.thinking,
            timestamp: m.timestamp ? Math.round(m.timestamp * 1000) : Date.now(),
          })),
          inputTokens: c.input_tokens || 0,
          outputTokens: c.output_tokens || 0,
        }));
        setState((s) => {
          // Replace initial empty conversation with backend history; keep WS/connection state
          const activeConv = convs[0];
          activeConvIdRef.current = activeConv.id;
          return {
            ...s,
            conversations: convs,
            activeConvId: activeConv.id,
            messages: activeConv.messages,
            inputTokens: activeConv.inputTokens,
            outputTokens: activeConv.outputTokens,
          };
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    ...state,
    sendMessage,
    stopGeneration,
    sendToolDecision,
    interruptAndSend,
    removeFromQueue,
    newConversation,
    switchConversation,
    deleteConversation,
    updateConvTitle,
    switchMode,
    switchModel,
    reconnect: connect,
  };
}
