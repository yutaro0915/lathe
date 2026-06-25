import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "@storybook/test";

import {
  AppShell,
  Badge,
  Header,
  Panel,
  ProjectScope,
  SideNav,
  Surface,
  type SideNavItem,
} from "@/design-system/components";

const SCOPE_OPTIONS = [
  { value: "all", label: "All projects · 12 sessions" },
  { value: "lathe", label: "lathe · 8 ses · $12" },
  { value: "demo", label: "demo · 4 ses · $5" },
];

const NAV_ITEMS: SideNavItem[] = [
  { href: "/", label: "Sessions", nav: "sessions", icon: "list", active: true },
  { href: "/findings", label: "Findings", nav: "findings", icon: "findings", active: false },
  { href: "/pr", label: "PR", nav: "pr", icon: "pr", active: false },
  { href: "/overview", label: "Overview", nav: "overview", icon: "chart", active: false },
];

const projectSelector = (
  <ProjectScope
    options={SCOPE_OPTIONS}
    value="all"
    currentLabel="All projects"
    onValueChange={() => {}}
  />
);

const topNav = <Header projectSelector={projectSelector} />;

const sideNav = (
  <SideNav items={NAV_ITEMS} user={{ name: "Yutaro Ono", initials: "YO" }} activePath="/" />
);

const workArea = (
  <Surface title="Sessions" meta="12 observed runs" actions={<Badge tone="ok">Live</Badge>}>
    <Panel title="Recent activity">
      <div style={{ color: "var(--text-soft)" }}>Shell composition preview</div>
    </Panel>
  </Surface>
);

const meta = {
  title: "Design System/AppShell",
  component: AppShell,
  args: {
    topNav,
    sideNav,
    children: workArea,
  },
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AppShell>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Preview: Story = {
  render: (args) => (
    <div style={{ height: 520, overflow: "hidden" }}>
      <AppShell {...args} />
    </div>
  ),
};

export const Contract: Story = {
  render: (args) => (
    <div style={{ height: 520, overflow: "hidden" }}>
      <AppShell {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByTestId("lds-app")).toBeInTheDocument();
    await expect(canvas.getByTestId("lds-shell-body")).toBeInTheDocument();
    await expect(canvas.getByTestId("lds-workarea")).toBeInTheDocument();
  },
};
