import type { Meta, StoryObj } from "@storybook/react";

import { Chip } from "@/design-system/components";

const meta = {
  title: "Design System/Chip",
  component: Chip,
  args: {
    children: "chip",
  },
} satisfies Meta<typeof Chip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Kinds: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "center", flexWrap: "wrap" }}>
      <Chip>default</Chip>
      <Chip kind="hash">a1b2c3d</Chip>
      <Chip kind="cost">$0.42</Chip>
      <Chip kind="token">12.4k tok</Chip>
    </div>
  ),
};
