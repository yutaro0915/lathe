import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { expect, userEvent, within } from "@storybook/test";

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

function InteractiveSegmented() {
  const [value, setValue] = React.useState("turns");

  return (
    <Segmented
      aria-label="Transcript grouping"
      options={[
        { value: "turns", label: "Turns" },
        { value: "tools", label: "Tools" },
        { value: "git", label: "Git" },
      ]}
      value={value}
      onChange={setValue}
    />
  );
}

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

export const Interactive: Story = {
  render: () => <InteractiveSegmented />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const turns = canvas.getByRole("tab", { name: "Turns" });
    const tools = canvas.getByRole("tab", { name: "Tools" });

    await expect(turns).toHaveAttribute("aria-selected", "true");
    await userEvent.click(tools);
    await expect(tools).toHaveAttribute("aria-selected", "true");
    await expect(turns).toHaveAttribute("aria-selected", "false");
  },
};
