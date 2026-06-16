// lib/kernel/second-opinion.ts
//
// CROSS-MANAGER SECOND OPINION (pure) — the dissent/coordination rails already let managers talk;
// this turns them into genuinely BETTER decisions. Before a high-stakes, strategic play, the owning
// manager asks a SECOND manager — the one with the complementary view — to weigh in, exactly like a
// human team huddles before a tough call. A re-list pitch or a price-drop nudge should get the
// Shopping Agent's read on live BUYER demand; an offer move should get the Deal Coordinator's eye.
// Routine touches skip it (no committee for a check-in email). Pure (no I/O), unit-tested directly.

import type { ManagerKey } from "./manager-registry"

// play type → the manager whose complementary view sharpens the call. Only STRATEGIC plays are
// listed; anything not here is routine and needs no second opinion.
const CONSULT_FOR_PLAY: Record<string, ManagerKey> = {
  relist_recovery:        "shopping_agent",   // does live buyer demand support re-listing at this price?
  price_drop:             "shopping_agent",   // will a cut actually move buyers, or just leave money on the table?
  listing_launch:         "shopping_agent",   // pre-launch read on buyer appetite
  offer_strategy:         "deal_coordinator", // does this offer move hold up through the deal mechanics?
  offer_rejection_recovery:"deal_coordinator",
  sphere_referral_ask:    "sphere_of_influence", // is the relationship warm enough to ask?
  commission_video:       "asset_manager",    // is the brand asset the right one for this moment?
}

export interface SecondOpinion {
  needed: boolean
  consult: ManagerKey | null
  reason: string
}

/** Decide whether a play warrants a second manager's read, and who. Pure. */
export function secondOpinionFor(playType: string | null | undefined): SecondOpinion {
  const consult = CONSULT_FOR_PLAY[(playType ?? "").trim()]
  if (!consult) return { needed: false, consult: null, reason: "routine play — no second opinion needed" }
  return { needed: true, consult, reason: `${playType} is strategic — get ${consult}'s complementary read before acting` }
}

/** The full set of plays that trigger a huddle (for tests / docs). */
export const SECOND_OPINION_PLAYS = Object.keys(CONSULT_FOR_PLAY)
