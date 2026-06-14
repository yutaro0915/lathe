import { FakeLanguageModel, assistantText, streamAgent } from '../src/index.js';

export async function collectChatLiteEvents() {
  const events = [];
  for await (const event of streamAgent({
    instructions: 'Reply as a compact assistant.',
    messages: [{ role: 'user', content: 'hello' }],
    deps: {},
    model: new FakeLanguageModel([assistantText('hello from chat-lite')]),
  })) {
    events.push(event);
  }
  return events;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const event of await collectChatLiteEvents()) {
    console.log(JSON.stringify(event));
  }
}
