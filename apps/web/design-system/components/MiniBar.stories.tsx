import type { Meta, StoryObj } from "@storybook/react";

import { MiniBar } from "@/design-system/components";

const meta = {
  title: "Design System/MiniBar",
  component: MiniBar,
  args: {
    label: "Assistant",
    value: "62%",
    pct: 62,
  },
} satisfies Meta<typeof MiniBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Magnitudes: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)", maxWidth: "34rem" }}>
      <MiniBar label="User turns" value="18%" pct={18} />
      <MiniBar label="Assistant turns" value="62%" pct={62} />
      <MiniBar label="Tool calls" value="86%" pct={86} />
      <MiniBar label="Clamped over max" value="100%" pct={140} />
    </div>
  ),
};

export const LabelWidth: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)", maxWidth: "34rem" }}>
      <MiniBar label="Short" value="45%" pct={45} labelWidth="8rem" />
      <MiniBar label="Long label truncates in the label column" value="72%" pct={72} labelWidth="8rem" />
    </div>
  ),
};
