import type { Meta, StoryObj } from "@storybook/react";

import { Pressable } from "@/design-system/components";

const meta = {
  title: "Design System/Pressable",
  component: Pressable,
  args: {
    children: "Open evidence",
  },
} satisfies Meta<typeof Pressable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithClassName: Story = {
  render: () => (
    <Pressable
      className="pressable-story-target"
      style={{
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-sm)",
        background: "var(--panel)",
        color: "var(--text-soft)",
        font: "inherit",
        padding: "var(--sp-8) var(--sp-12)",
      }}
    >
      Evidence session
    </Pressable>
  ),
};

export const Disabled: Story = {
  args: {
    disabled: true,
    children: "Disabled pressable",
  },
};
