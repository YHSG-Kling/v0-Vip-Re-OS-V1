// lib/listings/back-on-market.ts
// ─────────────────────────────────────────────────────────────────────────────
// BACK ON MARKET — a deal fell through and the listing returned to active. This is the single
// highest-intent RE-MARKETING moment, and it was a gap: the normal go-live marketing is idempotent
// per (listing, just_listed), so a re-list silently fires NOTHING — and the buyers who SAVED the home
// (real intent) are never told it's available again. PURE predicate: detect a contract-stage → active
// transition (not the first go-live). The reactor uses it to hand off to the Shopping Agent, which
// re-engages the savers with a personal "back on market" nudge (avatar reel → Campaign sends).

/** Lifecycle stages that mean the listing is actively ON MARKET (showable, takes offers). */
const ON_MARKET = new Set(["ACTIVE", "MLS_ACTIVE", "SHOWINGS_ACTIVE", "MLS_READY", "OPEN_HOUSE_EVENT"])

/** Lifecycle stages that mean the listing WAS under contract / mid-deal (so returning = fell through). */
const WAS_UNDER_CONTRACT = new Set([
  "OFFERS_RECEIVED", "NEGOTIATION", "UNDER_CONTRACT", "INSPECTION", "APPRAISAL", "FINANCING", "CLOSING_PREP",
])

/**
 * PURE. True when a listing transitions FROM a contract/mid-deal stage BACK to an on-market stage —
 * i.e., the deal fell through and it's back on market. The FIRST go-live (coming-soon → active) is
 * NOT back-on-market (from-stage isn't a contract stage), so this never mis-fires on a normal launch.
 */
export function isBackOnMarket(fromStage: string | null | undefined, toStage: string | null | undefined): boolean {
  if (!fromStage || !toStage) return false
  return ON_MARKET.has(toStage.toUpperCase()) && WAS_UNDER_CONTRACT.has(fromStage.toUpperCase())
}
