import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

import { SideNav, type SideNavItem } from "@/design-system/components";

const baseItems: Omit<SideNavItem, "active">[] = [
  { href: "/", label: "Sessions", nav: "sessions", icon: "list" },
  { href: "/findings", label: "Findings", nav: "findings", icon: "findings" },
  { href: "/chat", label: "Chat", nav: "chat", icon: "messages" },
  { href: "/pr", label: "PR", nav: "pr", icon: "pr" },
  { href: "/overview", label: "Overview", nav: "overview", icon: "chart" },
];

const itemsFor = (activeNav?: string): SideNavItem[] =>
  baseItems.map((item) => ({
    ...item,
    active: item.nav === activeNav,
  }));

const frame = (story: ReactNode) => (
  <div style={{ width: "var(--rail-w, 264px)", height: 420, border: "1px solid var(--border)" }}>{story}</div>
);

const meta = {
  title: "Design System/SideNav",
  component: SideNav,
  args: {
    items: itemsFor("sessions"),
    user: { name: "Yutaro Ono", initials: "YO" },
    activePath: "/",
  },
} satisfies Meta<typeof SideNav>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SessionsActive: Story = {
  render: () => frame(<SideNav items={itemsFor("sessions")} user={{ name: "Yutaro Ono", initials: "YO" }} activePath="/" />),
};

export const FindingsActive: Story = {
  render: () =>
    frame(<SideNav items={itemsFor("findings")} user={{ name: "Yutaro Ono", initials: "YO" }} activePath="/findings" />),
};

export const AllInactive: Story = {
  render: () => frame(<SideNav items={itemsFor()} user={{ name: "Yutaro Ono", initials: "YO" }} activePath="/unknown" />),
};
