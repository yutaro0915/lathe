import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { expect, userEvent, within } from "@storybook/test";

import { SearchInput } from "@/design-system/components";

const meta = {
  title: "Design System/SearchInput",
  component: SearchInput,
  args: {
    placeholder: "Search sessions",
  },
} satisfies Meta<typeof SearchInput>;

export default meta;

type Story = StoryObj<typeof meta>;

function InteractiveSearchInput() {
  const [value, setValue] = React.useState("");

  return (
    <SearchInput
      aria-label="Search sessions"
      placeholder="Search sessions"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
}

export const States: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-12)", alignItems: "flex-start" }}>
      <SearchInput aria-label="Search sessions" placeholder="Search sessions" kbd="/" />
      <SearchInput aria-label="Search with value" placeholder="With value" defaultValue="phase 2" />
      <SearchInput aria-label="Search without icon" placeholder="No icon" icon={null} />
      <SearchInput aria-label="Disabled search" placeholder="Disabled" disabled kbd="⌘K" />
    </div>
  ),
};

export const Interactive: Story = {
  render: () => <InteractiveSearchInput />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("searchbox", { name: "Search sessions" });

    await userEvent.type(input, "phase 2");
    await expect(input).toHaveValue("phase 2");
    await userEvent.clear(input);
    await expect(input).toHaveValue("");
  },
};
