// design-system/components/index.tsx — Lathe Design System v1 React primitives (TypeScript).
//
// Faithful ports of the DS v1 bundle components (core / data / forms / layout),
// typed to each component's .d.ts contract. They apply the shipped `lds-*`
// classes from design-system/components.css — no inline colors/px, tokens
// only. Color stays rationed (neutral by default; semantic families only signal
// state). Import primitives from this barrel, never the individual files.

import * as React from "react";

export { AppShell } from "./AppShell";
export type { AppShellProps } from "./AppShell";
export { default as Surface } from "./Surface";
export type { SurfaceProps } from "./Surface";
export { SideNav } from "./SideNav";
export type { SideNavProps, SideNavItem, SideNavUser } from "./SideNav";
export { Header } from "./Header";
export type { HeaderProps } from "./Header";

/* ---- Pressable ----------------------------------------------------------- */
export interface PressableProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children?: React.ReactNode;
  className?: string;
  [ariaAttribute: `aria-${string}`]: string | number | boolean | undefined;
  [dataAttribute: `data-${string}`]: string | number | boolean | undefined;
}
export function Pressable({ className = "", children, ...rest }: PressableProps) {
  return (
    <button type="button" className={`lds-pressable ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}

/* ---- Button -------------------------------------------------------------- */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "primary" | "ghost" | "danger";
  size?: "md" | "sm";
  icon?: React.ReactNode;
}
export function Button({
  variant = "default",
  size = "md",
  icon = null,
  type = "button",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  const cls = [
    "lds-btn",
    variant !== "default" ? `lds-btn--${variant}` : "",
    size === "sm" ? "lds-btn--sm" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {icon ? <span className="lds-btn__icon" data-testid="lds-btn__icon" aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}
export function IconButton({ label, className = "", children, ...rest }: IconButtonProps) {
  return (
    <button type="button" className={`lds-iconbtn ${className}`.trim()} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

/* ---- Badge --------------------------------------------------------------- */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: "default" | "ok" | "warn" | "err" | "neutral" | "accent";
  dot?: boolean;
  dotColor?: string;
}
export function Badge({ tone = "default", dot = false, dotColor, className = "", children, ...rest }: BadgeProps) {
  const cls = ["lds-badge", tone !== "default" ? `lds-badge--${tone}` : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...rest}>
      {dot ? <span className="lds-badge__dot" data-testid="lds-badge__dot" style={dotColor ? { background: dotColor } : undefined} /> : null}
      {children}
    </span>
  );
}

/* ---- Chip ---------------------------------------------------------------- */
export interface ChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  kind?: "default" | "hash" | "cost" | "token";
}
export function Chip({ kind = "default", className = "", children, ...rest }: ChipProps) {
  const cls = ["lds-chip", kind !== "default" ? `lds-chip--${kind}` : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}

/* ---- Segmented ----------------------------------------------------------- */
export interface SegmentedOption {
  value: string;
  label: React.ReactNode;
}
export interface SegmentedProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  options: (string | SegmentedOption)[];
  value: string;
  onChange?: (value: string) => void;
}
export function Segmented({ options = [], value, onChange, className = "", ...rest }: SegmentedProps) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <div className={`lds-segmented ${className}`.trim()} role="tablist" {...rest}>
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          className={o.value === value ? "is-active" : ""}
          onClick={() => onChange && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---- SearchInput --------------------------------------------------------- */
const SearchGlyph = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.1"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ display: "block", flex: "0 0 auto" }}
  >
    <circle cx="11" cy="11" r="7" />
    <line x1="20" y1="20" x2="16.2" y2="16.2" />
  </svg>
);
export interface SearchInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  kbd?: React.ReactNode;
  icon?: React.ReactNode;
}
export function SearchInput({ placeholder = "Search…", kbd, icon, className = "", ...rest }: SearchInputProps) {
  const glyph = icon === undefined ? <SearchGlyph /> : icon;
  return (
    <label className={`lds-search ${className}`.trim()}>
      {glyph ? <span className="lds-search__icon" data-testid="lds-search__icon" aria-hidden="true">{glyph}</span> : null}
      <input type="search" placeholder={placeholder} {...rest} />
      {kbd ? <span className="lds-kbd" data-testid="lds-kbd">{kbd}</span> : null}
    </label>
  );
}

/* ---- Select -------------------------------------------------------------- */
export interface SelectOption {
  value: string;
  label: React.ReactNode;
}
export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value"> {
  value: string;
  options: (string | SelectOption)[];
}
export function Select({ value, onChange, options = [], className = "", ...rest }: SelectProps) {
  const opts = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return (
    <span className={`lds-select ${className}`.trim()}>
      <select value={value} onChange={onChange} {...rest}>
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="lds-caret" data-testid="lds-caret" aria-hidden="true">▾</span>
    </span>
  );
}

/* ---- Checkbox ------------------------------------------------------------ */
export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: React.ReactNode;
  trailing?: React.ReactNode;
}
export function Checkbox({ checked, onChange, label, trailing = null, className = "", ...rest }: CheckboxProps) {
  return (
    <label className={`lds-check ${className}`.trim()}>
      <input type="checkbox" checked={checked} onChange={onChange} {...rest} />
      <span>{label}</span>
      {trailing}
    </label>
  );
}

/* ---- MetricStat ---------------------------------------------------------- */
export interface MetricStatProps extends React.HTMLAttributes<HTMLDivElement> {
  value: React.ReactNode;
  label: React.ReactNode;
  sub?: React.ReactNode;
  layout?: "stack" | "inline";
}
export function MetricStat({ value, label, sub, layout = "stack", className = "", ...rest }: MetricStatProps) {
  return (
    <div className={`lds-metric ${layout === "inline" ? "lds-metric--inline" : ""} ${className}`.trim()} {...rest}>
      <span className="lds-metric__value" data-testid="lds-metric__value">
        {value}
        {sub ? <span style={{ color: "var(--muted-2)", fontWeight: 400 }}>{sub}</span> : null}
      </span>
      <span className="lds-metric__label" data-testid="lds-metric__label">{label}</span>
    </div>
  );
}

/* ---- MiniBar ------------------------------------------------------------- */
export interface MiniBarProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  value: React.ReactNode;
  pct?: number;
  color?: string;
  labelWidth?: string;
}
export function MiniBar({ label, value, pct, color, labelWidth, className = "", ...rest }: MiniBarProps) {
  const width = Math.max(0, Math.min(100, pct ?? 0));
  const style = labelWidth ? ({ "--label-w": labelWidth } as React.CSSProperties) : undefined;
  return (
    <div className={`lds-minibar ${className}`.trim()} style={style} {...rest}>
      <span className="lds-minibar__label" data-testid="lds-minibar__label">{label}</span>
      <span className="lds-minibar__track" data-testid="lds-minibar__track">
        <span className="lds-minibar__fill" data-testid="lds-minibar__fill" style={{ width: `${width}%`, background: color || undefined }} />
      </span>
      <span className="lds-minibar__value" data-testid="lds-minibar__value">{value}</span>
    </div>
  );
}

/* ---- ConfidenceChip ------------------------------------------------------ */
export interface ConfidenceChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  level?: "high" | "medium" | "unattributed";
}
export function ConfidenceChip({ level = "unattributed", children, className = "", ...rest }: ConfidenceChipProps) {
  const label = children ?? level;
  return (
    <span className={`lds-conf lds-conf--${level} ${className}`.trim()} {...rest}>
      {label}
    </span>
  );
}

/* ---- RunnerIcon ---------------------------------------------------------- */
// D4: agent (runner) is identified by COLOR + SHAPE, never spelled-out text. A
// fixed square chip carries the runner's brand color (var(--r-*) token) with a
// short monogram glyph in --on-accent; the full runner name lives in the `title`
// attribute (the only place the name appears). One reusable primitive replaces
// the dot+TEXT RunnerPill and the scattered text runner badges, so every surface
// reads runner identity the same way (Sessions / Subagents / Stats / PR).
const RUNNER_META: Record<string, { color: string; mono: string; name: string }> = {
  "claude-code": { color: "var(--r-claude)", mono: "C", name: "Claude Code" },
  claude: { color: "var(--r-claude)", mono: "C", name: "Claude Code" },
  codex: { color: "var(--r-codex)", mono: "Co", name: "Codex" },
  cursor: { color: "var(--r-cursor)", mono: "Cu", name: "Cursor" },
};
export interface RunnerIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  runner: string;
  /** Square edge in px (default 18). Radius is the token --radius-xs (4px). */
  size?: number;
}
export function RunnerIcon({ runner, size = 18, className = "", style, ...rest }: RunnerIconProps) {
  const key = String(runner || "").toLowerCase().replace(/\s+/g, "-");
  const meta = RUNNER_META[key];
  const color = meta?.color ?? "var(--cat-uncertain)";
  const mono = meta?.mono ?? "?";
  const name = meta?.name ?? (runner || "unknown runner");
  return (
    // role="img" + aria-label: the chip is a brand GRAPHIC whose accessible name
    // is the full runner name; the monogram glyph is just the picture. The fill
    // tokens are AA-floored so the white (--on-accent) glyph still clears 4.5:1.
    <span
      className={`lds-runner-icon ${className}`.trim()}
      role="img"
      title={name}
      aria-label={name}
      style={{ width: size, height: size, background: color, ...style }}
      {...rest}
    >
      {mono}
    </span>
  );
}

/* ---- Panel --------------------------------------------------------------- */
export interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  title?: React.ReactNode;
  count?: React.ReactNode;
  sub?: React.ReactNode;
  action?: React.ReactNode;
  bodyClassName?: string;
}
export function Panel({ title, count, sub, action, children, className = "", bodyClassName = "", ...rest }: PanelProps) {
  return (
    <section className={`lds-panel ${className}`.trim()} {...rest}>
      {(title || action) && (
        <header className="lds-panel__head" data-testid="lds-panel__head">
          {title ? (
            <span className="lds-panel__title" data-testid="lds-panel__title">
              {title}
              {count != null ? <span className="lds-panel__count" data-testid="lds-panel__count">{` ${count}`}</span> : null}
              {sub ? <span className="lds-panel__sub" data-testid="lds-panel__sub">{` — ${sub}`}</span> : null}
            </span>
          ) : null}
          {action ? <span style={{ marginLeft: "auto" }}>{action}</span> : null}
        </header>
      )}
      <div className={`lds-panel__body ${bodyClassName}`.trim()}>{children}</div>
    </section>
  );
}

/* ---- TabBar -------------------------------------------------------------- */
export interface TabItem {
  value: string;
  label: React.ReactNode;
  count?: React.ReactNode;
}
export interface TabBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  tabs: (string | TabItem)[];
  value: string;
  onChange?: (value: string) => void;
}
export function TabBar({ tabs = [], value, onChange, className = "", ...rest }: TabBarProps) {
  const items = tabs.map((t) => (typeof t === "string" ? { value: t, label: t } : t));
  return (
    <div className={`lds-tabs ${className}`.trim()} role="tablist" {...rest}>
      {items.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          className={`lds-tab ${t.value === value ? "is-active" : ""}`} data-testid="lds-tab"
          onClick={() => onChange && onChange(t.value)}
        >
          {t.label}
          {t.count != null ? <span className="lds-tab__count" data-testid="lds-tab__count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ---- Layout primitives (Stack / Box / Inline) ---------------------------- */
// Frames that OWN spacing + containment. Each sets gap/padding from --sp-* tokens
// (passed via a CSS custom property, like MiniBar's --label-w) and forces
// min-width:0 on itself and its direct children, so content cannot blow the frame
// out — the structural fix for overflow / uneven internal spacing. Children just
// fill the frame; they do not set their own margins. `as` lets a shell use a
// semantic element (nav / header / aside / ul) while keeping the same containment.
type SpaceToken = 0 | 4 | 8 | 12 | 16 | 20 | 24 | 32;

type StackEl = "div" | "section" | "ul" | "nav" | "header" | "footer" | "aside" | "main";
export interface StackProps extends React.HTMLAttributes<HTMLElement> {
  direction?: "col" | "row";
  gap?: SpaceToken;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  as?: StackEl;
}
export function Stack({ direction = "col", gap, align, justify, wrap = false, as = "div", className = "", style, children, ...rest }: StackProps) {
  const cls = [
    "lds-stack",
    direction === "row" ? "lds-stack--row" : "",
    align ? `lds-stack--align-${align}` : "",
    justify ? `lds-stack--justify-${justify}` : "",
    wrap ? "lds-stack--wrap" : "",
    className,
  ].filter(Boolean).join(" ");
  const st = gap != null ? ({ "--lds-stack-gap": `var(--sp-${gap})`, ...style } as React.CSSProperties) : style;
  return React.createElement(as, { className: cls, style: st, ...rest }, children);
}

type BoxEl = "div" | "section" | "article" | "aside" | "main";
export interface BoxProps extends React.HTMLAttributes<HTMLElement> {
  pad?: SpaceToken;
  overflow?: "visible" | "hidden" | "auto";
  surface?: boolean;
  as?: BoxEl;
}
export function Box({ pad, overflow, surface = false, as = "div", className = "", style, children, ...rest }: BoxProps) {
  const cls = [
    "lds-box",
    overflow ? `lds-box--ovf-${overflow}` : "",
    surface ? "lds-box--surface" : "",
    className,
  ].filter(Boolean).join(" ");
  const st = pad != null ? ({ "--lds-box-pad": `var(--sp-${pad})`, ...style } as React.CSSProperties) : style;
  return React.createElement(as, { className: cls, style: st, ...rest }, children);
}

type InlineEl = "div" | "span" | "ul";
export interface InlineProps extends React.HTMLAttributes<HTMLElement> {
  gap?: SpaceToken;
  align?: "start" | "center" | "end" | "baseline";
  as?: InlineEl;
}
export function Inline({ gap, align, as = "div", className = "", style, children, ...rest }: InlineProps) {
  const cls = [
    "lds-inline",
    align ? `lds-inline--align-${align}` : "",
    className,
  ].filter(Boolean).join(" ");
  const st = gap != null ? ({ "--lds-inline-gap": `var(--sp-${gap})`, ...style } as React.CSSProperties) : style;
  return React.createElement(as, { className: cls, style: st, ...rest }, children);
}
