"use server"

import { addPoints } from "@/app/actions/gamification"
import { POINT_VALUES } from "@/app/actions/gamification"

// Maps spec action keys to the real POINT_VALUES enum keys.
// addPoints internally calls checkAndAwardBadges, so badges auto-award
// by points threshold — no separate awardBadge call is needed.
const ACTION_MAP: Record<string, keyof typeof POINT_VALUES> = {
  showing_completed:  "ONBOARDING_STEP_COMPLETED", // 10 pts — closest available key
  offer_submitted:    "OFFER_SUBMITTED",            // 50 pts
  deal_closed:        "LISTING_CLOSED",             // 100 pts
  referral_received:  "REFERRAL_CREATED",           // 75 pts
  review_received:    "VENDOR_REVIEW_WRITTEN",      // 25 pts
  followup_completed: "ONBOARDING_STEP_COMPLETED",  // 10 pts
  social_posted:      "ONBOARDING_STEP_COMPLETED",  // 10 pts — no dedicated key
  training_completed: "ONBOARDING_STEP_COMPLETED",  // 10 pts
  open_house_hosted:  "ONBOARDING_STEP_COMPLETED",  // 10 pts
} as const

/**
 * Fire-and-forget gamification hook.
 * Call with .catch(()=>{}) — never awaited on the hot path.
 *
 * @param agentId  The agents.id UUID of the acting agent
 * @param actionKey  One of the action keys defined above
 */
export async function awardPointsForAction(
  agentId: string,
  actionKey: keyof typeof ACTION_MAP,
): Promise<void> {
  if (!agentId) return
  const pointType = ACTION_MAP[actionKey]
  if (!pointType) return
  await addPoints(agentId, pointType)
}
