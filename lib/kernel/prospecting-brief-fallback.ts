// lib/kernel/prospecting-brief-fallback.ts
//
// The deterministic fallback body for the contact-backed seller brief, in a module of its own (wave 147, integrator —
// proxy-graph budget). It was defined inside lib/kernel/listing-inventory-radar.ts, whose only external importer of it was
// the manager-signals hub: every page that reaches the hub pulled the whole radar (its service client, write sentinel,
// seller timeline and AI copy generator) to compose one string. The function is pure — it reads two fields of the scored
// lead — so it lives here and the radar's type is imported as a TYPE only, which the module walker does not follow.
// Survivor of the move: this file. The radar keeps a tombstone at the old location.
import type { ScoredSellerLead } from "./listing-inventory-radar"

/** Deterministic FALLBACK body for the CONTACT-BACKED seller brief (audience 'agent') — only
 *  ever composed when the owner is already a CRM contact (post-conversion, portal-eligible).
 *  Internal agent brief; the client-facing follow-up is the agent's gated next step. */
export function composeProspectingBriefFallback(lead: ScoredSellerLead): string {
  const addr = lead.propertyAddress ?? "a property we surfaced"
  return [
    `Seller-intent radar flagged ${addr} as a high-intent listing-inventory candidate (existing CRM contact).`,
    `Why now: ${lead.reasons.slice(0, 4).map((r) => r.replace(/\s*\([^)]*\)\s*$/, "")).join("; ") || "scored seller intent"}.`,
    `Suggested play: a "thinking of selling?" touch — open with the home's current market position. A gated CMA + a short listing/explainer reel are queued for your approval. Nothing sends until you approve it.`,
  ].join(" ")
}
