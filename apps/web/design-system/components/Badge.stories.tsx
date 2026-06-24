import type { Meta, StoryObj } from "@storybook/react";

import { Badge } from "@/design-system/components";

const meta = {
  title: "Design System/Badge",
  component: Badge,
  args: {
    children: "Ready",
  },
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Tones: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "center", flexWrap: "wrap" }}>
      <Badge>Default</Badge>
      <Badge tone="ok">OK</Badge>
      <Badge tone="warn">Warn</Badge>
      <Badge tone="err">Error</Badge>
      <Badge tone="neutral">Neutral</Badge>
      <Badge tone="accent">Accent</Badge>
    </div>
  ),
};

export const WithDots: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "center", flexWrap: "wrap" }}>
      <Badge dot>Queued</Badge>
      <Badge tone="ok" dot>
        Passing
      </Badge>
      <Badge tone="warn" dot>
        Review
      </Badge>
    </div>
  ),
};
