// lib/agents/seller-conversion-copy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE copy for the SELLER-CONVERSION nurture — the seller-side mirror of the buyer welcome/nurture.
// A homeowner who asked "what's my home worth?" or signaled seller intent but HASN'T booked a listing
// appointment is the seller funnel's highest-drop point; competitors send a generic AVM email and go
// quiet. This is the warm, them-first floor (the gateway rewrites in the agent's voice): your home's
// latest value + a no-pressure invite to map what it could really sell for. Drives to the consult,
// never pushy, always routes to the agent. No I/O — unit-testable.

import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

/** PURE. Warm seller-conversion nudge. homeValue optional — when absent, lead with the conversation. */
export function buildSellerConversionMessage(
  firstName: string | null,
  homeValueEstimate: number | null,
): { subject: string; body: string } {
  const name = sanitizeProperNoun(firstName ?? "", 60) || "there"
  const valueLine = homeValueEstimate && homeValueEstimate > 0
    ? `Your home's latest estimated value is around $${Math.round(homeValueEstimate).toLocaleString()} — and what it would actually SELL for can be meaningfully different once we factor in your specific home and today's buyers.`
    : `I can pull your home's current value and what it would realistically sell for in today's market — it's often different from the online estimates.`
  return {
    subject: "Curious what your home could really sell for?",
    body: `Hi ${name} — no pressure at all, just keeping you in the loop. ${valueLine} Whenever you're even thinking about a move, I'll put together a quick, honest picture: your likely net proceeds, the best time to list, and what (if anything) is worth doing first. Want me to set that up? It's free and there's zero obligation.`,
  }
}
