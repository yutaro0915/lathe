import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "@storybook/test";

import { Header } from "@/design-system/components";

const projectSelector = (
  <span className="lds-tb-scope" data-testid="mock-scope">
    <span className="lds-tb-scope-sep" aria-hidden>
      /
    </span>
    <span className="lds-tb-scope-name">All projects</span>
  </span>
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
    await expect(canvas.getByTestId("topbar-logo")).toHaveTextContent("L");
    await expect(canvas.getByTestId("topbar-ph")).toHaveTextContent("Phase 1");
    await expect(canvas.getByTestId("mock-scope")).toBeInTheDocument();
  },
};
