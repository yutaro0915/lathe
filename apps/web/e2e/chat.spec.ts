import { CHAT_FIXTURE, expect, registerFixtureHooks, test, withDb } from "./helpers";

registerFixtureHooks();

async function persistedMessageCount(role: string, body: string): Promise<number> {
  return withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM chat_messages
        WHERE thread_id = $1
          AND role = $2
          AND body LIKE $3`,
      [CHAT_FIXTURE.threadId, role, `%${body}%`],
    );
    return Number(result.rows[0].count);
  });
}

test.describe("Chat surface A (/chat)", () => {
  test("thread list, conversation, and single-frame composer render the seeded thread", async ({ page }) => {
    await page.goto(`/chat?thread=${CHAT_FIXTURE.threadId}`);

    await expect(page.locator(`[data-testid="globalnav-tab"][data-nav="chat"]`)).toHaveAttribute("data-state", "active");
    await expect(page.locator(`[data-testid="chat-surface"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="chat-thread-list"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="chat-thread"][data-thread-id="${CHAT_FIXTURE.threadId}"]`)).toContainText(CHAT_FIXTURE.threadTitle);
    await expect(page.locator(`[data-testid="chat-conversation"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="chat-msg"][data-role="user"]`)).toContainText(CHAT_FIXTURE.userMessage);
    await expect(page.locator(`[data-testid="chat-msg"][data-role="assistant"]`)).toContainText(CHAT_FIXTURE.assistantMessage);
    await expect(page.locator(`[data-testid="composer"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="composer-context"]`)).toContainText(CHAT_FIXTURE.sessionTitle);
    await expect(page.locator(`[data-testid="composer-add-context"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="composer-input"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="composer-send"]`)).toBeVisible();
  });

  test("new chat creates a selectable thread", async ({ page }) => {
    await page.goto(`/chat?thread=${CHAT_FIXTURE.threadId}`);
    await page.locator(`[data-testid="chat-new"]`).click();

    await expect(page).toHaveURL(/\/chat\?thread=chat-/);
    const threadId = new URL(page.url()).searchParams.get("thread");
    expect(threadId).toMatch(/^chat-/);
    await expect(page.locator(`[data-testid="chat-thread"][data-thread-id="${threadId}"]`)).toContainText("新しいチャット");
    await expect(page.locator(`[data-testid="chat-conversation"]`)).toContainText("まだメッセージはありません。");
  });

  test("composer context search input adds a free-form context chip", async ({ page }) => {
    await page.goto(`/chat?thread=${CHAT_FIXTURE.threadId}`);

    const context = page.locator(`[data-testid="composer-context"]`);
    await page.locator(`[data-testid="composer-add-context"]`).click();
    const contextInput = context.locator(`input[type="search"][aria-label="自由入力のコンテキスト"]`);
    await expect(contextInput).toBeVisible();
    await expect(contextInput).toHaveAttribute("placeholder", "自由入力のコンテキスト");

    await contextInput.fill("release blocker notes");
    await contextInput.press("Enter");

    await expect(context.locator(`[data-context-kind="text"]`)).toContainText(
      "テキスト: release blocker notes",
    );
    await expect(contextInput).toHaveCount(0);
  });

  test("sending persists the user message and renders the fake streamed assistant reply", async ({ page }) => {
    await page.goto(`/chat?thread=${CHAT_FIXTURE.threadId}`);
    await page.locator(`[data-testid="composer-input"]`).fill(CHAT_FIXTURE.sendBody);
    await page.locator(`[data-testid="composer-send"]`).click();

    await expect(page.locator(`[data-testid="chat-msg"][data-role="user"]`, { hasText: CHAT_FIXTURE.sendBody })).toBeVisible();
    await expect(page.locator(`[data-testid="chat-msg"][data-role="assistant"]`, { hasText: "permission=deny-once" })).toBeVisible();
    await expect.poll(() => persistedMessageCount("user", CHAT_FIXTURE.sendBody)).toBe(1);
    await expect.poll(() => persistedMessageCount("assistant", "permission=deny-once")).toBe(1);
  });
});
