import type { Meta, StoryObj } from "@storybook/react";

import { MetricStat } from "@/design-system/components";

const meta = {
  title: "Design System/MetricStat",
  component: MetricStat,
  args: {
    value: "42",
    label: "sessions",
  },
} satisfies Meta<typeof MetricStat>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Layouts: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-24)", alignItems: "baseline", flexWrap: "wrap" }}>
      <MetricStat value="67" label="green" />
      <MetricStat value="1.23" sub="x" label="cost ratio" />
      <MetricStat layout="inline" value="$3.42" label="cost" />
    </div>
  ),
};
