import type { Meta, StoryObj } from "@storybook/react";

import { IconButton } from "@/design-system/components";
import { Icon } from "@/design-system/components/icons";

const meta = {
  title: "Design System/IconButton",
  component: IconButton,
  args: {
    label: "Settings",
    children: <Icon name="settings" />,
  },
} satisfies Meta<typeof IconButton>;

export default meta;

type Story = StoryObj<typeof meta>;

export const States: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "center", flexWrap: "wrap" }}>
      <IconButton label="Settings">
        <Icon name="settings" />
      </IconButton>
      <IconButton label="Close">
        <Icon name="x" />
      </IconButton>
      <IconButton label="Disabled" disabled>
        <Icon name="send" />
      </IconButton>
    </div>
  ),
};
