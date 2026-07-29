// lib/contacts/buyer-stage.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CANONICAL contacts.buyer_stage LADDER.
//
// The column's CHECK is thirteen SCREAMING_SNAKE states, all prefixed BUYER_.
// The buyer-lifecycle UI, the next-step router and the journey simulators all
// use them correctly. Two server-side consumers did not, and both failed the
// same silent way — a filter on a value the column cannot hold returns zero
// rows, which reads as "nobody qualifies" rather than as an error:
//
//   · lib/application/ai-isa.ts — the showing_feedback campaign filtered
//     buyer_stage='toured'. There is no 'toured'; the state is BUYER_TOURING.
//     The AI ISA could never find a single contact to ask for showing feedback.
//
//   · lib/fatigue/fatigue-calculator.ts — calculateAllBuyerFatigue selected
//     contacts with buyer_stage IN (prospect, pre_approval_pending,
//     financially_verified, search_configured, searching, touring,
//     tour_completed, offer_strategy, offer_submitted, buyer_under_contract).
//     TEN values, not one of them admitted. The batch fatigue calculator has
//     never processed a contact.
//
// The second one is also why this module exists rather than a one-line fix:
// that list lived in a local `const`, so the CHECK-vocabulary guard — which
// only reads inline literals — could not see it. A shared, guarded module is
// the only thing that makes a drifted set visible.
//
// ACTIVE is defined as the COMPLEMENT of the inactive states, so a stage added
// to the ladder later is treated as active by default. That is the safe
// direction for a fatigue sweep and a nurture campaign: better to evaluate a
// contact who turns out not to need it than to silently skip one who does.

export const BUYER_STAGES = [
  "BUYER_CONTACT_CREATED",
  "BUYER_FINANCIALLY_VERIFIED",
  "BUYER_SEARCH_CONFIGURED",
  "BUYER_SEARCHING",
  "BUYER_TOUR_ELIGIBLE",
  "BUYER_TOURING",
  "BUYER_OFFER_ELIGIBLE",
  "BUYER_OFFER_SUBMITTED",
  "BUYER_UNDER_CONTRACT",
  "BUYER_ON_HOLD",
  "BUYER_DISENGAGED",
  "BUYER_CLOSED",
  "BUYER_LIFETIME",
] as const

export type BuyerStage = (typeof BUYER_STAGES)[number]

export function isBuyerStage(v: unknown): v is BuyerStage {
  return typeof v === "string" && (BUYER_STAGES as readonly string[]).includes(v)
}

/**
 * Not currently working a purchase. BUYER_CLOSED and BUYER_LIFETIME are past
 * the transaction; BUYER_ON_HOLD and BUYER_DISENGAGED are paused by the buyer.
 * None of them should be counted in an active-buyer sweep.
 */
export const BUYER_INACTIVE_STAGES = [
  "BUYER_ON_HOLD", "BUYER_DISENGAGED", "BUYER_CLOSED", "BUYER_LIFETIME",
] as const satisfies readonly BuyerStage[]

/** Actively working a purchase — the complement of inactive. */
export const BUYER_ACTIVE_STAGES = BUYER_STAGES.filter(
  (s) => !(BUYER_INACTIVE_STAGES as readonly string[]).includes(s),
) as readonly BuyerStage[]

/**
 * The stage a showing-feedback ask targets: the buyer is out seeing homes.
 * Was the literal 'toured', which the column has never admitted.
 */
export const BUYER_SHOWING_FEEDBACK_STAGE = "BUYER_TOURING" as const
