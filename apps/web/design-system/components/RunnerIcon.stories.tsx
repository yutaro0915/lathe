import type { Meta, StoryObj } from "@storybook/react";

import { RunnerIcon } from "@/design-system/components";

const meta = {
  title: "Design System/RunnerIcon",
  component: RunnerIcon,
  args: {
    runner: "codex",
  },
} satisfies Meta<typeof RunnerIcon>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Runners: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "center", flexWrap: "wrap" }}>
      <RunnerIcon runner="claude-code" />
      <RunnerIcon runner="codex" />
      <RunnerIcon runner="cursor" />
      <RunnerIcon runner="unknown-runner" />
    </div>
  ),
};
