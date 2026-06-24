import type { Meta, StoryObj } from "@storybook/react";

import { Badge, Box, Stack } from "@/design-system/components";

const meta = {
  title: "Design System/Stack",
  component: Stack,
  args: {
    children: "Stack content",
  },
} satisfies Meta<typeof Stack>;

export default meta;

type Story = StoryObj<typeof meta>;

export const RowsAndContainment: Story = {
  render: () => (
    <Stack gap={20}>
      <Stack direction="row" gap={8} align="center" wrap>
        <Badge>gap 8</Badge>
        <Badge tone="ok">ready</Badge>
        <Badge tone="warn">review</Badge>
      </Stack>

      <Stack direction="row" gap={16} align="center" wrap>
        <Badge>gap 16</Badge>
        <Badge tone="neutral">queued</Badge>
        <Badge tone="accent">active</Badge>
      </Stack>

      <Box surface pad={12} style={{ width: 220 }}>
        <Stack direction="row" gap={8} align="center">
          <Badge tone="accent">url</Badge>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            https://example.com/very/long/unbreakable/path/segment
          </span>
        </Stack>
      </Box>

      <Stack as="nav" direction="row" gap={8} align="center" wrap aria-label="Example sections">
        <Badge>overview</Badge>
        <Badge>diff</Badge>
        <Badge>findings</Badge>
      </Stack>
    </Stack>
  ),
};
