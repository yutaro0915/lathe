import type { Meta, StoryObj } from "@storybook/react";

import { Icon, type IconName } from "@/design-system/components/icons";

const iconNames: IconName[] = [
  "list",
  "findings",
  "pr",
  "chart",
  "messages",
  "settings",
  "grid",
  "stack",
  "folder",
  "arrowLeft",
  "external",
  "github",
  "branch",
  "link",
  "plus",
  "x",
  "send",
  "check",
  "alert",
  "chevronDown",
  "chevronRight",
];

const meta = {
  title: "Design System/Icon",
  component: Icon,
  args: {
    name: "list",
  },
} satisfies Meta<typeof Icon>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Catalog: Story = {
  render: () => (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
        gap: "var(--sp-12)",
      }}
    >
      {iconNames.map((name) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: "var(--sp-8)", color: "var(--text-soft)" }}>
          <Icon name={name} />
          <span style={{ fontFamily: "var(--mono)", fontSize: "var(--fs-xs)" }}>{name}</span>
        </div>
      ))}
    </div>
  ),
};

export const StrokeWeights: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--sp-16)", alignItems: "center" }}>
      <Icon name="settings" stroke={1.4} />
      <Icon name="settings" />
      <Icon name="settings" stroke={2.4} />
    </div>
  ),
};
