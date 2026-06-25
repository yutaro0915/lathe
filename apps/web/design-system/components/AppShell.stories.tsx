import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "@storybook/test";

import { AppShell } from "@/design-system/components";

const MockTopNav = () => (
  <header className="lds-topbar" aria-label="Mock top navigation">
    <a className="lds-tb-brand" href="/" aria-label="Lathe home">
      <span>Lathe</span>
      <span className="lds-tb-ph">Phase 1</span>
    </a>
    <span className="lds-tb-scope">
      <span className="lds-tb-scope-sep" aria-hidden>
        /
      </span>
      <span className="lds-tb-scope-name">All projects</span>
    </span>
  </header>
);

const MockSideNav = () => (
  <nav className="lds-railnav" aria-label="Mock primary navigation">
    <div className="lds-rail-nav">
      <a className="lds-rail-nav-item active" href="/" aria-current="page">
        Sessions
      </a>
      <a className="lds-rail-nav-item" href="/findings">
        Findings
      </a>
      <a className="lds-rail-nav-item" href="/pr">
        PR
      </a>
    </div>
    <div className="lds-rail-scroll" />
    <div className="lds-rail-user">
      <span className="lds-avatar" aria-hidden>
        LT
      </span>
      <span className="lds-uname">Lathe Team</span>
    </div>
  </nav>
);

const MockWorkArea = () => (
  <main className="lds-page" aria-labelledby="appshell-story-title">
    <div className="lds-wh">
      <div className="lds-wh-titles" data-wah-cell="titles">
        <h1 id="appshell-story-title" className="lds-wh-title">
          Sessions
        </h1>
        <span className="lds-wh-meta">12 observed runs</span>
      </div>
      <div className="lds-wh-spacer" />
      <div className="lds-wh-actions" data-wah-cell="actions">
        <span className="lds-badge">Live</span>
      </div>
    </div>
    <div className="lds-page-scroll">
      <div className="lds-panel">
        <div className="lds-panel__head">
          <p className="lds-panel__title">Recent activity</p>
        </div>
        <div className="lds-panel__body">
          <p style={{ color: "var(--text-soft)" }}>Shell composition preview</p>
        </div>
      </div>
    </div>
  </main>
);

const meta = {
  title: "Design System/AppShell",
  component: AppShell,
  args: {
    topNav: <MockTopNav />,
    sideNav: <MockSideNav />,
    children: <MockWorkArea />,
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
