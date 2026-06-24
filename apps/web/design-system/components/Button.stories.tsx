import type { Meta, StoryObj } from "@storybook/react";

import { Button } from "@/design-system/components";
import { Icon } from "@/design-system/components/icons";

const meta = {
  title: "Design System/Button",
  component: Button,
  args: {
    children: "Button",
  },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "center", flexWrap: "wrap" }}>
      <Button>Default</Button>
      <Button variant="primary">Primary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button>
    </div>
  ),
};

export const SizesAndStates: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-8)", alignItems: "center", flexWrap: "wrap" }}>
      <Button size="md" icon={<Icon name="plus" />}>
        Default size
      </Button>
      <Button size="sm" icon={<Icon name="check" />}>
        Small
      </Button>
      <Button disabled>Disabled</Button>
      <Button variant="primary" disabled>
        Disabled primary
      </Button>
    </div>
  ),
};
