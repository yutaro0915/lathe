import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "@storybook/test";

import { Header, ProjectScope } from "@/design-system/components";

const projectSelector = (
  <ProjectScope
    options={[
      { value: "all", label: "All projects · 12 sessions" },
      { value: "lathe", label: "lathe · 8 ses · $12" },
    ]}
    value="all"
    currentLabel="All projects"
    onValueChange={() => {}}
  />
);

const meta = {
  title: "Design System/Header",
  component: Header,
  args: {
    projectSelector,
  },
} satisfies Meta<typeof Header>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WithProjectSelector: Story = {
  render: () => <Header projectSelector={projectSelector} />,
};

export const BrandOnly: Story = {
  render: () => <Header />,
};

export const Contract: Story = {
  render: () => <Header projectSelector={projectSelector} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(canvas.getByTestId("topbar")).toBeInTheDocument();

    const brand = canvas.getByTestId("topbar-brand");
    await expect(within(brand).getByText("Lathe")).toBeInTheDocument();
    await expect(canvas.getByTestId("topbar-ph")).toHaveTextContent("Phase 1");
    await expect(canvas.getByTestId("project-picker")).toBeInTheDocument();
  },
};
