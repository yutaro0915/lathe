import { useEffect, useRef, useState } from "react";
import type { TranscriptEvent } from "@/lib/types";

const LS_PINS = "lathe.pins";
const LS_NOTES = "lathe.notes";

// usePersistentAnnotations — pins, notes, noteDraft, copied + localStorage
// persistence and related handlers. Extracted from SessionViewer (file-size I4).
export function usePersistentAnnotations(selected: TranscriptEvent | undefined) {
  const [pins, setPins] = useState<Set<string>>(() => new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted pins/notes on mount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const rawPins = window.localStorage.getItem(LS_PINS);
      if (rawPins) setPins(new Set(JSON.parse(rawPins) as string[]));
    } catch {}
    try {
      const rawNotes = window.localStorage.getItem(LS_NOTES);
      if (rawNotes) setNotes(JSON.parse(rawNotes) as Record<string, string>);
    } catch {}
  }, []);

  // Cleanup copyTimer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  function persistPins(next: Set<string>) {
    setPins(next);
    if (typeof window !== "undefined")
      window.localStorage.setItem(LS_PINS, JSON.stringify(Array.from(next)));
  }

  function persistNotes(next: Record<string, string>) {
    setNotes(next);
    if (typeof window !== "undefined")
      window.localStorage.setItem(LS_NOTES, JSON.stringify(next));
  }

  function copy(key: string, text: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard)
      navigator.clipboard.writeText(text).catch(() => {});
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 1200);
  }

  function togglePin() {
    if (!selected) return;
    const next = new Set(pins);
    next.has(selected.id) ? next.delete(selected.id) : next.add(selected.id);
    persistPins(next);
  }

  function openNoteEditor() {
    if (selected) setNoteDraft(notes[selected.id] ?? "");
  }

  function saveNote() {
    if (!selected || noteDraft == null) return;
    const next = { ...notes };
    const trimmed = noteDraft.trim();
    if (trimmed) next[selected.id] = trimmed;
    else delete next[selected.id];
    persistNotes(next);
    setNoteDraft(null);
  }

  return {
    pins,
    notes,
    noteDraft,
    setNoteDraft,
    copied,
    persistPins,
    persistNotes,
    copy,
    togglePin,
    openNoteEditor,
    saveNote,
  };
}
