import type { Meta, StoryObj } from "@storybook/react";

import { Badge, Box, Stack } from "@/design-system/components";

const meta = {
  title: "Design System/Box",
  component: Box,
  args: {
    children: "Box content",
  },
} satisfies Meta<typeof Box>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PaddingAndOverflow: Story = {
  render: () => (
    <Stack gap={16}>
      <Stack direction="row" gap={12} wrap>
        <Box surface pad={8}>
          <Badge>pad 8</Badge>
        </Box>
        <Box surface pad={16}>
          <Badge tone="ok">pad 16</Badge>
        </Box>
        <Box surface pad={24}>
          <Badge tone="accent">pad 24</Badge>
        </Box>
      </Stack>

      <Box
        surface
        pad={12}
        overflow="auto"
        tabIndex={0}
        aria-label="Scrollable list of box overflow examples"
        style={{ maxHeight: 120 }}
      >
        <Stack gap={8}>
          {Array.from({ length: 8 }, (_, index) => (
            <Badge key={index} tone={index % 2 === 0 ? "neutral" : "default"}>
              scroll row {index + 1}
            </Badge>
          ))}
        </Stack>
      </Box>

      <Box surface pad={12} overflow="hidden" style={{ width: 220 }}>
        <span style={{ display: "block", whiteSpace: "nowrap" }}>
          https://example.com/very/long/unbreakable/path/segment
        </span>
      </Box>
    </Stack>
  ),
};
