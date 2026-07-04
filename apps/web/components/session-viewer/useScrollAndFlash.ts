import { useEffect, useRef, useState } from "react";
import type { Tab } from "./types";

// useScrollAndFlash — scroll-request mechanics and flash-highlight state.
// Manages the imperative scrollIntoView coordination (requestScrollToEvent +
// scrollRequestId state) and the flash-highlight timer. Extracted from
// SessionViewer (file-size I4).
export function useScrollAndFlash({
  activeTab,
  selectedEventId,
}: {
  activeTab: Tab;
  selectedEventId: string | undefined;
}) {
  const [scrollRequestId, setScrollRequestId] = useState(0);
  const [flashEventId, setFlashEventId] = useState<string | null>(null);
  const scrollTarget = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousActiveTab = useRef(activeTab);

  function requestScrollToEvent(eventId: string) {
    scrollTarget.current = eventId;
    setScrollRequestId((id) => id + 1);
  }

  function flashStep(eventId: string) {
    setFlashEventId(eventId);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashEventId(null), 2200);
  }

  // Scroll the target event into view on every new scroll request.
  useEffect(() => {
    const eventId = scrollTarget.current;
    if (!eventId || typeof document === "undefined" || typeof CSS === "undefined" || !CSS.escape)
      return;
    const raf = requestAnimationFrame(() =>
      document.querySelector(`[data-eid="${CSS.escape(eventId)}"]`)?.scrollIntoView({ block: "center" }),
    );
    return () => cancelAnimationFrame(raf);
  }, [scrollRequestId]);

  // Re-scroll to the selected event when the active tab changes.
  useEffect(() => {
    if (previousActiveTab.current !== activeTab && selectedEventId)
      requestScrollToEvent(selectedEventId);
    previousActiveTab.current = activeTab;
  }, [activeTab, selectedEventId]);

  // Cleanup flashTimer on unmount.
  useEffect(() => {
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  return { flashEventId, flashStep, requestScrollToEvent };
}
