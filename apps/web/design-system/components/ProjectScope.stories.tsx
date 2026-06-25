import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { expect, screen, userEvent, waitFor, within } from "@storybook/test";

import { Header, ProjectScope, type ProjectScopeOption } from "@/design-system/components";

const options: ProjectScopeOption[] = [
  { value: "all", label: "All projects · 12 sessions" },
  { value: "lathe", label: "lathe · 8 ses · $41" },
  { value: "mcp", label: "mcp · 4 ses · —" },
];

const labelFor = (value: string) =>
  value === "all" ? "All projects" : options.find((option) => option.value === value)?.value ?? value;

const meta = {
  title: "Design System/ProjectScope",
  component: ProjectScope,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: "40rem" }}>
        <Header projectSelector={<Story />} />
      </div>
    ),
  ],
  args: {
    options,
    value: "all",
    currentLabel: "All projects",
    onValueChange: () => undefined,
    sessionLabel: null,
  },
} satisfies Meta<typeof ProjectScope>;

export default meta;

type Story = StoryObj<typeof meta>;

function InteractiveProjectScope() {
  const [value, setValue] = React.useState("all");

  return (
    <ProjectScope
      options={options}
      value={value}
      currentLabel={labelFor(value)}
      onValueChange={setValue}
      sessionLabel={value === "lathe" ? "S2c implementation review" : null}
    />
  );
}

export const Interactive: Story = {
  render: () => <InteractiveProjectScope />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByTestId("project-picker");

    await expect(trigger).toHaveAttribute("data-value", "all");

    await userEvent.click(trigger);
    await expect(await screen.findByTestId("project-menu")).toBeVisible();
    await expect(screen.getAllByTestId("project-option")).toHaveLength(options.length);

    await userEvent.click(screen.getByText("lathe · 8 ses · $41"));
    await waitFor(() => expect(screen.queryByTestId("project-menu")).not.toBeInTheDocument());
    await expect(canvas.getByTestId("topbar-scope-name")).toHaveTextContent("lathe");
    await expect(canvas.getByTestId("topbar-session-name")).toHaveTextContent("S2c implementation review");

    await userEvent.click(canvas.getByTestId("project-picker"));
    await expect(await screen.findByTestId("project-menu")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("project-menu")).not.toBeInTheDocument());
  },
};
