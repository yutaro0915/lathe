// components/ds/index.tsx — Lathe Design System v1 React primitives (TypeScript).
//
// Faithful ports of the DS v1 bundle components (core / data / forms / layout),
// typed to each component's .d.ts contract. They apply the shipped `lds-*`
// classes from app/design-system/components.css — no inline colors/px, tokens
// only. Color stays rationed (neutral by default; semantic families only signal
// state). Import primitives from this barrel, never the individual files.

import * as React from "react";

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
      {icon ? <span className="lds-btn__icon" aria-hidden="true">{icon}</span> : null}
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
      {dot ? <span className="lds-badge__dot" style={dotColor ? { background: dotColor } : undefined} /> : null}
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
      {glyph ? <span className="lds-search__icon" aria-hidden="true">{glyph}</span> : null}
      <input type="search" placeholder={placeholder} {...rest} />
      {kbd ? <span className="lds-kbd">{kbd}</span> : null}
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
      <span className="lds-caret" aria-hidden="true">▾</span>
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
      <span className="lds-metric__value">
        {value}
        {sub ? <span style={{ color: "var(--muted-2)", fontWeight: 400 }}>{sub}</span> : null}
      </span>
      <span className="lds-metric__label">{label}</span>
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
      <span className="lds-minibar__label">{label}</span>
      <span className="lds-minibar__track">
        <span className="lds-minibar__fill" style={{ width: `${width}%`, background: color || undefined }} />
      </span>
      <span className="lds-minibar__value">{value}</span>
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

/* ---- RunnerPill ---------------------------------------------------------- */
const RUNNER_COLORS: Record<string, string> = {
  "claude-code": "var(--r-claude)",
  claude: "var(--r-claude)",
  codex: "var(--r-codex)",
  cursor: "var(--r-cursor)",
};
export interface RunnerPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  runner: string;
  label?: React.ReactNode;
}
export function RunnerPill({ runner, label, className = "", ...rest }: RunnerPillProps) {
  const key = String(runner || "").toLowerCase().replace(/\s+/g, "-");
  const color = RUNNER_COLORS[key] || "var(--cat-uncertain)";
  return (
    <span className={`lds-runner ${className}`.trim()} {...rest}>
      <span className="lds-runner__dot" style={{ background: color }} />
      {label ?? runner}
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
        <header className="lds-panel__head">
          {title ? (
            <span className="lds-panel__title">
              {title}
              {count != null ? <span className="lds-panel__count">{` ${count}`}</span> : null}
              {sub ? <span className="lds-panel__sub">{` — ${sub}`}</span> : null}
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
          className={`lds-tab ${t.value === value ? "is-active" : ""}`}
          onClick={() => onChange && onChange(t.value)}
        >
          {t.label}
          {t.count != null ? <span className="lds-tab__count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
