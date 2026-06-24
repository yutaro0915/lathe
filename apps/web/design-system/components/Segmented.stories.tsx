import type { Meta, StoryObj } from "@storybook/react";

import { Segmented } from "@/design-system/components";

const meta = {
  title: "Design System/Segmented",
  component: Segmented,
  args: {
    options: ["By step", "All"],
    value: "By step",
  },
} satisfies Meta<typeof Segmented>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Options: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-12)", alignItems: "center", flexWrap: "wrap" }}>
      <Segmented options={["By step", "All"]} value="By step" />
      <Segmented
        options={[
          { value: "turns", label: "Turns" },
          { value: "tools", label: "Tools" },
          { value: "git", label: "Git" },
        ]}
        value="tools"
      />
    </div>
  ),
};
