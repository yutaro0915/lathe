import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { expect, userEvent, within } from "@storybook/test";

import { Badge, Checkbox } from "@/design-system/components";

const meta = {
  title: "Design System/Checkbox",
  component: Checkbox,
  args: {
    label: "Include tool calls",
  },
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

function InteractiveCheckbox() {
  const [checked, setChecked] = React.useState(false);

  return (
    <Checkbox
      checked={checked}
      label="Include tool calls"
      onChange={(event) => setChecked(event.target.checked)}
    />
  );
}

export const States: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-12)", alignItems: "flex-start" }}>
      <Checkbox label="Unchecked" />
      <Checkbox label="Checked" checked readOnly />
      <Checkbox label="Disabled" disabled />
      <Checkbox label="Checked disabled" checked readOnly disabled />
      <Checkbox label="With trailing state" trailing={<Badge tone="accent">beta</Badge>} />
    </div>
  ),
};

export const Interactive: Story = {
  render: () => <InteractiveCheckbox />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole("checkbox", { name: "Include tool calls" });

    await expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await expect(checkbox).toBeChecked();
  },
};
