// lib/goals/goal-types.ts
//
// ONE vocabulary for agent_goals.goal_type, so the picker, the validator and the
// live-value sync cannot drift apart again.
//
// They had drifted badly: the shipped goals page offered `transactions`, `gci`,
// `referrals_generated` and `reviews_requested`, none of which
// agent_goals_goal_type_check admitted, so FOUR OF SIX buttons on that page
// wrote a row the database refused with SQLSTATE 23514. Two were spelling drift
// against concepts the constraint already had under different names; two were
// capability the constraint simply lacked, which m373 added rather than
// deleting the buttons.
//
// The rule this file exists to enforce: a goal type is written down ONCE. The
// UI labels are derived from it, the server validates against it, and the sync
// keys its computed values with it. A future divergence becomes a type error
// instead of a silent refusal.

/** Exactly the members of agent_goals_goal_type_check after m373. */
export const AGENT_GOAL_TYPES = [
  "gross_commission",
  "transactions_closed",
  "listings_taken",
  "buyer_clients",
  "new_contacts",
  "conversion_rate",
  "avg_days_to_close",
  "referrals_generated",
  "reviews_requested",
] as const

export type AgentGoalType = (typeof AGENT_GOAL_TYPES)[number]

export function isAgentGoalType(value: unknown): value is AgentGoalType {
  return typeof value === "string" && (AGENT_GOAL_TYPES as readonly string[]).includes(value)
}

/** Human labels for every admitted type — one entry per member, enforced by the Record type. */
export const AGENT_GOAL_LABELS: Record<AgentGoalType, string> = {
  gross_commission:    "Gross Commission Income ($)",
  transactions_closed: "Closed Transactions",
  listings_taken:      "Listings Taken",
  buyer_clients:       "Buyer Clients Signed",
  new_contacts:        "New Contacts Added",
  conversion_rate:     "Lead Conversion Rate (%)",
  avg_days_to_close:   "Average Days to Close",
  referrals_generated: "Referrals Generated",
  reviews_requested:   "Reviews Requested",
}

/**
 * The subset syncGoalCurrentValues can measure from real tables today. A type
 * NOT listed here is still a legitimate target — the agent just has to update
 * its progress by hand, and the UI should say so rather than showing a stalled
 * zero as though the sync had run and found nothing.
 */
export const AUTO_SYNCED_GOAL_TYPES: readonly AgentGoalType[] = [
  "transactions_closed",
  "gross_commission",
  "listings_taken",
  "referrals_generated",
  "reviews_requested",
]

export function isAutoSynced(goalType: AgentGoalType): boolean {
  return AUTO_SYNCED_GOAL_TYPES.includes(goalType)
}
