import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "@storybook/test";

import { Pressable } from "@/design-system/components";

const meta = {
  title: "Design System/Pressable",
  component: Pressable,
  args: {
    children: "Open evidence",
  },
} satisfies Meta<typeof Pressable>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithClassName: Story = {
  render: () => (
    <Pressable
      className="pressable-story-target"
      style={{
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-sm)",
        background: "var(--panel)",
        color: "var(--text-soft)",
        font: "inherit",
        padding: "var(--sp-8) var(--sp-12)",
      }}
    >
      Evidence session
    </Pressable>
  ),
};

export const Disabled: Story = {
  args: {
    disabled: true,
    children: "Disabled pressable",
  },
};

export const Semantics: Story = {
  render: () => (
    <div style={{ display: "grid", gap: "var(--sp-8)", alignItems: "start" }}>
      <Pressable className="bespoke-pressable" aria-label="Open evidence" data-probe="kept">
        Evidence session
      </Pressable>
      <Pressable type="submit" aria-label="Submit evidence">
        Submit
      </Pressable>
      <Pressable disabled aria-label="Disabled evidence">
        Disabled
      </Pressable>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const defaultButton = canvas.getByRole("button", { name: "Open evidence" });
    await userEvent.hover(defaultButton);
    await expect(defaultButton).toHaveAttribute("type", "button");
    await expect(defaultButton).toHaveAttribute("data-probe", "kept");
    await expect(defaultButton).toHaveClass("lds-pressable", "bespoke-pressable");
    await expect(window.getComputedStyle(defaultButton).cursor).toBe("pointer");

    await expect(canvas.getByRole("button", { name: "Submit evidence" })).toHaveAttribute("type", "submit");
    await expect(canvas.getByRole("button", { name: "Disabled evidence" })).toBeDisabled();
  },
};
