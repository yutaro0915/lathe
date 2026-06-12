"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { parseStamp } from "@lathe/shared";
import { RUNNER_LABEL } from "@/lib/runner-display";
import type { ChatMessage, ChatThread, Finding, Session } from "@/lib/types";
import type { ChatProviderName } from "@/lib/chat-agent";

type StreamFrame =
  | { type: "thread"; thread: ChatThread }
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string }
  | { type: "tool_result"; name: string }
  | { type: "error"; error: string }
  | { type: "done" };

function providerLabel(provider: ChatProviderName): string {
  if (provider === "fake") return "fake";
  if (provider === "codex") return "codex exec";
  return "claude -p";
}

function titleForThread(thread: ChatThread): string {
  return thread.title.trim() || "New thread";
}

function threadHref(thread: ChatThread): string {
  return `/chat?thread=${encodeURIComponent(thread.id)}`;
}

function readFrame(line: string): StreamFrame | null {
  if (!line.trim()) return null;
  return JSON.parse(line) as StreamFrame;
}

export default function ChatView({
  threads,
  selectedThread,
  messages: initialMessages,
  sessions,
  findings,
  attachedSessionId,
  attachedFindingId,
  defaultProvider,
}: {
  threads: ChatThread[];
  selectedThread: ChatThread | null;
  messages: ChatMessage[];
  sessions: Session[];
  findings: Finding[];
  attachedSessionId: string | null;
  attachedFindingId: number | null;
  defaultProvider: ChatProviderName;
}) {
  const router = useRouter();
  const [localThreads, setLocalThreads] = useState(threads);
  const [thread, setThread] = useState<ChatThread | null>(selectedThread);
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [provider, setProvider] = useState<ChatProviderName>(defaultProvider);
  const [streamingText, setStreamingText] = useState("");
  const [toolTrace, setToolTrace] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attachedSession = useMemo(
    () => sessions.find((session) => session.id === (thread?.sessionId ?? attachedSessionId)) ?? null,
    [attachedSessionId, sessions, thread?.sessionId],
  );
  const attachedFinding = useMemo(
    () => findings.find((finding) => finding.id === (thread?.findingId ?? attachedFindingId)) ?? null,
    [attachedFindingId, findings, thread?.findingId],
  );

  async function createThread() {
    setError(null);
    const response = await fetch("/api/chat/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "New thread",
        sessionId: attachedSessionId,
        findingId: attachedFindingId,
      }),
    });
    const payload = (await response.json()) as { ok?: boolean; thread?: ChatThread; error?: string };
    if (!response.ok || !payload.ok || !payload.thread) {
      setError(payload.error ?? "thread create failed");
      return;
    }
    setThread(payload.thread);
    setMessages([]);
    setLocalThreads((prev) => [payload.thread!, ...prev.filter((item) => item.id !== payload.thread!.id)]);
    router.push(threadHref(payload.thread));
  }

  async function sendMessage() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    setStreamingText("");
    setToolTrace([]);
    setDraft("");
    try {
      const response = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: thread?.id,
          message: body,
          sessionId: thread?.sessionId ?? attachedSessionId,
          findingId: thread?.findingId ?? attachedFindingId,
          provider,
        }),
      });
      if (!response.body) throw new Error("chat stream missing");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const frame = readFrame(line);
          if (!frame) continue;
          if (frame.type === "thread") {
            setThread(frame.thread);
            setLocalThreads((prev) => [frame.thread, ...prev.filter((item) => item.id !== frame.thread.id)]);
            router.replace(threadHref(frame.thread));
          } else if (frame.type === "message") {
            setMessages((prev) => [...prev.filter((item) => item.id !== frame.message.id), frame.message]);
            if (frame.message.role === "assistant") setStreamingText("");
          } else if (frame.type === "delta") {
            setStreamingText((prev) => prev + frame.text);
          } else if (frame.type === "tool_call") {
            setToolTrace((prev) => [...prev, `call ${frame.name}`]);
          } else if (frame.type === "tool_result") {
            setToolTrace((prev) => [...prev, `result ${frame.name}`]);
          } else if (frame.type === "error") {
            throw new Error(frame.error);
          }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submitOnEnter(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }

  return (
    <>
      <div className="tabs">
        <Link href="/" className="tab">
          Sessions
        </Link>
        <Link href="/overview" className="tab">
          Overview
        </Link>
        <Link href="/pr" className="tab">
          PR
        </Link>
        <Link href="/chat" className="tab active">
          Chat
        </Link>
        <span className="tabs-spacer" />
        <span className="tabs-tool">
          <span className="sort-select">{providerLabel(provider)}</span>
        </span>
      </div>

      <div className="chat-shell">
        <aside className="chat-sidebar">
          <div className="chat-sidebar-head">
            <div>
              <div className="panel-title" style={{ margin: 0 }}>
                Threads
              </div>
              <div className="muted small">{localThreads.length} total</div>
            </div>
            <button type="button" className="btn btn-sm btn-primary" onClick={createThread}>
              New
            </button>
          </div>

          <div className="chat-thread-list">
            {localThreads.map((item) => {
              const active = item.id === thread?.id;
              return (
                <Link
                  key={item.id}
                  href={threadHref(item)}
                  className={`chat-thread-item${active ? " active" : ""}`}
                >
                  <div className="chat-thread-title">{titleForThread(item)}</div>
                  <div className="chat-thread-meta">
                    <span className="mono">{parseStamp(item.updatedAt).date}</span>
                    <span>{item.messageCount} msg</span>
                    {item.sessionId && <span>session</span>}
                    {item.findingId && <span>finding</span>}
                  </div>
                </Link>
              );
            })}
            {localThreads.length === 0 && <div className="empty">No threads.</div>}
          </div>
        </aside>

        <main className="chat-main">
          <div className="chat-head">
            <div className="chat-title-block">
              <h1>{thread ? titleForThread(thread) : "New thread"}</h1>
              <div className="chat-context-row">
                {attachedSession ? (
                  <Link href={`/?session=${encodeURIComponent(attachedSession.id)}`} className="chat-attach-chip">
                    <span className={`runner-dot ${attachedSession.runner}`} />
                    {RUNNER_LABEL[attachedSession.runner]} · {attachedSession.title}
                  </Link>
                ) : attachedSessionId ? (
                  <span className="chat-attach-chip stale">session {attachedSessionId}</span>
                ) : null}
                {attachedFinding ? (
                  <Link
                    href={`/?tab=findings&findingSession=${encodeURIComponent(attachedFinding.evidence[0]?.sessionId ?? "")}`}
                    className="chat-attach-chip"
                  >
                    finding #{attachedFinding.id} · {attachedFinding.kind}
                  </Link>
                ) : attachedFindingId ? (
                  <span className="chat-attach-chip stale">finding #{attachedFindingId}</span>
                ) : null}
              </div>
            </div>
            <select
              className="chat-provider-select"
              value={provider}
              onChange={(event) => setProvider(event.target.value as ChatProviderName)}
              title="Provider"
            >
              <option value="claude">claude -p</option>
              <option value="codex">codex exec</option>
              <option value="fake">fake</option>
            </select>
          </div>

          <div className="chat-messages">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`chat-message ${message.role}`}
                data-message-id={message.id}
                data-role={message.role}
              >
                <div className="chat-message-role">{message.role}</div>
                <div className="chat-message-body">{message.body}</div>
              </div>
            ))}
            {streamingText && (
              <div className="chat-message assistant streaming" data-role="assistant">
                <div className="chat-message-role">assistant</div>
                <div className="chat-message-body">{streamingText}</div>
              </div>
            )}
            {messages.length === 0 && !streamingText && (
              <div className="chat-empty">
                <span className="mono">lathe MCP</span>
                <span>{providerLabel(provider)}</span>
              </div>
            )}
          </div>

          {toolTrace.length > 0 && (
            <div className="chat-tool-trace">
              {toolTrace.map((item, index) => (
                <span key={`${item}:${index}`} className="mono">
                  {item}
                </span>
              ))}
            </div>
          )}
          {error && <div className="chat-error">{error}</div>}

          <div className="chat-compose">
            <textarea
              className="chat-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={submitOnEnter}
              rows={3}
              placeholder="Message"
              disabled={busy}
            />
            <button
              type="button"
              className="btn btn-primary chat-send"
              onClick={sendMessage}
              disabled={busy || !draft.trim()}
            >
              Send
            </button>
          </div>
        </main>
      </div>
    </>
  );
}
