import type { Meta, StoryObj } from "@storybook/react";

import { Select } from "@/design-system/components";

const options = [
  { value: "all", label: "All projects" },
  { value: "lathe", label: "lathe" },
  { value: "mcp", label: "mcp" },
];

const meta = {
  title: "Design System/Select",
  component: Select,
  args: {
    value: "all",
    options,
  },
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

export const States: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-12)", alignItems: "center", flexWrap: "wrap" }}>
      <Select value="all" options={options} onChange={() => undefined} />
      <Select value="lathe" options={["lathe", "docs", "client"]} onChange={() => undefined} />
      <Select value="mcp" options={options} disabled onChange={() => undefined} />
    </div>
  ),
};
