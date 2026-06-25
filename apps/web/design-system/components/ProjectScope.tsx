"use client";

// design-system/components/ProjectScope.tsx — presentational project-scope
// breadcrumb dropdown. Routing and URL state live in components/TopBarProjectSelect.

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Pressable } from "@/design-system/components";
import { Icon } from "@/design-system/components/icons";

export interface ProjectScopeOption {
  value: string;
  label: string;
}

export interface ProjectScopeProps {
  options: ProjectScopeOption[];
  value: string;
  currentLabel: string;
  onValueChange: (value: string) => void;
  sessionLabel?: string | null;
}

export function ProjectScope({
  options,
  value,
  currentLabel,
  onValueChange,
  sessionLabel = null,
}: ProjectScopeProps) {
  return (
    <span className="lds-tb-scope" data-testid="topbar-scope" data-scope={value}>
      <span className="lds-tb-scope-sep" aria-hidden>
        /
      </span>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Pressable
            className="lds-tb-scope-trigger"
            data-testid="project-picker"
            data-value={value}
            aria-label="Project scope"
            title="Scope every section to one project"
          >
            <span className="lds-tb-scope-name" data-testid="topbar-scope-name">
              {currentLabel}
            </span>
            <span className="lds-tb-scope-ic" aria-hidden>
              <Icon name="chevronDown" size={13} />
            </span>
          </Pressable>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="lds-tb-scope-menu"
            data-testid="project-menu"
            aria-label="Project scope"
            align="start"
            sideOffset={4}
          >
            <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange} aria-label="Project scope">
              {options.map((o) => (
                <DropdownMenu.RadioItem
                  key={o.value}
                  className={`lds-tb-scope-opt${o.value === value ? " is-current" : ""}`}
                  data-testid="project-option"
                  data-project={o.value}
                  value={o.value}
                >
                  {o.label}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {sessionLabel != null ? (
        <>
          <span className="lds-tb-scope-sep" aria-hidden>
            /
          </span>
          <span
            className="lds-tb-scope-session"
            data-testid="topbar-session-name"
            title={sessionLabel}
          >
            {sessionLabel}
          </span>
        </>
      ) : null}
    </span>
  );
}
