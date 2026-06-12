export const dynamic = "force-dynamic";

import ChatView from "@/components/ChatView";
import { resolveChatProviderName } from "@/lib/chat-agent";
import { getChatThread, listChatMessages, listChatThreads } from "@/lib/chat-store";
import { listFindings, listSessions } from "@/lib/db";

function stringParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParam(value: string | string[] | undefined): number | undefined {
  const raw = stringParam(value);
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const threadId = stringParam(sp.thread);
  const selectedThread = threadId ? await getChatThread(threadId) : undefined;
  const [threads, sessions, findings] = await Promise.all([listChatThreads(), listSessions(), listFindings()]);
  const messages = selectedThread ? await listChatMessages(selectedThread.id) : [];
  const attachedSessionId = selectedThread?.sessionId ?? stringParam(sp.session) ?? null;
  const attachedFindingId = selectedThread?.findingId ?? numberParam(sp.finding) ?? null;

  return (
    <ChatView
      threads={threads}
      selectedThread={selectedThread ?? null}
      messages={messages}
      sessions={sessions}
      findings={findings}
      attachedSessionId={attachedSessionId}
      attachedFindingId={attachedFindingId}
      defaultProvider={resolveChatProviderName()}
    />
  );
}
