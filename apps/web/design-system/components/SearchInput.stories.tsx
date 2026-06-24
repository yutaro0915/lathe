import type { Meta, StoryObj } from "@storybook/react";

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

export const States: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-12)", alignItems: "flex-start" }}>
      <SearchInput placeholder="Search sessions" kbd="/" />
      <SearchInput placeholder="With value" defaultValue="phase 2" />
      <SearchInput placeholder="No icon" icon={null} />
      <SearchInput placeholder="Disabled" disabled kbd="⌘K" />
    </div>
  ),
};
