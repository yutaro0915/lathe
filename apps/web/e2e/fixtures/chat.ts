import { withDb } from "./db";

export const CHAT_FIXTURE = {
  projectId: "fixture:chat-surface",
  sessionId: "fixture-chat-session",
  threadId: "fixture-chat-thread",
  threadTitle: "Fixture linked chat thread",
  sessionTitle: "Fixture chat linked session",
  userMessage: "What happened in the fixture session?",
  assistantMessage: "The fixture session has one failed command and one assistant summary.",
  sendBody: "Please answer through the fake ACP agent.",
};

export async function cleanupChatFixtures() {
  await withDb(async (client) => {
    await client.query("DELETE FROM chat_messages WHERE thread_id = $1", [CHAT_FIXTURE.threadId]);
    await client.query("DELETE FROM chat_threads WHERE id = $1", [CHAT_FIXTURE.threadId]);
    await client.query("DELETE FROM chat_messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE title = 'New chat')");
    await client.query("DELETE FROM chat_threads WHERE title = 'New chat'");
    await client.query("DELETE FROM transcript_events WHERE session_id = $1", [CHAT_FIXTURE.sessionId]);
    await client.query("DELETE FROM sessions WHERE id = $1", [CHAT_FIXTURE.sessionId]);
    await client.query("DELETE FROM projects WHERE id = $1", [CHAT_FIXTURE.projectId]);
  });
}

export async function seedChatFixtures() {
  await cleanupChatFixtures();
  await withDb(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO projects (id, display_name, git_remote, cwd_hint) VALUES ($1, $2, $3, $4)",
        [CHAT_FIXTURE.projectId, "Chat Surface Fixture", "https://github.com/lathe-fixture/chat.git", "/tmp/lathe-chat"],
      );
      await client.query(
        `INSERT INTO sessions (
           id, project_id, project, title, runner, model, status, started_at, ended_at, duration_ms, turn_count,
           tool_count, edit_count, bash_count, subagent_count, error_count, token_usage, token_in, token_out,
           git_branch, commit_count, cost_usd, summary, seq
         )
         VALUES ($1, $2, 'Chat Surface Fixture', $3, 'codex', '<synthetic>', 'done',
           '2026-06-22 00:00:00', '2026-06-22 00:00:04', 4000, 1, 1, 0, 1, 0, 1, 120, 70, 50,
           'loop/chat-fixture', 0, 0.03, 'Fixture summary for linked chat context.', 930013)`,
        [CHAT_FIXTURE.sessionId, CHAT_FIXTURE.projectId, CHAT_FIXTURE.sessionTitle],
      );
      await client.query(
        `INSERT INTO transcript_events
          (id, session_id, seq, ts, type, actor, title, body, file_path, command, exit_code, duration_ms, token_usage, subagent, meta, parent_id)
         VALUES
          ($1, $2, 1, '00:00:00', 'user_message', 'user', 'Fixture chat prompt', 'Please inspect chat fixture.', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL),
          ($3, $2, 2, '00:00:01', 'bash', 'assistant', 'Fixture failed command', 'exit 1 from fixture chat', NULL, 'pnpm chat:test', 1, 900, 80, NULL, NULL, NULL),
          ($4, $2, 3, '00:00:04', 'assistant_message', 'assistant', 'Fixture chat summary', 'The chat fixture command failed once.', NULL, NULL, NULL, 200, 40, NULL, NULL, NULL)`,
        [
          `${CHAT_FIXTURE.sessionId}-event-1`,
          CHAT_FIXTURE.sessionId,
          `${CHAT_FIXTURE.sessionId}-event-2`,
          `${CHAT_FIXTURE.sessionId}-event-3`,
        ],
      );
      await client.query(
        `INSERT INTO chat_threads (id, project_id, title, session_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, '2026-06-22 00:01:00', '2026-06-22 00:02:00')`,
        [CHAT_FIXTURE.threadId, CHAT_FIXTURE.projectId, CHAT_FIXTURE.threadTitle, CHAT_FIXTURE.sessionId],
      );
      await client.query(
        `INSERT INTO chat_messages (id, thread_id, role, body, seq, meta, created_at)
         VALUES
          ($1, $2, 'user', $3, 1, '{}'::jsonb, '2026-06-22 00:01:10'),
          ($4, $2, 'assistant', $5, 2, '{}'::jsonb, '2026-06-22 00:01:20')`,
        [
          `${CHAT_FIXTURE.threadId}-msg-1`,
          CHAT_FIXTURE.threadId,
          CHAT_FIXTURE.userMessage,
          `${CHAT_FIXTURE.threadId}-msg-2`,
          CHAT_FIXTURE.assistantMessage,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}
