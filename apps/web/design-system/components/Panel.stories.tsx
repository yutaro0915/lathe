import type { Meta, StoryObj } from "@storybook/react";

import { Badge, Button, Panel } from "@/design-system/components";

const meta = {
  title: "Design System/Panel",
  component: Panel,
  args: {
    title: "Findings",
    children: "Panel body",
  },
} satisfies Meta<typeof Panel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const HeaderVariants: Story = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))", gap: "var(--sp-12)" }}>
      <Panel title="Sessions" count={12}>
        <div style={{ color: "var(--text-soft)" }}>Dense body content with default header chrome.</div>
      </Panel>
      <Panel title="Findings" count={3} sub="new" action={<Button size="sm">Open</Button>}>
        <div style={{ display: "flex", gap: "var(--sp-8)", flexWrap: "wrap" }}>
          <Badge tone="warn">review</Badge>
          <Badge tone="ok">ready</Badge>
        </div>
      </Panel>
      <Panel>
        <div style={{ color: "var(--muted)" }}>Body-only panel.</div>
      </Panel>
    </div>
  ),
};
