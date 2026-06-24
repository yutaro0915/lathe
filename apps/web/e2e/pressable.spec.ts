import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Pressable } from "../design-system/components";

const componentsCss = readFileSync(new URL("../design-system/components.css", import.meta.url), "utf8");

test("Pressable keeps button semantics while preserving bespoke visual classes", async ({ page }) => {
  const defaultMarkup = renderToStaticMarkup(
    React.createElement(
      Pressable,
      { className: "bespoke-pressable", "aria-label": "Open evidence", "data-probe": "kept" },
      "Evidence session",
    ),
  );
  const submitMarkup = renderToStaticMarkup(
    React.createElement(Pressable, { type: "submit", "aria-label": "Submit evidence" }, "Submit"),
  );
  const disabledMarkup = renderToStaticMarkup(
    React.createElement(Pressable, { disabled: true, "aria-label": "Disabled evidence" }, "Disabled"),
  );

  await page.setContent(`
    <style>${componentsCss}</style>
    <style>
      .bespoke-pressable{
        background:rgb(1, 2, 3);
        border:7px solid rgb(4, 5, 6);
        color:rgb(7, 8, 9);
        font:700 19px Arial;
        padding:11px;
      }
    </style>
    ${defaultMarkup}
    ${submitMarkup}
    ${disabledMarkup}
  `);

  const button = page.getByRole("button", { name: "Open evidence" });
  await expect(button).toHaveAttribute("type", "button");
  await expect(button).toHaveAttribute("data-probe", "kept");
  await expect(button).toHaveClass(/lds-pressable/);
  await expect(button).toHaveClass(/bespoke-pressable/);
  await expect(button).toHaveCSS("cursor", "pointer");
  await expect(button).toHaveCSS("background-color", "rgb(1, 2, 3)");
  await expect(button).toHaveCSS("border-top-width", "7px");
  await expect(button).toHaveCSS("color", "rgb(7, 8, 9)");
  await expect(button).toHaveCSS("font-size", "19px");
  await expect(button).toHaveCSS("padding-top", "11px");

  await expect(page.getByRole("button", { name: "Submit evidence" })).toHaveAttribute("type", "submit");
  await expect(page.getByRole("button", { name: "Disabled evidence" })).toBeDisabled();
});
