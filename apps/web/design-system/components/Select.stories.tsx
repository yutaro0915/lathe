import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { expect, userEvent, within } from "@storybook/test";

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

function InteractiveSelect() {
  const [value, setValue] = React.useState("all");

  return (
    <Select
      aria-label="Project"
      value={value}
      options={options}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

export const States: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-12)", alignItems: "center", flexWrap: "wrap" }}>
      <Select aria-label="Project" value="all" options={options} onChange={() => undefined} />
      <Select aria-label="Repository" value="lathe" options={["lathe", "docs", "client"]} onChange={() => undefined} />
      <Select aria-label="Disabled project" value="mcp" options={options} disabled onChange={() => undefined} />
    </div>
  ),
};

export const Interactive: Story = {
  render: () => <InteractiveSelect />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const select = canvas.getByRole("combobox", { name: "Project" });

    await expect(select).toHaveValue("all");
    await userEvent.selectOptions(select, "mcp");
    await expect(select).toHaveValue("mcp");
  },
};
