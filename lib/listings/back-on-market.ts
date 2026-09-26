// lib/listings/back-on-market.ts
// ─────────────────────────────────────────────────────────────────────────────
// BACK ON MARKET — a deal fell through and the listing returned to active. This is the single
// highest-intent RE-MARKETING moment, and it was a gap: the normal go-live marketing is idempotent
// per (listing, just_listed), so a re-list silently fires NOTHING — and the buyers who SAVED the home
// (real intent) are never told it's available again. PURE predicate: detect a contract-stage → active
// transition (not the first go-live). The reactor uses it to hand off to the Shopping Agent, which
// re-engages the savers with a personal "back on market" nudge (avatar reel → Campaign sends).
//
// OWNER RULING 2026-09-09, verbatim: "lifetime transition should not send back on the market to the
// shopping manager, should be closed and sent to sphere. the back on the market is only when the
// listing doesnt close." A CLOSED (or any future triggersLifetimeTransition) listing must NEVER be
// able to satisfy this predicate — not because CLOSED happens to be absent from a hand-typed list
// below, but BY CONSTRUCTION: both candidate sets are typed against the canonical ListingStage union
// (a retired/renamed stage fails to compile instead of silently dropping out, unlike the bare
// "ACTIVE" literal this file used to carry — not a member of ListingStage at all, so it could never
// match a real toStage a stage-machine writer emits) and then FILTERED against LISTING_STAGES_AFTER —
// the terminal-stage partition lib/enrichment/deal-vocabulary.ts already owns (deal-over: closed,
// lifetime, cancelled, expired, declined) — so a terminal stage can never land in either set, no
// matter what gets typed into the candidate list below. One vocabulary for "this stage means the deal
// is over," not a second one invented here (§6). scripts/back-on-market-promo-simulator.ts asserts
// this as a derived property over EVERY triggersLifetimeTransition stage, not a hand-checked "CLOSED".

import { type ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"
import { LISTING_STAGES_AFTER } from "@/lib/enrichment/deal-vocabulary"

/** The deal-over partition, as a lookup. Owned by deal-vocabulary.ts — not re-derived here. */
const TERMINAL_STAGES = new Set<string>(LISTING_STAGES_AFTER)

/** Lifecycle stages that mean the listing is actively ON MARKET (showable, takes offers).
 *  Typed against ListingStage, then filtered so a terminal (deal-over) stage can never survive
 *  into the runtime set — see the header above. */
const ON_MARKET_CANDIDATES: ListingStage[] = ["MLS_ACTIVE", "SHOWINGS_ACTIVE", "MLS_READY", "OPEN_HOUSE_EVENT"]
const ON_MARKET = new Set<string>(ON_MARKET_CANDIDATES.filter((s) => !TERMINAL_STAGES.has(s)))

/** Lifecycle stages that mean the listing WAS under contract / mid-deal (so returning = fell
 *  through). Same typed + terminal-filtered construction, for the same reason: a stage the deal is
 *  already OVER at can never be read as "fell through and came back". */
const WAS_UNDER_CONTRACT_CANDIDATES: ListingStage[] = [
  "OFFERS_RECEIVED", "NEGOTIATION", "UNDER_CONTRACT", "INSPECTION", "APPRAISAL", "FINANCING", "CLOSING_PREP",
]
const WAS_UNDER_CONTRACT = new Set<string>(WAS_UNDER_CONTRACT_CANDIDATES.filter((s) => !TERMINAL_STAGES.has(s)))

/**
 * PURE. True when a listing transitions FROM a contract/mid-deal stage BACK to an on-market stage —
 * i.e., the deal fell through and it's back on market. The FIRST go-live (coming-soon → active) is
 * NOT back-on-market (from-stage isn't a contract stage), so this never mis-fires on a normal launch.
 */
export function isBackOnMarket(fromStage: string | null | undefined, toStage: string | null | undefined): boolean {
  if (!fromStage || !toStage) return false
  return ON_MARKET.has(toStage.toUpperCase()) && WAS_UNDER_CONTRACT.has(fromStage.toUpperCase())
}
