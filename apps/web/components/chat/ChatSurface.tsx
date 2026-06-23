"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ds";
import { Icon } from "@/components/ds/icons";
import { Markdown } from "@/components/session-viewer/Markdown";
import Composer from "./Composer";
import type { ChatContextAttachment, ChatMessage, ChatThread } from "@/lib/chat";
import { t } from "@/lib/i18n";

interface ChatSurfaceProps {
  initialThreads: ChatThread[];
  selectedThread: ChatThread | null;
  initialMessages: ChatMessage[];
}

type StreamEvent = { event: string; data: unknown };
const STREAM_ID = "streaming-assistant";

function groupLabel(updatedAt: string, now: number | null): string {
  if (!now) return t("chat.thread.group.recent");
  const then = new Date(updatedAt).getTime();
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return t("chat.thread.group.today");
  if (days === 1) return t("chat.thread.group.yesterday");
  if (days < 7) return t("chat.thread.group.thisWeek");
  return t("chat.thread.group.earlier");
}

function relativeTime(updatedAt: string, now: number | null): string {
  if (!now) return "recently";
  const seconds = Math.max(0, Math.floor((now - new Date(updatedAt).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function parseSseEvent(raw: string): StreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (!data.length) return null;
  return { event, data: JSON.parse(data.join("\n")) };
}

async function consumeStream(response: Response, onEvent: (event: StreamEvent) => void) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("chat response did not include a stream");
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseSseEvent(raw);
      if (event) onEvent(event);
      index = buffer.indexOf("\n\n");
    }
  }
}

function toContextInput(context: ChatContextAttachment) {
  const id = context.kind === "session" ? context.id.replace(/^session:/, "")
    : context.kind === "finding" ? context.id.replace(/^finding:/, "")
      : context.id;
  return { kind: context.kind, id, label: context.label, value: context.value };
}

function threadTitle(thread: ChatThread): string {
  return thread.title === "New chat" ? t("chat.thread.defaultTitle") : thread.title;
}

export default function ChatSurface({ initialThreads, selectedThread, initialMessages }: ChatSurfaceProps) {
  const router = useRouter();
  const [threads, setThreads] = React.useState(initialThreads);
  const [messages, setMessages] = React.useState(initialMessages);
  const [contexts, setContexts] = React.useState<ChatContextAttachment[]>(selectedThread?.context ?? []);
  const [sending, setSending] = React.useState(false);
  const [now, setNow] = React.useState<number | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => setNow(Date.now()), []);
  React.useEffect(() => {
    setThreads(initialThreads);
    setMessages(initialMessages);
    setContexts(selectedThread?.context ?? []);
  }, [initialThreads, initialMessages, selectedThread]);
  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const groups = threads.reduce<Array<{ label: string; items: ChatThread[] }>>((acc, thread) => {
    const label = groupLabel(thread.updatedAt, now);
    const group = acc.find((item) => item.label === label);
    if (group) group.items.push(thread);
    else acc.push({ label, items: [thread] });
    return acc;
  }, []);

  const createThread = async () => {
    const response = await fetch("/api/chat/threads", { method: "POST" });
    const payload = await response.json() as { thread: ChatThread };
    setThreads((current) => [payload.thread, ...current]);
    router.push(`/chat?thread=${encodeURIComponent(payload.thread.id)}`);
  };

  const handleStreamEvent = (event: StreamEvent) => {
    const payload = event.data as Record<string, unknown>;
    if (event.event === "thread" && payload.thread) {
      const thread = payload.thread as ChatThread;
      setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
    }
    if (event.event === "user_message" && payload.message) {
      setMessages((current) => [...current, payload.message as ChatMessage]);
    }
    if (event.event === "assistant_delta") {
      const delta = String(payload.delta ?? "");
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last?.id === STREAM_ID) return [...current.slice(0, -1), { ...last, body: last.body + delta }];
        return [...current, {
          id: STREAM_ID,
          threadId: selectedThread?.id ?? "",
          role: "assistant",
          body: delta,
          seq: 999_999,
          meta: null,
          createdAt: new Date().toISOString(),
        }];
      });
    }
    if (event.event === "assistant_message" && payload.message) {
      const message = payload.message as ChatMessage;
      setMessages((current) => {
        const withoutStreaming = current.filter((item) => item.id !== STREAM_ID);
        return [...withoutStreaming, message];
      });
    }
    if (event.event === "error") {
      setMessages((current) => [...current, {
        id: `chat-error-${Date.now()}`,
        threadId: selectedThread?.id ?? "",
        role: "assistant",
        body: `${t("chat.error.agentFailedPrefix")}${String(payload.error ?? t("chat.error.unknown"))}`,
        seq: 999_998,
        meta: null,
        createdAt: new Date().toISOString(),
      }]);
    }
  };

  const sendMessage = async (body: string) => {
    if (!selectedThread) return;
    setSending(true);
    try {
      const response = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: selectedThread.id, body, contexts: contexts.map(toContextInput) }),
      });
      if (!response.ok) throw new Error(await response.text());
      await consumeStream(response, handleStreamEvent);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="chat-surface" data-testid="chat-surface">
      <aside className="chat-thread-list" data-testid="chat-thread-list">
        <div className="chat-thread-head">
          <span className="chat-thread-title">{t("chat.thread.listTitle")}</span>
          <Button size="sm" icon={<Icon name="plus" size={13} />} data-testid="chat-new" onClick={() => void createThread()}>
            {t("chat.thread.new")}
          </Button>
        </div>
        <div className="chat-thread-scroll">
          {groups.map((group) => (
            <div className="chat-thread-group" key={group.label}>
              <div className="chat-thread-group-label">{group.label}</div>
              {group.items.map((thread) => (
                <Link
                  key={thread.id}
                  href={`/chat?thread=${encodeURIComponent(thread.id)}`}
                  className={`chat-thread${thread.id === selectedThread?.id ? " is-active" : ""}`}
                  data-testid="chat-thread"
                  data-thread-id={thread.id}
                  data-state={thread.id === selectedThread?.id ? "active" : "inactive"}
                >
                  <span className="chat-thread-name" title={threadTitle(thread)}>{threadTitle(thread)}</span>
                  <span className="chat-thread-time">{relativeTime(thread.updatedAt, now)}</span>
                </Link>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <main className="chat-main">
        <div className="chat-conversation" data-testid="chat-conversation" ref={scrollRef}>
          {selectedThread ? (
            messages.length ? messages.map((message) => (
              <div className="chat-msg-row" data-testid="chat-msg" data-role={message.role} key={message.id}>
                <article className="chat-msg-bubble">
                  {message.role === "assistant" ? <Markdown text={message.body} /> : <p>{message.body}</p>}
                </article>
              </div>
            )) : <div className="chat-empty">{t("chat.empty.noMessages")}</div>
          ) : <div className="chat-empty">{t("chat.empty.noThread")}</div>}
        </div>
        <div className="chat-composer-wrap">
          <Composer
            contexts={contexts}
            disabled={!selectedThread || sending}
            onContextsChange={setContexts}
            onSend={sendMessage}
          />
        </div>
      </main>
    </div>
  );
}
