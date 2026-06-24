import type { TestRunnerConfig } from "@storybook/test-runner";
import { configureAxe, checkA11y, injectAxe } from "axe-playwright";
import { getStoryContext } from "@storybook/test-runner";

const config: TestRunnerConfig = {
  async preVisit(page) {
    await injectAxe(page);
  },
  async postVisit(page, context) {
    const storyContext = await getStoryContext(page, context);
    const a11y = storyContext.parameters.a11y ?? {};

    await configureAxe(page, a11y.config);
    await checkA11y(
      page,
      a11y.context ?? "#storybook-root",
      {
        detailedReport: true,
        detailedReportOptions: { html: true },
        axeOptions: a11y.options,
      },
      false,
    );
  },
};

export default config;
