import type { Meta, StoryObj } from "@storybook/react";

import { Badge, Button, MetricStat, Surface, TabBar } from "@/design-system/components";

const meta = {
  title: "Design System/Surface",
  component: Surface,
  args: {
    title: "Sessions",
    children: "Surface body",
  },
} satisfies Meta<typeof Surface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const HeaderSlots: Story = {
  render: () => (
    <div style={{ height: "32rem", display: "flex", background: "var(--bg)" }}>
      <Surface
        title="Sessions"
        meta="42 sessions · all projects"
        actions={
          <>
            <MetricStat layout="inline" value="67" label="green" />
            <Button size="sm" variant="primary">
              Analyze
            </Button>
          </>
        }
        tabs={<TabBar tabs={[{ value: "transcript", label: "Transcript", count: 14 }, "Git", "Stats"]} value="transcript" />}
      >
        <div style={{ padding: "var(--sp-16)", display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>
          <Badge tone="accent">active surface</Badge>
          <span style={{ color: "var(--text-soft)" }}>Body content fills the remaining work area.</span>
        </div>
      </Surface>
    </div>
  ),
};

export const WithRightPanel: Story = {
  render: () => (
    <div style={{ height: "32rem", display: "flex", background: "var(--bg)" }}>
      <Surface
        title="Finding detail"
        meta="evidence linked"
        actions={<Button size="sm">Resolve</Button>}
        rightPanel={{
          title: "Inspector",
          children: <div style={{ color: "var(--text-soft)" }}>Right panel content</div>,
        }}
      >
        <div style={{ padding: "var(--sp-16)", color: "var(--text-soft)" }}>Main column content</div>
      </Surface>
    </div>
  ),
};
