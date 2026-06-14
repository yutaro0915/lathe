import { z } from 'zod';
import { FakeLanguageModel, assistantText, runAgent } from '../src/index.js';

export const analystLiteOutputSchema = z.object({
  findings: z.array(
    z.object({
      title: z.string(),
      confidence: z.number(),
    }),
  ),
});

export async function runAnalystLite() {
  return runAgent({
    instructions: 'Return a compact JSON finding analysis for the supplied observation bundle.',
    messages: [{ role: 'user', content: 'Analyze the provided fake session bundle.' }],
    deps: {
      sessionBundle: {
        session: { id: 'session-lite', title: 'Fake lite session' },
      },
    },
    model: new FakeLanguageModel([
      assistantText(JSON.stringify({ findings: [{ title: 'Fixture finding', confidence: 0.8 }] })),
    ]),
    output: analystLiteOutputSchema,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runAnalystLite();
  console.log(JSON.stringify(result.output, null, 2));
}
