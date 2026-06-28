// lib/agents/seller-conversion-eligibility.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE eligibility predicate for the seller-conversion nurture — split out of the server-only runner
// so it's unit-testable. An un-converted seller is a contact who showed selling intent (asked their
// home value / declared seller) and whom we do NOT already represent on an active listing. No I/O.

export function isUnconvertedSellerCandidate(
  c: { home_value_estimate: number | null; contact_type: string | null; motivation_type: string | null },
  representedContactIds: { has(id: string): boolean },
  contactId: string,
): boolean {
  if (representedContactIds.has(contactId)) return false
  return (
    (typeof c.home_value_estimate === "number" && c.home_value_estimate > 0) ||
    c.contact_type === "seller" ||
    c.motivation_type === "seller"
  )
}
