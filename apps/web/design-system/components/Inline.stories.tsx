import type { Meta, StoryObj } from "@storybook/react";

import { Badge, Box, Chip, Inline, Stack } from "@/design-system/components";

const meta = {
  title: "Design System/Inline",
  component: Inline,
  args: {
    children: "Inline content",
  },
} satisfies Meta<typeof Inline>;

export default meta;

type Story = StoryObj<typeof meta>;

const chips = ["agent", "review", "latency", "cost", "tokens", "diff", "finding", "queued", "done"];

export const WrapAndGaps: Story = {
  render: () => (
    <Stack gap={16}>
      <Box surface pad={12} style={{ width: 220 }}>
        <Inline gap={8}>
          {chips.map((chip) => (
            <Chip key={chip}>{chip}</Chip>
          ))}
        </Inline>
      </Box>

      <Inline gap={4} align="center">
        <Badge>gap 4</Badge>
        <Badge tone="neutral">one</Badge>
        <Badge tone="neutral">two</Badge>
      </Inline>

      <Inline gap={16} align="center">
        <Badge>gap 16</Badge>
        <Badge tone="accent">one</Badge>
        <Badge tone="accent">two</Badge>
      </Inline>
    </Stack>
  ),
};
