import Surface from "@/components/Surface";
import ChatSurface from "@/components/chat/ChatSurface";
import { getChatMessages, listChatThreads } from "@/lib/chat";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const requested = typeof sp.thread === "string" ? sp.thread : undefined;
  const threads = await listChatThreads();
  const selectedThread = threads.find((thread) => thread.id === requested) ?? threads[0] ?? null;
  const messages = selectedThread ? await getChatMessages(selectedThread.id) : [];

  return (
    <Surface
      title={<span data-testid="sessbar-title">Chat</span>}
      meta="Normal chat"
      surface="chat"
      headerTestId="sessbar"
    >
      <ChatSurface
        key={selectedThread?.id ?? "empty-chat"}
        initialThreads={threads}
        selectedThread={selectedThread}
        initialMessages={messages}
      />
    </Surface>
  );
}
