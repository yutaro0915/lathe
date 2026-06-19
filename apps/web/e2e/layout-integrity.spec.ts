// e2e/layout-integrity.spec.ts — the deterministic RENDER-INTEGRITY gate.
//
// Loads every UI surface in a real headless browser at TWO widths (the two
// Playwright projects: `chromium` ~1500px and `chromium-narrow` 700px) and
// asserts machine-decidable LAYOUT invariants by reading integer layout rects
// (scrollWidth/clientWidth, getBoundingClientRect/boundingBox, getComputedStyle).
// NO pixel diffing, NO visual judge — every check is a numeric inequality, so a
// failure prints the exact tag/testid + numeric delta and is reproducible.
//
// This is the layer that would have caught the failures that shipped while every
// STATIC gate stayed green: header misalignment (段差), horizontal overflow,
// silently-truncated labels, overlapping header content, cramped panels, and a
// detail pane narrower than its list.
//
// Families (per surface, collected into one violations[] then expect([])):
//   1 no-overflow         — the document must not scroll horizontally; and no
//                           visible element may have scrollWidth-clientWidth>0
//                           UNLESS it is an intentional scroll pane (overflow-x
//                           auto/scroll or under data-scroll) or a single-line
//                           text-ellipsis label (that is Family 2's concern).
//   2 no-truncation       — visible white-space:nowrap element clipped
//                           (overflow-x hidden/clip + scrollWidth>clientWidth) =
//                           a SILENT ellipsis, excluding data-ellipsis-ok AND
//                           elements whose full text is reachable via a `title`
//                           tooltip (self or enclosing row) — not silent.
//   3 header-aligned (段差) — the WorkareaHeader row cells (data-wah-cell) share a
//                           vertical CENTRE: max(center)-min(center) <= 1 (the
//                           band is align-items:center, so centres are the row).
//   4 no-overlap          — header title cluster vs actions cluster must not have
//                           intersecting AABBs; and the title's centre must not be
//                           occluded (elementFromPoint, NOT Playwright isVisible —
//                           microsoft/playwright#9923).
//   5 fits-container      — key panels' child rect contained in parent rect, on
//                           each axis the parent does NOT scroll (a scroll pane
//                           legitimately holds taller/wider content on its axis).
//   6 detail-wider-than-list — master-detail surfaces: side-by-side ⇒ detail wider
//                           than list; stacked (narrow) ⇒ detail not narrower.
//   7 a11y                — axe-core color-contrast + target-size, HARD-gated per
//                           surface (counts printed, then asserted ==0): the
//                           baseline is clean across all 7 surfaces × 2 widths.
//
// Visibility is gated FIRST in every check (display:none / zero-box /
// getClientRects().length===0 read 0/0 and would be false negatives).

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// axe-core UMD source, injected via addScriptTag content (offline, no network).
// Resolved relative to process.cwd() (Playwright runs from the config dir,
// apps/web), so no require / import.meta / __dirname (esbuild's ESM loader
// rewrites those into a `require` polyfill that breaks at load).
const AXE_SOURCE = readFileSync(
  `${process.cwd()}/node_modules/axe-core/axe.min.js`,
  "utf8",
);

// ---------------------------------------------------------------------------
// Surface map. Routes are discovered against the seeded DB (no hardcoded ids):
// `build` receives a live, valid seeded session id so the per-session surfaces
// (SessionViewer transcript, in-session Stats) navigate to REAL data.
// `masterDetail` names the list + detail panes for the #6 invariant; only the
// transcript / Findings / PR surfaces are master-detail.
// ---------------------------------------------------------------------------
type Surface = {
  name: string;
  build: (sid: string) => string;
  masterDetail?: { list: string; detail: string };
};

const SURFACES: Surface[] = [
  { name: "Sessions (list)", build: () => "/" },
  {
    name: "SessionViewer (transcript)",
    build: (sid) => `/?session=${encodeURIComponent(sid)}&tab=transcript`,
    masterDetail: { list: "lds-sv-tx-list", detail: "lds-sv-tx-detail" },
  },
  {
    name: "Stats (in-session)",
    build: (sid) => `/?session=${encodeURIComponent(sid)}&tab=stats`,
  },
  {
    // The standalone Git-diff route. /diff is a server REDIRECT to
    // /?session=<id>&tab=git, so it lands on the SAME shell-owned <Surface> as
    // every other surface (no self-drawn header band). Bare /diff defaults to the
    // most recent session that actually HAS changed files, so the diff workspace
    // (file tree + hunks + attribution) renders populated. The workspace is a
    // three-pane grid, NOT a list+detail master-detail, so no `masterDetail`.
    name: "Diff (Git, standalone /diff)",
    build: () => "/diff",
  },
  {
    name: "Findings",
    build: () => "/findings",
    masterDetail: { list: "findings-list", detail: "finding-detail" },
  },
  {
    name: "PR",
    build: () => "/pr",
    masterDetail: { list: "pr-sidebar", detail: "pr-main" },
  },
  { name: "Overview", build: () => "/overview" },
];

// Discover a valid seeded session id from the Sessions list (avoids hardcoding
// an id that may not exist in a given seed).
async function discoverSessionId(page: Page): Promise<string> {
  await page.goto("/");
  const first = page.locator(`[data-testid="session-list"] [data-testid="session-item"]`).first();
  await expect(first).toBeVisible();
  const id = await first.getAttribute("data-session-id");
  if (!id) throw new Error("layout-integrity: no seeded session id on the Sessions surface");
  return id;
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  // The shell mounts client components + runs layout effects (scrollIntoView,
  // turn rollups). Let two animation frames + fonts flush so rects are stable.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
        if (fonts && typeof fonts.ready?.then === "function") {
          fonts.ready.then(done, done);
        } else {
          done();
        }
      }),
  );
}

// ---------------------------------------------------------------------------
// The browser-side collector. Returns a flat violations[] of strings, each
// carrying the family, a tag/testid identifier, and the numeric delta — so a
// failed expect([]) is directly actionable. Pure DOM reads; runs in page ctx.
// ---------------------------------------------------------------------------
type CollectArg = { masterDetail: { list: string; detail: string } | null };

function collectViolations({ masterDetail }: CollectArg): string[] {
  const out: string[] = [];

  // ---- shared visibility gate -------------------------------------------
  // An element reads 0/0 (false negative) when it is display:none, zero-box, or
  // has no client rects. Gate every check on real visibility first.
  const isVisible = (el: Element): boolean => {
    if (el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    if (parseFloat(cs.opacity || "1") === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  // A stable identifier for an element in a violation line.
  const idOf = (el: Element): string => {
    const tid = el.getAttribute("data-testid");
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).slice(0, 2).join(".");
    const tag = el.tagName.toLowerCase();
    return `${tag}${tid ? `[${tid}]` : cls ? `.${cls}` : ""}`;
  };

  // Is el (or an ancestor) an intentional horizontal SCROLL pane? overflow-x ∈
  // {auto, scroll} scrolls the overflow inside the box; data-scroll marks an
  // intentional scroll pane (diff body, finding excerpt). Such overflow is by
  // design and must NOT count as a spill (prompt: exclude data-scroll panes).
  const inScrollPane = (el: Element): boolean => {
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      if (cur instanceof HTMLElement && cur.dataset.scroll != null) return true;
      const ox = getComputedStyle(cur).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
      cur = cur.parentElement;
    }
    return false;
  };
  // A single-line text-ellipsis (overflow-x:hidden|clip + text-overflow:ellipsis
  // + white-space:nowrap) clips ONE line on purpose; that is the intended-ellipsis
  // case handled by Family 2's data-ellipsis-ok gate, not a layout SPILL. Exclude
  // it here so Family 1 stays about real overflow (content escaping / hard-clipped
  // panes), not deliberate label ellipsis.
  const isTextEllipsis = (cs: CSSStyleDeclaration): boolean =>
    cs.textOverflow === "ellipsis" && cs.whiteSpace === "nowrap";

  const all = Array.from(document.querySelectorAll<HTMLElement>("body *"));

  // ===== Family 1: no-overflow (horizontal overflow / spill) =============
  // (a) PAGE level: the document must not scroll horizontally — a sideways
  //     scrollbar on the whole page is an unambiguous overflow bug.
  const docEl = document.documentElement;
  const pageDelta = docEl.scrollWidth - docEl.clientWidth;
  if (pageDelta > 0) out.push(`[no-overflow] document scrolls horizontally by ${pageDelta}px`);
  // (b) ELEMENT level: a visible element whose content is wider than its box
  //     (scrollWidth-clientWidth>0) overflows — whether it escapes (overflow-x:
  //     visible) or is hard-clipped (hidden/clip). Excluded: intentional scroll
  //     panes (auto/scroll, data-scroll) and single-line text-ellipsis labels.
  for (const el of all) {
    if (!isVisible(el)) continue;
    const delta = el.scrollWidth - el.clientWidth;
    if (delta <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX === "auto" || cs.overflowX === "scroll") continue; // scrolls in-box
    if (inScrollPane(el)) continue; // under a scroll pane / data-scroll
    if (isTextEllipsis(cs)) continue; // deliberate one-line ellipsis (Family 2)
    out.push(`[no-overflow] ${idOf(el)} scrollWidth-clientWidth=${delta}px (overflow-x:${cs.overflowX})`);
  }

  // ===== Family 2: no-truncation (silent ellipsis) ======================
  // white-space:nowrap + scrollWidth>clientWidth = the label is being cut with an
  // ellipsis the user can't see past. data-ellipsis-ok marks intentional cases.
  for (const el of all) {
    if (!isVisible(el)) continue;
    if (el.dataset.ellipsisOk != null) continue;
    // A clipped label that exposes its FULL text via a native `title` tooltip
    // (on itself or an enclosing row) is not a SILENT truncation — the user can
    // read the whole value — and the gate targets SILENT ellipsis. Walk a few
    // ancestors so a row-level title (the common chart/list pattern) exempts its
    // label child.
    let titled = false;
    for (let a: Element | null = el, hops = 0; a && hops < 4; a = a.parentElement, hops++) {
      if (a.getAttribute("title")) { titled = true; break; }
    }
    if (titled) continue;
    const cs = getComputedStyle(el);
    if (cs.whiteSpace !== "nowrap") continue;
    const delta = el.scrollWidth - el.clientWidth;
    if (delta <= 1) continue; // 1px tolerance for sub-pixel rounding
    // The element must actually CLIP its overflow (overflow-x hidden/clip) for an
    // ellipsis to appear — a nowrap element whose content scrolls (auto/scroll)
    // shows the full text by scrolling, not a silent ellipsis.
    const ox = getComputedStyle(el).overflowX;
    if (ox !== "hidden" && ox !== "clip") continue;
    const text = (el.textContent || "").trim().slice(0, 40);
    out.push(`[no-truncation] ${idOf(el)} clipped ${delta}px ("${text}")`);
  }

  // ===== Family 3: header-aligned (段差) ==================================
  // Within each WorkareaHeader band the row cells (data-wah-cell) sit on one
  // line. The band is align-items:center, so "on one row" means their vertical
  // CENTRES line up; a nudged cell (e.g. a stray margin-top) shifts its centre
  // and reads as a visible step (段差). Comparing centres (not box tops) is
  // robust to cells of different content height — the very thing the centered
  // band normalizes — so only a real misalignment trips it.
  const headers = Array.from(document.querySelectorAll<HTMLElement>(".lds-wh"));
  for (const header of headers) {
    const cells = Array.from(header.querySelectorAll<HTMLElement>("[data-wah-cell]")).filter(isVisible);
    if (cells.length < 2) continue;
    const centers = cells.map((c) => {
      const r = c.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    const spread = Math.max(...centers) - Math.min(...centers);
    if (spread > 1) {
      const detail = cells
        .map((c, i) => `${c.getAttribute("data-wah-cell")}:${centers[i].toFixed(0)}`)
        .join(" ");
      out.push(`[header-aligned] ${idOf(header)} center-spread=${spread.toFixed(1)}px (${detail})`);
    }
  }

  // ===== Family 4: no-overlap (header title vs actions) =================
  // The old bug: the actions cluster overlapped the title. Assert the two
  // header-cell AABBs do NOT intersect, AND the title's centre is not occluded
  // (elementFromPoint — NOT isVisible, which returns true through an overlay).
  const intersects = (a: DOMRect, b: DOMRect): boolean =>
    !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  for (const header of headers) {
    const titleCell = header.querySelector<HTMLElement>('[data-wah-cell="titles"]');
    const actionsCell = header.querySelector<HTMLElement>('[data-wah-cell="actions"]');
    if (titleCell && actionsCell && isVisible(titleCell) && isVisible(actionsCell)) {
      const a = titleCell.getBoundingClientRect();
      const b = actionsCell.getBoundingClientRect();
      if (intersects(a, b)) {
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        out.push(`[no-overlap] titles∩actions in ${idOf(header)} x-overlap=${overlapX.toFixed(1)}px`);
      }
    }
    // occlusion: the visible title text must be the hit target at its own centre.
    const titleText = header.querySelector<HTMLElement>('[data-testid="lds-wh-title"], [data-testid="sessbar-title"]');
    if (titleText && isVisible(titleText)) {
      const r = titleText.getBoundingClientRect();
      const cx = Math.round(r.left + Math.min(r.width / 2, 8)); // near the start of the text
      const cy = Math.round(r.top + r.height / 2);
      const hit = document.elementFromPoint(cx, cy);
      if (hit && hit !== titleText && !titleText.contains(hit) && !hit.contains(titleText)) {
        out.push(`[no-overlap] ${idOf(titleText)} occluded at (${cx},${cy}) by ${idOf(hit)}`);
      }
    }
  }

  // ===== Family 5: fits-container ========================================
  // Key panels' child rect must sit inside its parent rect (1px tolerance).
  // Catches a child spilling out of a cramped panel.
  const fitPairs: Array<[string, string]> = [];
  if (masterDetail) {
    fitPairs.push([`[data-testid="${masterDetail.list}"]`, `[data-testid="${masterDetail.list}"] > *`]);
    fitPairs.push([`[data-testid="${masterDetail.detail}"]`, `[data-testid="${masterDetail.detail}"] > *`]);
  }
  // the WorkareaHeader cells must fit the header band.
  fitPairs.push([".lds-wh", ".lds-wh > [data-wah-cell]"]);
  for (const [parentSel, childSel] of fitPairs) {
    const parent = document.querySelector<HTMLElement>(parentSel);
    if (!parent || !isVisible(parent)) continue;
    const pcs = getComputedStyle(parent);
    // A scroll pane legitimately holds content larger than its box ON ITS SCROLL
    // AXIS (that's what scrolling is for). Only check an axis the parent does NOT
    // scroll, so "child spills parent" means a real cramped/spillout layout, not
    // normal scroll content. (cramped/spillout is fundamentally the cross-axis.)
    const scrollsY = pcs.overflowY === "auto" || pcs.overflowY === "scroll";
    const scrollsX = pcs.overflowX === "auto" || pcs.overflowX === "scroll";
    const p = parent.getBoundingClientRect();
    const children = Array.from(document.querySelectorAll<HTMLElement>(childSel)).filter(
      (c) => isVisible(c) && parent.contains(c),
    );
    for (const child of children) {
      const c = child.getBoundingClientRect();
      const spill: string[] = [];
      if (!scrollsX && c.left < p.left - 1) spill.push(`left ${(p.left - c.left).toFixed(1)}`);
      if (!scrollsX && c.right > p.right + 1) spill.push(`right ${(c.right - p.right).toFixed(1)}`);
      if (!scrollsY && c.top < p.top - 1) spill.push(`top ${(p.top - c.top).toFixed(1)}`);
      if (!scrollsY && c.bottom > p.bottom + 1) spill.push(`bottom ${(c.bottom - p.bottom).toFixed(1)}`);
      if (spill.length > 0) {
        out.push(`[fits-container] ${idOf(child)} spills ${parentSel} by ${spill.join(", ")}px`);
      }
    }
  }

  // ===== Family 6: detail-wider-than-list ================================
  // Master-detail surfaces encode "wide detail" (layout-architecture.md row #6).
  // SIDE-BY-SIDE: the detail pane must be strictly WIDER than the list pane (the
  // detail is the dominant column). STACKED (narrow widths, where the panes drop
  // into one column): "wider" no longer applies — the detail must instead be at
  // least as wide as the list (i.e. both span the column, detail never narrower).
  // The arrangement is read from the rects: stacked = detail starts below the
  // list's bottom; otherwise side-by-side.
  if (masterDetail) {
    const list = document.querySelector<HTMLElement>(`[data-testid="${masterDetail.list}"]`);
    const detail = document.querySelector<HTMLElement>(`[data-testid="${masterDetail.detail}"]`);
    if (list && detail && isVisible(list) && isVisible(detail)) {
      const lr = list.getBoundingClientRect();
      const dr = detail.getBoundingClientRect();
      const stacked = dr.top >= lr.bottom - 1; // detail sits below the list
      if (stacked) {
        if (dr.width < lr.width - 1) {
          out.push(`[detail-wider-than-list] (stacked) detail(${masterDetail.detail})=${dr.width.toFixed(1)}px < list(${masterDetail.list})=${lr.width.toFixed(1)}px`);
        }
      } else if (!(dr.width > lr.width)) {
        out.push(`[detail-wider-than-list] detail(${masterDetail.detail})=${dr.width.toFixed(1)}px <= list(${masterDetail.list})=${lr.width.toFixed(1)}px`);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// a11y (Family 7): axe-core, ONLY color-contrast + target-size. Returns the
// per-rule violation count + node fingerprints so the run REPORTS them (the
// auditor decides scope); the test wires an assertion that gates once clean.
// ---------------------------------------------------------------------------
type AxeResult = { rule: string; count: number; nodes: string[] };

async function runAxe(page: Page): Promise<AxeResult[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const raw = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } }).axe;
    const res = (await axe.run(document, {
      runOnly: { type: "rule", values: ["color-contrast", "target-size"] },
      resultTypes: ["violations"],
    })) as { violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> };
    return res.violations.map((v) => ({
      rule: v.id,
      count: v.nodes.length,
      nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
  });
  return raw as AxeResult[];
}

// ---------------------------------------------------------------------------
// One test per surface. The whole file runs at BOTH widths automatically (two
// Playwright projects). The viewport width is read from the project so the
// report tells you WHICH width a violation fired at.
// ---------------------------------------------------------------------------
test.describe("layout-integrity", () => {
  let sid = "";
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    sid = await discoverSessionId(page);
    await page.close();
  });

  for (const surface of SURFACES) {
    test(`${surface.name} — layout invariants`, async ({ page }, testInfo) => {
      const width = page.viewportSize()?.width ?? 0;
      await page.goto(surface.build(sid));
      await settle(page);

      const violations = await page.evaluate(collectViolations, {
        masterDetail: surface.masterDetail ?? null,
      });

      // Prefix each line with the surface + width so a CI failure is unambiguous.
      const tagged = violations.map((v) => `${surface.name} @${width}px ${v}`);
      if (tagged.length > 0) {
        // eslint-disable-next-line no-console
        console.error(`\nLAYOUT VIOLATIONS — ${surface.name} @${width}px:\n` + tagged.join("\n") + "\n");
      }
      expect(tagged, `layout violations on ${surface.name} @${width}px`).toEqual([]);

      // ---- a11y: REPORT counts (color-contrast + target-size) -----------
      const axe = await runAxe(page);
      const a11yLines = axe.map((r) => `${r.rule}=${r.count} [${r.nodes.join(" | ")}]`);
      // eslint-disable-next-line no-console
      console.log(`A11Y — ${surface.name} @${width}px: ${a11yLines.length ? a11yLines.join("; ") : "color-contrast=0; target-size=0"}`);
      testInfo.annotations.push({
        type: "a11y",
        description: `${surface.name} @${width}px :: ${a11yLines.join("; ") || "clean"}`,
      });
      // Gate wiring: HARD. The baseline is driven to ZERO across all 7 surfaces
      // × 2 widths (color-contrast AA + target-size 24px). The last residual —
      // /diff's .le-jump back-link below the 24px tap-target minimum — is grown
      // to a ≥24px box (--amber-text was already AA-floored to #8a6113 ≈5.0:1 on
      // --amber-bg upstream). Any NEW color-contrast or target-size violation on
      // any surface now fails the gate.
      const totalA11y = axe.reduce((n, r) => n + r.count, 0);
      expect(totalA11y, `a11y (color-contrast+target-size) on ${surface.name} @${width}px`).toBe(0);
    });
  }
});
