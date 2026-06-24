import type { Meta, StoryObj } from "@storybook/react";

import { Badge, Checkbox } from "@/design-system/components";

const meta = {
  title: "Design System/Checkbox",
  component: Checkbox,
  args: {
    label: "Include tool calls",
  },
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

export const States: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-12)", alignItems: "flex-start" }}>
      <Checkbox label="Unchecked" />
      <Checkbox label="Checked" checked readOnly />
      <Checkbox label="Disabled" disabled />
      <Checkbox label="Checked disabled" checked readOnly disabled />
      <Checkbox label="With trailing state" trailing={<Badge tone="accent">beta</Badge>} />
    </div>
  ),
};
