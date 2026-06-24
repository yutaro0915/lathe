import type { Meta, StoryObj } from "@storybook/react";

import { ConfidenceChip } from "@/design-system/components";

const meta = {
  title: "Design System/ConfidenceChip",
  component: ConfidenceChip,
} satisfies Meta<typeof ConfidenceChip>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Levels: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "center", flexWrap: "wrap" }}>
      <ConfidenceChip level="high">high</ConfidenceChip>
      <ConfidenceChip level="medium">medium</ConfidenceChip>
      <ConfidenceChip level="unattributed">unattributed</ConfidenceChip>
    </div>
  ),
};
