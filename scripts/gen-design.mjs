#!/usr/bin/env node
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const root = new URL("../", import.meta.url);
const designPath = new URL("apps/web/design-system/DESIGN.md", root);
const tokensPath = new URL("apps/web/design-system/tokens.css", root);
const contractsDir = new URL("apps/web/design-system/contracts/", root);

const START_MARKER_RE = /^<!-- generated:start.*-->$/m;
const END_MARKER_RE = /^<!-- generated:end -->$/m;

function readText(url) {
  return readFileSync(url, "utf8");
}

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function code(value) {
  return `\`${markdownEscape(value)}\``;
}

function normalizeCssValue(value) {
  return value.replace(/\s+/g, " ").trim();
}

function extractCustomProperties(css) {
  const declarations = [];
  const declarationRe = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  for (const match of css.matchAll(declarationRe)) {
    declarations.push({
      name: match[1],
      value: normalizeCssValue(match[2]),
    });
  }
  return declarations;
}

function spacingRank(token) {
  const match = token.name.match(/^--sp-(\d+)$/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function colorSemanticGroup(name) {
  if (/^--(?:bg|panel|sidebar-bg|surface)/.test(name)) return "surface";
  if (/^--(?:border|divider|scrollbar)/.test(name)) return "border / chrome";
  if (/^--(?:text|muted|on-accent)/.test(name)) return "text";
  if (/^--(?:accent|focus-ring)/.test(name)) return "accent / focus";
  if (/^--(?:green|add|red|del|amber|gray-chip)/.test(name)) return "status";
  if (/^--(?:cat|chart|json)-/.test(name)) return "category / data";
  if (/^--c-/.test(name)) return "event alias";
  if (/^--k-/.test(name)) return "kind alias";
  if (/^--r-/.test(name)) return "runner";
  return null;
}

function extractTokenSummary(css) {
  const declarations = extractCustomProperties(css);
  const spacing = declarations
    .filter((token) => /^--sp-\d+$/.test(token.name))
    .sort((a, b) => spacingRank(a) - spacingRank(b) || a.name.localeCompare(b.name));

  const colorSemantic = declarations
    .map((token) => ({ ...token, group: colorSemanticGroup(token.name) }))
    .filter((token) => token.group)
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

  return { spacing, colorSemantic };
}

function formatSpacingTable(spacing) {
  const rows = [
    "| Token | Value |",
    "|---|---|",
    ...spacing.map((token) => `| ${code(token.name)} | ${code(token.value)} |`),
  ];
  return rows.join("\n");
}

function formatTokenGroups(tokens) {
  const groupOrder = [
    "surface",
    "border / chrome",
    "text",
    "accent / focus",
    "status",
    "category / data",
    "event alias",
    "kind alias",
    "runner",
  ];
  const tokensByGroup = new Map();
  for (const group of groupOrder) tokensByGroup.set(group, []);
  for (const token of tokens) {
    tokensByGroup.get(token.group).push(token);
  }

  const rows = [
    "| Group | Tokens |",
    "|---|---|",
    ...groupOrder
      .filter((group) => tokensByGroup.get(group).length > 0)
      .map((group) => {
        const renderedTokens = tokensByGroup
          .get(group)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((token) => `${code(token.name)}=${code(token.value)}`)
          .join("<br>");
        return `| ${markdownEscape(group)} | ${renderedTokens} |`;
      }),
  ];
  return rows.join("\n");
}

function contractFiles() {
  if (!existsSync(contractsDir)) {
    throw new Error("contracts directory not found");
  }
  return readdirSync(contractsDir)
    .filter((name) => name.endsWith(".contract.json"))
    .sort((a, b) => a.localeCompare(b));
}

function formatAxisValues(values) {
  if (!Array.isArray(values)) return code(String(values));
  return values.map((value) => code(value)).join(", ");
}

function formatAxes(axes) {
  const entries = Object.entries(axes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "none";
  return entries
    .map(([axis, values]) => `${code(axis)}: ${formatAxisValues(values)}`)
    .join("<br>");
}

function formatStates(states) {
  if (!Array.isArray(states) || states.length === 0) return "none";
  return states.map(code).join(", ");
}

function extractComponentCatalog() {
  return contractFiles()
    .map((filename) => {
      const url = new URL(filename, contractsDir);
      const contract = JSON.parse(readText(url));
      return {
        component: contract.component ?? filename.replace(/\.contract\.json$/, ""),
        summary: contract.summary ?? "",
        axes: contract.axes ?? {},
        states: contract.states ?? [],
      };
    })
    .sort((a, b) => a.component.localeCompare(b.component));
}

function formatComponentCatalog(components) {
  const rows = [
    "| Component | Summary | Axes | States |",
    "|---|---|---|---|",
    ...components.map((component) => [
      code(component.component),
      markdownEscape(component.summary),
      formatAxes(component.axes),
      formatStates(component.states),
    ].join(" | ")).map((row) => `| ${row} |`),
  ];
  return rows.join("\n");
}

function generatedMarkdown() {
  const { spacing, colorSemantic } = extractTokenSummary(readText(tokensPath));
  const components = extractComponentCatalog();
  return [
    "## Generated Reference",
    "",
    "Source files: `apps/web/design-system/tokens.css` and `apps/web/design-system/contracts/*.contract.json`.",
    "",
    "### Spacing Scale",
    "",
    formatSpacingTable(spacing),
    "",
    "### Color / Semantic Tokens",
    "",
    formatTokenGroups(colorSemantic),
    "",
    "### Component Contracts",
    "",
    formatComponentCatalog(components),
    "",
  ].join("\n");
}

function replaceGeneratedBlock(design, generated) {
  const startMatch = design.match(START_MARKER_RE);
  const endMatch = design.match(END_MARKER_RE);
  if (!startMatch || !endMatch) {
    throw new Error("generated markers not found in DESIGN.md");
  }
  if (endMatch.index <= startMatch.index) {
    throw new Error("generated end marker appears before start marker");
  }

  const startLineEnd = startMatch.index + startMatch[0].length;
  return `${design.slice(0, startLineEnd)}\n${generated}${design.slice(endMatch.index)}`;
}

const currentDesign = readText(designPath);
const nextDesign = replaceGeneratedBlock(currentDesign, generatedMarkdown());

if (nextDesign !== currentDesign) {
  writeFileSync(designPath, nextDesign);
}
