// JumpLandingBanner.tsx — the "JUMPED TO STEP N / THIS SESSION" banner shown at
// the top of the transcript-family body when the viewer is entered via a finding
// or a ?seq deep link. Extracted so SessionViewer renders it once (it appears in
// both the transcript master-detail body and the list+inspector body).

import { Pressable } from "@/design-system/components";

type Landing = { seq: number | null; fromFinding: number | null };

export function JumpLandingBanner({ landing, onDismiss }: { landing: Landing | null; onDismiss: () => void }) {
  if (!landing || (landing.fromFinding == null && landing.seq == null)) return null;
  return (
    <div className="jump-landing-banner" data-testid="jump-landing-banner" data-from-finding={landing.fromFinding ?? undefined}>
      <span className="jump-landing-dot" data-testid="jump-landing-dot" aria-hidden>▸</span>
      <span className="jump-landing-text mono" data-testid="jump-landing-text">
        {landing.seq != null ? `JUMPED TO STEP ${landing.seq}` : "JUMPED TO THIS SESSION"}
        {landing.fromFinding != null ? ` — from finding #${landing.fromFinding}` : ""}
      </span>
      <Pressable type="button" className="jump-landing-dismiss" data-testid="jump-landing-dismiss" title="Dismiss" aria-label="Dismiss landing banner" onClick={onDismiss}>✕</Pressable>
    </div>
  );
}
