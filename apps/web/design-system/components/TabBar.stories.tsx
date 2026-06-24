import type { Meta, StoryObj } from "@storybook/react";

import { TabBar } from "@/design-system/components";

const meta = {
  title: "Design System/TabBar",
  component: TabBar,
  args: {
    tabs: ["Transcript", "Git", "Stats"],
    value: "Transcript",
  },
} satisfies Meta<typeof TabBar>;

export default meta;

type Story = StoryObj<typeof meta>;

export const States: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-16)" }}>
      <TabBar tabs={["Transcript", "Git", "Stats"]} value="Transcript" />
      <TabBar
        tabs={[
          { value: "findings", label: "Findings", count: 3 },
          { value: "evidence", label: "Evidence", count: 18 },
          { value: "cost", label: "Cost", count: "$4.82" },
        ]}
        value="evidence"
      />
    </div>
  ),
};
