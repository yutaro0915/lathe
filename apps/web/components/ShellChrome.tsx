"use client";

import * as React from "react";
import { AppShell } from "@/design-system/components";

const KEY = "lathe.sidebar.collapsed";

export default function ShellChrome({
  topNav,
  sideNav,
  children,
}: {
  topNav: React.ReactNode;
  sideNav: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(KEY) === "1");
    } catch {}
  }, []);

  const toggle = React.useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  return (
    <AppShell collapsed={collapsed} onToggleCollapse={toggle} topNav={topNav} sideNav={sideNav}>
      {children}
    </AppShell>
  );
}
